/**
 * `beaver-extract items` — task-generic training export for item models.
 *
 *   items export --task item-type --pdf-list docs.jsonl --out dir/ [--limit N] [--shard i/n]
 *       [--schema v]
 *     Full-document structured extraction per PDF; one row per document
 *     (`pipeline/itemsExport.ts`): per page the model's units with their
 *     feature rows, the structured items with their ids, boxes, columns, text,
 *     lines and units, and the lines the margin filter removed. Rows go to
 *     `<dir>/docs/<doc_id>.json.gz`, the export's settings to
 *     `<dir>/manifest.json`. Resumable: documents recorded in
 *     `<dir>/ledger[-<i>of<n>].jsonl` are skipped. A directory is only resumed
 *     with the settings, feature set and commit its manifest records.
 *
 *   items export --task regions-v2 ... [--page-list pages.jsonl]
 *     The region model's export (`pipeline/regionsExport.ts`, format
 *     `beaver-regions-v1`): per page the region pass's text pieces and drawing
 *     primitives and what the shipped detector did with them. With
 *     `--page-list` (JSONL rows with `doc_id` and `page_index`) only the listed
 *     documents run, and only the listed pages are written.
 *
 * List rows are JSONL with `doc_id` and `pdf_path`.
 */
import { appendFile, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Command } from "commander";

import type { CliDeps } from "../runCliTypes";
import {
    checkSchemaOption,
    dropTornLine,
    parseShard,
    pendingDocuments,
    readJsonl,
    recoverRuntime,
    requireFiles,
    sourceCommit,
} from "../batch";
import { ITEMS_EXPORT_FORMAT, ITEMS_EXPORT_TASKS } from "../../pipeline/itemsExport";
import { REGIONS_EXPORT_TASK, regionsExportManifest } from "../../pipeline/regionsExport";
import { CURRENT_PDF_EXTRACTION_PRESET } from "../../schema";
import { pdfExtractionPreset } from "../../schema/presets";

interface ExportOptions {
    task: string;
    pdfList: string;
    pageList?: string;
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
    // Keys of either side: an optional setting recorded by one run and
    // omitted by the other is a difference too.
    for (const key of new Set([...Object.keys(existing), ...Object.keys(manifest)])) {
        const was = JSON.stringify(existing[key]);
        const now = JSON.stringify(manifest[key]);
        if (was !== now) {
            throw new Error(`${path} records ${key} ${was}, this run ${now}; export to a new --out directory`);
        }
    }
}

/**
 * Pages of a `--page-list` by document. Its digest (of the sorted pairs)
 * identifies the selection in the manifest.
 */
async function readPageList(path: string): Promise<{ pages: Map<string, number[]>; sha256: string }> {
    const pages = new Map<string, number[]>();
    for (const row of await readJsonl<{ doc_id?: unknown; page_index?: unknown }>(path)) {
        const index = Number(row.page_index);
        if (typeof row.doc_id !== "string" || !Number.isInteger(index) || index < 0) {
            throw new Error(`${path}: rows need doc_id and a page_index (got ${JSON.stringify(row)})`);
        }
        const list = pages.get(row.doc_id) ?? [];
        if (!list.includes(index)) list.push(index);
        pages.set(row.doc_id, list);
    }
    const pairs = [...pages].flatMap(([doc, list]) => list.map((i) => `${doc}\t${i}`)).sort();
    return { pages, sha256: createHash("sha256").update(pairs.join("\n")).digest("hex") };
}

async function runExport(deps: CliDeps, opts: ExportOptions): Promise<void> {
    const regions = opts.task === REGIONS_EXPORT_TASK;
    const task = ITEMS_EXPORT_TASKS[opts.task];
    if (!task && !regions) {
        throw new Error(`unknown task "${opts.task}" (known: ${[...Object.keys(ITEMS_EXPORT_TASKS), REGIONS_EXPORT_TASK].join(", ")})`);
    }
    if (opts.pageList && !regions) throw new Error(`--page-list is only for --task ${REGIONS_EXPORT_TASK}`);
    checkSchemaOption(opts.schema);
    const bboxPrecision = Number(opts.bboxPrecision);
    if (!Number.isInteger(bboxPrecision) || bboxPrecision < 0) throw new Error(`invalid --bbox-precision ${opts.bboxPrecision}`);
    const shard = parseShard(opts.shard);
    requireFiles([opts.pdfList, ...(opts.pageList ? [opts.pageList] : [])]);
    const { commit, dirty } = sourceCommit();
    const schemaVersion = opts.schema ?? CURRENT_PDF_EXTRACTION_PRESET.schemaVersion;
    if (regions && !pdfExtractionPreset(schemaVersion)?.regions) {
        throw new Error(`--task ${REGIONS_EXPORT_TASK} needs a schema with region detection (got ${schemaVersion})`);
    }
    const pageList = opts.pageList ? await readPageList(opts.pageList) : undefined;
    await mkdir(join(opts.out, "docs"), { recursive: true });
    await claimManifest(
        join(opts.out, "manifest.json"),
        task
            ? {
                format: ITEMS_EXPORT_FORMAT,
                task: opts.task,
                feature_set: task.featureSet,
                feature_version: task.featureVersion,
                names: task.features,
                schema_version: schemaVersion,
                bbox_precision: bboxPrecision,
                commit,
                dirty,
            }
            : {
                ...regionsExportManifest(),
                task: opts.task,
                schema_version: schemaVersion,
                bbox_precision: bboxPrecision,
                page_list_sha256: pageList?.sha256 ?? null,
                commit,
                dirty,
            },
    );
    // Shards run as separate processes; each keeps its own ledger.
    const ledgerPath = join(opts.out, shard.count > 1 ? `ledger-${shard.index}of${shard.count}.jsonl` : "ledger.jsonl");
    await dropTornLine(ledgerPath);
    const todo = (await pendingDocuments(opts.pdfList, ledgerPath, shard)).filter((row) => !pageList || pageList.pages.has(row.doc_id));
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
        let result: Awaited<ReturnType<CliDeps["api"]["itemsExport"] | CliDeps["api"]["regionsExport"]>>;
        const pages = pageList?.pages.get(row.doc_id);
        try {
            const pdfData = await deps.loadPdf(row.pdf_path);
            result = regions
                ? await deps.api.regionsExport({ pdfData, bboxPrecision, schemaVersion, ...(pages ? { pages } : {}) })
                : await deps.api.itemsExport({ pdfData, task: opts.task, bboxPrecision, schemaVersion });
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
        // Listed pages the document does not have (or did not extract) are reported, not failed.
        const written = pages ? new Set(result.pages.map((page) => page.index)) : undefined;
        const missing = pages?.filter((i) => !written!.has(i)) ?? [];
        await appendLedger({ doc_id: row.doc_id, status: "done", ms, ...(missing.length ? { missing_pages: missing } : {}) });
    }
    deps.stdout.write(`processed ${done} of ${todo.length} remaining documents\n`);
}

export function buildItemsCommand(deps: CliDeps): Command {
    const cmd = new Command("items").description("Training exports for item models.");
    cmd.command("export")
        .description("Export items, lines and a task's feature rows for a list of PDFs (resumable).")
        .requiredOption("--task <task>", `model task (${[...Object.keys(ITEMS_EXPORT_TASKS), REGIONS_EXPORT_TASK].join(", ")})`)
        .requiredOption("--pdf-list <jsonl>", "JSONL rows with doc_id and pdf_path")
        .option("--page-list <jsonl>", `${REGIONS_EXPORT_TASK}: JSONL rows with doc_id and page_index; only these documents run, only these pages are written`)
        .requiredOption("--out <dir>", "output directory")
        .option("--limit <n>", "process at most n documents, then exit")
        .option("--shard <i/n>", "process only documents hashed to shard i of n")
        .option("--schema <version>", "PDF schema version (extraction preset)")
        .option("--bbox-precision <n>", "decimal places of boxes, as in the structured export", "2")
        .action((opts: ExportOptions) => runExport(deps, opts));
    return cmd;
}
