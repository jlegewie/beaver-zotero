/**
 * `beaver-extract references` — reference-classifier tooling.
 *
 *   references export --pdf-list docs.jsonl --out inputs.jsonl [--limit N] [--shard i/n]
 *     Full-document structured extraction per PDF; one JSON line per document
 *     with every page's classifier input and the items' public-frame boxes.
 *     Resumable: documents already recorded in `<out>.ledger.jsonl` are skipped.
 *   references featurize --in inputs.jsonl [--in more.jsonl] --out features.jsonl
 *     Item and context features for every item of every exported document:
 *     one JSON array per line, `[doc_id, page_index, item_index, ...features]`.
 *     Feature names go to `<out>.meta.json`.
 *   references plan --in inputs.jsonl [--in more.jsonl] --out plans.jsonl
 *     Run the shipped classifier on exported inputs (evaluation): one line per
 *     document with each page's plan.
 *   references classify paper.pdf [--pages 3,4] [--json]
 *     Classify one PDF; prints each item's reference probability and the
 *     emitted reference items.
 *   references render --page-list pages.jsonl --out-dir dir [--scale 1.5]
 *     Render pages to `<doc_id>__p<page>.png` (same frame as the item boxes).
 *
 * List rows are JSONL with `doc_id`, `pdf_path` and, for `render`, `page_index`.
 */
import { createReadStream, createWriteStream, existsSync, type WriteStream } from "node:fs";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { appendFile, mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
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
    type ListRow,
} from "../batch";
import type { ReferenceInputPage } from "../../worker/ops";
import { CONTEXT_FEATURES, FEATURE_VERSION, ITEM_FEATURES } from "../../references/features";
import { stage1Features } from "../../references/model";
import { planReferences } from "../../references/classify";
import { LINE_FEATURES, LINE_FEATURE_VERSION, pageLineFeatures } from "../../references/lines";


/**
 * An output file whose stream errors (unopenable path, failed write) reject
 * the command's promise instead of escaping as an unhandled `error` event.
 */
class OutputFile {
    private readonly stream: WriteStream;
    private error: Error | null = null;

    constructor(path: string) {
        this.stream = createWriteStream(path);
        this.stream.on("error", (e) => {
            this.error ??= e;
        });
    }

    async write(text: string): Promise<void> {
        this.throwIfFailed();
        // `once` rejects if the stream errors while we wait for it to drain.
        if (!this.stream.write(text)) await once(this.stream, "drain");
        this.throwIfFailed();
    }

    async close(): Promise<void> {
        this.throwIfFailed();
        this.stream.end();
        await finished(this.stream);
        this.throwIfFailed();
    }

    /** Release the file after a failure; never throws. */
    destroy(): void {
        this.stream.destroy();
    }

    private throwIfFailed(): void {
        if (this.error) throw this.error;
    }
}

interface ExportDocument {
    doc_id: string;
    pageCount: number;
    pages: ReferenceInputPage[];
}

/** `doc_id` of an export row; `export` writes it as the first key. */
function exportRowDocId(line: string): string {
    const m = /^\{"doc_id":("(?:[^"\\]|\\.)*")/.exec(line);
    return m ? (JSON.parse(m[1]) as string) : (JSON.parse(line) as ExportDocument).doc_id;
}

/**
 * Documents of `references export` files, in file order, keeping only the
 * last row per document: a resumed export re-appends a document whose row was
 * written but whose ledger entry was lost, and the retry must not count twice.
 */
async function* exportDocuments(paths: readonly string[]): AsyncGenerator<ExportDocument> {
    const lastRow = new Map<string, string>();
    for (const [f, path] of paths.entries()) {
        let n = 0;
        const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
        for await (const line of rl) {
            if (line.trim()) lastRow.set(exportRowDocId(line), `${f}:${n}`);
            n++;
        }
    }
    for (const [f, path] of paths.entries()) {
        let n = 0;
        const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
        for await (const line of rl) {
            const at = `${f}:${n++}`;
            if (!line.trim()) continue;
            const doc = JSON.parse(line) as ExportDocument;
            if (lastRow.get(doc.doc_id) === at) yield doc;
        }
    }
}

async function runExport(
    deps: CliDeps,
    opts: { pdfList: string; out: string; limit?: string; shard?: string; schema?: string },
): Promise<void> {
    const shard = parseShard(opts.shard);
    const ledgerPath = `${opts.out}.ledger.jsonl`;
    checkSchemaOption(opts.schema);
    requireFiles([opts.pdfList]);
    // An interrupted append can leave a partial last row in either file. In
    // the ledger, dropping it loses at most one start (one attempt fewer
    // counted) or one outcome (the document is exported again).
    await dropTornLine(ledgerPath);
    await dropTornLine(opts.out);
    const todo = await pendingDocuments(opts.pdfList, ledgerPath, shard);
    const appendLedger = (row: object) => appendFile(ledgerPath, JSON.stringify(row) + "\n");
    const limit = opts.limit ? Number(opts.limit) : Infinity;
    let done = 0;
    for (const row of todo) {
        if (done >= limit) break;
        done++;
        await appendLedger({ doc_id: row.doc_id, status: "start" });
        const t0 = performance.now();
        // Only loading and extracting the PDF can fail the document. Output
        // and ledger I/O errors are ours: they stop the run and leave the
        // document to be retried.
        let result: Awaited<ReturnType<CliDeps["api"]["referenceInputs"]>>;
        try {
            const pdfData = await deps.loadPdf(row.pdf_path);
            result = await deps.api.referenceInputs({
                pdfData,
                ...(opts.schema ? { schemaVersion: opts.schema } : {}),
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
        try {
            await appendFile(opts.out, JSON.stringify({ doc_id: row.doc_id, ms, ...result }) + "\n");
        } catch (e) {
            // Best effort: the run is failing either way.
            await appendLedger({ doc_id: row.doc_id, status: "output_error" }).catch(() => undefined);
            throw e;
        }
        await appendLedger({ doc_id: row.doc_id, status: "done", ms });
    }
    deps.stdout.write(`processed ${done} of ${todo.length} remaining documents\n`);
}

/** The fixed final chunk of every PNG: zero-length IEND with its CRC. */
const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/**
 * Whether `path` holds a fully written PNG. A render interrupted mid-write
 * leaves a file without the closing IEND chunk; it is rendered again.
 */
async function isCompletePng(path: string): Promise<boolean> {
    if (!existsSync(path)) return false;
    const handle = await open(path, "r");
    try {
        const { size } = await handle.stat();
        if (size < 8 + PNG_IEND.length) return false;
        const tail = Buffer.alloc(PNG_IEND.length);
        await handle.read(tail, 0, tail.length, size - tail.length);
        return tail.equals(PNG_IEND);
    } finally {
        await handle.close();
    }
}

async function runRender(
    deps: CliDeps,
    opts: { pageList: string; outDir: string; scale: string },
): Promise<void> {
    requireFiles([opts.pageList]);
    await mkdir(opts.outDir, { recursive: true });
    const byDoc = new Map<string, { path: string; pages: number[] }>();
    for (const row of await readJsonl<ListRow>(opts.pageList)) {
        if (row.page_index === undefined) continue;
        if (await isCompletePng(join(opts.outDir, `${row.doc_id}__p${row.page_index}.png`))) continue;
        const entry = byDoc.get(row.doc_id) ?? { path: row.pdf_path, pages: [] };
        entry.pages.push(row.page_index);
        byDoc.set(row.doc_id, entry);
    }
    let rendered = 0;
    for (const [docId, { path, pages }] of byDoc) {
        try {
            const pdfData = await deps.loadPdf(path);
            const result = await deps.api.renderPages({
                pdfData,
                pageIndices: pages,
                options: { scale: Number(opts.scale), format: "png" },
            });
            for (const page of result.pages) {
                await deps.writePngFile(join(opts.outDir, `${docId}__p${page.pageIndex}.png`), page.data);
                rendered++;
            }
        } catch (e) {
            recoverRuntime(deps, e);
            deps.stderr.write(`render failed for ${docId}: ${e instanceof Error ? e.message : String(e)}\n`);
        }
    }
    deps.stdout.write(`rendered ${rendered} pages\n`);
}

async function runFeaturize(
    deps: CliDeps,
    opts: { in: string[]; out: string; lineItems?: string },
): Promise<void> {
    requireFiles([...opts.in, ...(opts.lineItems ? [opts.lineItems] : [])]);
    // Items whose line features to write: "doc_id:page:item" keys.
    const lineKeys = new Set<string>();
    if (opts.lineItems) {
        for (const row of await readJsonl<[string, number, number]>(opts.lineItems)) {
            lineKeys.add(`${row[0]}:${row[1]}:${row[2]}`);
        }
    }
    const linesOut = opts.lineItems ? new OutputFile(`${opts.out}.lines.jsonl`) : null;
    const out = new OutputFile(opts.out);
    let docs = 0;
    let rows = 0;
    try {
        await writeFile(
            `${opts.out}.meta.json`,
            JSON.stringify({
                featureVersion: FEATURE_VERSION,
                columns: ["doc_id", "page_index", "item_index", ...ITEM_FEATURES, ...CONTEXT_FEATURES],
                lineFeatureVersion: LINE_FEATURE_VERSION,
                lineColumns: ["doc_id", "page_index", "item_index", "line_index", ...LINE_FEATURES],
            }, null, 2) + "\n",
        );
        for await (const doc of exportDocuments(opts.in)) {
            const inputs = doc.pages.map((p) => p.input);
            const features = stage1Features(inputs, doc.pageCount);
            const chunk: string[] = [];
            let k = 0;
            for (const page of inputs) {
                page.items.forEach((_, i) => {
                    chunk.push(JSON.stringify([doc.doc_id, page.pageIndex, i, ...features[k++]]));
                    rows++;
                });
            }
            if (chunk.length > 0) await out.write(chunk.join("\n") + "\n");
            if (linesOut && lineKeys.size > 0) {
                const lineChunk: string[] = [];
                for (const page of inputs) {
                    const prefix = `${doc.doc_id}:${page.pageIndex}:`;
                    const pageRows = pageLineFeatures(page, (i) => lineKeys.has(prefix + i));
                    for (const [i, lines] of pageRows) {
                        lines.forEach((values, k) =>
                            lineChunk.push(JSON.stringify([doc.doc_id, page.pageIndex, i, k, ...values])),
                        );
                    }
                }
                if (lineChunk.length > 0) await linesOut.write(lineChunk.join("\n") + "\n");
            }
            docs++;
        }
        await out.close();
        await linesOut?.close();
    } catch (e) {
        out.destroy();
        linesOut?.destroy();
        throw e;
    }
    deps.stdout.write(`featurized ${docs} documents, ${rows} items\n`);
}

async function runPlan(deps: CliDeps, opts: { in: string[]; out: string }): Promise<void> {
    requireFiles(opts.in);
    const out = new OutputFile(opts.out);
    let docs = 0;
    try {
        for await (const doc of exportDocuments(opts.in)) {
            const inputs = doc.pages.map((p) => p.input);
            const plans = planReferences(inputs, doc.pageCount);
            const row = {
                doc_id: doc.doc_id,
                pages: plans.map((plan, k) => ({ pageIndex: inputs[k].pageIndex, ...plan })),
            };
            await out.write(JSON.stringify(row) + "\n");
            docs++;
        }
        await out.close();
    } catch (e) {
        out.destroy();
        throw e;
    }
    deps.stdout.write(`planned ${docs} documents\n`);
}

async function runClassify(
    deps: CliDeps,
    pdfPath: string,
    opts: { pages?: string; json?: boolean; schema?: string },
): Promise<void> {
    const pdfData = await deps.loadPdf(pdfPath);
    const result = await deps.api.referenceInputs({
        pdfData,
        classify: true,
        ...(opts.schema ? { schemaVersion: opts.schema } : {}),
    });
    const wanted = opts.pages ? new Set(opts.pages.split(",").map(Number)) : null;
    const pages = result.pages.filter((p) => !wanted || wanted.has(p.input.pageIndex));
    if (opts.json) {
        deps.stdout.write(JSON.stringify(pages.map((p) => ({
            pageIndex: p.input.pageIndex,
            items: p.input.items.map((item, i) => ({
                text: item.text,
                prob: p.plan?.probs[i],
                reference: p.plan?.reference[i],
                splits: p.plan?.splits[i],
                mergeWithPrevious: p.plan?.mergeWithPrevious[i],
            })),
            emitted: p.items,
        }))) + "\n");
        return;
    }
    for (const page of pages) {
        deps.stdout.write(`--- page ${page.input.pageIndex}\n`);
        page.input.items.forEach((item, i) => {
            const prob = page.plan?.probs[i] ?? 0;
            const mark = page.plan?.reference[i] ? "R" : " ";
            const extra = [
                page.plan?.splits[i]?.length ? `split@${page.plan.splits[i].join(",")}` : "",
                page.plan?.mergeWithPrevious[i] ? "merge" : "",
            ].filter(Boolean).join(" ");
            deps.stdout.write(`${mark} ${prob.toFixed(3)} [${i}] ${item.text.slice(0, 100)}${extra ? `  (${extra})` : ""}\n`);
        });
    }
}

export function buildReferencesCommand(deps: CliDeps): Command {
    const cmd = new Command("references").description("Reference-classifier export and debugging.");
    cmd.command("export")
        .description("Export per-page classifier inputs for a list of PDFs (resumable).")
        .requiredOption("--pdf-list <jsonl>", "JSONL rows with doc_id and pdf_path")
        .requiredOption("--out <jsonl>", "output file (appended)")
        .option("--limit <n>", "process at most n documents, then exit")
        .option("--shard <i/n>", "process only documents hashed to shard i of n")
        .option("--schema <version>", "PDF schema version (extraction preset)")
        .action((opts) => runExport(deps, opts));
    cmd.command("featurize")
        .description("Compute classifier features from exported inputs.")
        .requiredOption("--in <jsonl...>", "export files from `references export`")
        .requiredOption("--out <jsonl>", "output file (overwritten)")
        .option("--line-items <jsonl>", "also write line features of these items ([doc_id, page, item] rows) to <out>.lines.jsonl")
        .action((opts) => runFeaturize(deps, opts));
    cmd.command("plan")
        .description("Run the classifier on exported inputs.")
        .requiredOption("--in <jsonl...>", "export files from `references export`")
        .requiredOption("--out <jsonl>", "output file (overwritten)")
        .action((opts) => runPlan(deps, opts));
    cmd.command("classify")
        .description("Classify the items of one PDF and print reference probabilities.")
        .argument("<pdf>", "path to the PDF")
        .option("--pages <list>", "comma-separated 0-based pages to print")
        .option("--json", "print JSON")
        .option("--schema <version>", "PDF schema version (extraction preset)")
        .action((pdf, opts) => runClassify(deps, pdf, opts));
    cmd.command("render")
        .description("Render listed pages to PNG.")
        .requiredOption("--page-list <jsonl>", "JSONL rows with doc_id, pdf_path and page_index")
        .requiredOption("--out-dir <dir>", "output directory")
        .option("--scale <s>", "render scale (1 = 72 dpi)", "1.5")
        .action((opts) => runRender(deps, opts));
    return cmd;
}
