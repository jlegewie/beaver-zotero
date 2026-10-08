/**
 * `beaver-extract items` — task-generic training export for item models.
 *
 *   items export --task item-type --pdf-list docs.jsonl --out dir/ [--limit N] [--shard i/n]
 *     Full-document structured extraction per PDF; one row per document
 *     (`pipeline/itemsExport.ts`): per page the model's units with their
 *     feature rows, the structured items with their ids, boxes, columns, text,
 *     lines and units, and the lines the margin filter removed. Rows go to
 *     `<dir>/docs/<doc_id>.json.gz`, the export's settings to
 *     `<dir>/manifest.json`. Resumable: documents recorded in
 *     `<dir>/ledger[-<i>of<n>].jsonl` are skipped. A directory is only resumed
 *     with the settings, feature set and commit its manifest records.
 *
 * List rows are JSONL with `doc_id` and `pdf_path`.
 */
import { appendFile, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Command } from "commander";

import type { CliDeps } from "../runCliTypes";
import {
    checkSchemaOption,
    dropTornLine,
    parseShard,
    pendingDocuments,
    recoverRuntime,
    requireFiles,
    sourceCommit,
} from "../batch";
import { ITEMS_EXPORT_FORMAT, ITEMS_EXPORT_TASKS } from "../../pipeline/itemsExport";
import { CURRENT_PDF_EXTRACTION_PRESET } from "../../schema";

interface ExportOptions {
    task: string;
    pdfList: string;
    out: string;
    limit?: string;
    shard?: string;
    schema?: string;
    bboxPrecision: string;
}

/** Everything that must be the same for every document of one export directory. */
type Manifest = Record<string, unknown>;

/**
 * Write the manifest of a new export, or check that an existing one records
 * the same settings: resuming with others would mix rows of two exports
 * under one manifest. The manifest is published atomically and never
 * overwritten (a hard link fails when the name exists), so of shards starting
 * together on a new directory one claims it and the others are checked
 * against that claim.
 */
async function claimManifest(path: string, manifest: Manifest): Promise<void> {
    // Unique per claim, also between claims in one process.
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n");
    try {
        await link(tmp, path);
        return;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
        await unlink(tmp).catch(() => undefined);
    }
    const existing = JSON.parse(await readFile(path, "utf8")) as Manifest;
    for (const key of Object.keys(manifest)) {
        const was = JSON.stringify(existing[key]);
        const now = JSON.stringify(manifest[key]);
        if (was !== now) {
            throw new Error(`${path} records ${key} ${was}, this run ${now}; export to a new --out directory`);
        }
    }
}

async function runExport(deps: CliDeps, opts: ExportOptions): Promise<void> {
    const task = ITEMS_EXPORT_TASKS[opts.task];
    if (!task) {
        throw new Error(`unknown task "${opts.task}" (known: ${Object.keys(ITEMS_EXPORT_TASKS).join(", ")})`);
    }
    checkSchemaOption(opts.schema);
    const bboxPrecision = Number(opts.bboxPrecision);
    if (!Number.isInteger(bboxPrecision) || bboxPrecision < 0) throw new Error(`invalid --bbox-precision ${opts.bboxPrecision}`);
    const shard = parseShard(opts.shard);
    requireFiles([opts.pdfList]);
    const { commit, dirty } = sourceCommit();
    const schemaVersion = opts.schema ?? CURRENT_PDF_EXTRACTION_PRESET.schemaVersion;
    await mkdir(join(opts.out, "docs"), { recursive: true });
    await claimManifest(join(opts.out, "manifest.json"), {
        format: ITEMS_EXPORT_FORMAT,
        task: opts.task,
        feature_set: task.featureSet,
        feature_version: task.featureVersion,
        names: task.features,
        schema_version: schemaVersion,
        bbox_precision: bboxPrecision,
        commit,
        dirty,
    });
    // Shards run as separate processes; each keeps its own ledger.
    const ledgerPath = join(opts.out, shard.count > 1 ? `ledger-${shard.index}of${shard.count}.jsonl` : "ledger.jsonl");
    await dropTornLine(ledgerPath);
    const todo = await pendingDocuments(opts.pdfList, ledgerPath, shard);
    const appendLedger = (row: object) => appendFile(ledgerPath, JSON.stringify(row) + "\n");
    const limit = opts.limit ? Number(opts.limit) : Infinity;
    let done = 0;
    for (const row of todo) {
        if (done >= limit) break;
        done++;
        await appendLedger({ doc_id: row.doc_id, status: "start" });
        const t0 = performance.now();
        // Only loading and extracting the PDF can fail the document; output
        // and ledger I/O errors stop the run and leave it to be retried.
        let result: Awaited<ReturnType<CliDeps["api"]["itemsExport"]>>;
        try {
            const pdfData = await deps.loadPdf(row.pdf_path);
            result = await deps.api.itemsExport({
                pdfData,
                task: opts.task,
                bboxPrecision,
                schemaVersion,
            });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            const fatal = recoverRuntime(deps, e);
            await appendLedger({
                doc_id: row.doc_id,
                status: fatal === "heap" ? "retry" : "failed",
                ...(fatal ? { fatal } : {}),
                error: message.slice(0, 500),
            });
            continue;
        }
        const ms = Math.round(performance.now() - t0);
        const path = join(opts.out, "docs", `${row.doc_id}.json.gz`);
        try {
            // Written whole, then renamed: a resumed run never reads a torn row.
            await writeFile(`${path}.tmp`, gzipSync(JSON.stringify({ doc_id: row.doc_id, commit, dirty, ms, ...result })));
            await rename(`${path}.tmp`, path);
        } catch (e) {
            await appendLedger({ doc_id: row.doc_id, status: "output_error" }).catch(() => undefined);
            throw e;
        }
        await appendLedger({ doc_id: row.doc_id, status: "done", ms });
    }
    deps.stdout.write(`processed ${done} of ${todo.length} remaining documents\n`);
}

export function buildItemsCommand(deps: CliDeps): Command {
    const cmd = new Command("items").description("Training exports for item models.");
    cmd.command("export")
        .description("Export items, lines and a task's feature rows for a list of PDFs (resumable).")
        .requiredOption("--task <task>", `model task (${Object.keys(ITEMS_EXPORT_TASKS).join(", ")})`)
        .requiredOption("--pdf-list <jsonl>", "JSONL rows with doc_id and pdf_path")
        .requiredOption("--out <dir>", "output directory")
        .option("--limit <n>", "process at most n documents, then exit")
        .option("--shard <i/n>", "process only documents hashed to shard i of n")
        .option("--schema <version>", "PDF schema version (extraction preset)")
        .option("--bbox-precision <n>", "decimal places of boxes, as in the structured export", "2")
        .action((opts: ExportOptions) => runExport(deps, opts));
    return cmd;
}
