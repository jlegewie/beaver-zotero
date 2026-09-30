/**
 * `beaver-extract regions` — region detection (pictures, decorations, tables) in
 * detection mode: candidates with features and, when a trained model is
 * available, class probabilities. Extraction output is unaffected.
 *
 * Single PDF:
 *   beaver-extract regions paper.pdf --pages 0,3 [--json] [--overlay-dir out/]
 * Batch (training-data export / evaluation), resumable by page id:
 *   beaver-extract regions --page-list pages.jsonl --root <dir> --out regions.jsonl [--no-classify]
 *
 * A page list is JSONL with `pdf_path` (absolute, or relative to --root), `page_index`
 * and `id` or `page_id`. Batch output has one JSON line per page; the feature names,
 * model provenance and context-page count are written to `<out>.meta.json` before
 * the first page. Resuming requires the sidecar to match the current run, so one
 * output never mixes feature schemas or classifiers.
 */
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Command } from "commander";

import { bboxFromXYWH } from "@beaver/agent-core/extract/types";

import type { OverlayRect } from "../../debug/overlayBuilders";
import {
    regionDetectionMeta,
    type RegionDetectionMeta,
    type RegionDetectionResult,
    type RegionPageResult,
} from "../../worker/regionOps";
import { pdfSha256 } from "../io";
import { parsePagesList } from "../options";
import type { CliDeps } from "../runCliTypes";
import { emitFailure, emitSuccess } from "./_sharedHelpers";

const LABEL_COLORS: Record<string, string> = {
    picture: "#1f6feb",
    decoration: "#bf3989",
    table: "#1a7f37",
    other: "#8b949e",
    unclassified: "#d29922",
};

interface RegionsOptions {
    pages?: string;
    pageList?: string;
    root?: string;
    out?: string;
    contextPages?: string;
    classify?: boolean;
    overlayDir?: string;
    json?: boolean;
    pretty?: boolean;
}

interface BatchMeta extends RegionDetectionMeta {
    contextPages: number;
}

interface PageListRow {
    id: string;
    pdfPath: string;
    pageIndex: number;
}

export function buildRegionsCommand(deps: CliDeps): Command {
    const cmd = new Command("regions");
    cmd.description("Detect picture, decoration and table regions (detection mode; extraction is unaffected).")
        .argument("[pdf]", "path to the PDF file (single-PDF mode)")
        .option("--pages <list>", "comma-separated 0-based pages (single-PDF mode; default: all)")
        .option("--page-list <jsonl>", "batch mode: JSONL rows with pdf_path, page_index and id/page_id")
        .option("--root <dir>", "base directory for relative pdf_path values in --page-list")
        .option("--out <jsonl>", "batch output file (appended; pages already present are skipped)")
        .option("--context-pages <n>", "extra pages scanned for recurring images", "12")
        .option("--no-classify", "skip the classifier (export unclassified candidates)")
        .option("--overlay-dir <dir>", "single-PDF mode: write one overlay PNG per page")
        .option("--json", "emit a structured JSON envelope")
        .option("--pretty", "pretty-print JSON output (only with --json)")
        .action(async (pdfPath: string | undefined, opts: RegionsOptions) => {
            if (opts.pageList) {
                await runBatch(deps, opts);
                return;
            }
            if (!pdfPath) {
                emitFailure(deps, opts, "", undefined, {}, new Error("give a PDF or --page-list"));
                return;
            }
            await runSingle(deps, pdfPath, opts);
        });
    return cmd;
}

async function runSingle(deps: CliDeps, pdfPath: string, opts: RegionsOptions): Promise<void> {
    const effective: Record<string, unknown> = { file: pdfPath };
    let bytes: Uint8Array | undefined;
    try {
        bytes = await deps.loadPdf(pdfPath);
        const pageCount = (await deps.api.getPageCount(bytes)).count;
        const pageIndices = opts.pages ? parsePagesList(opts.pages) : [...Array(pageCount).keys()];
        effective.pageIndices = pageIndices;
        const result = await deps.api.detectRegions({
            pdfData: bytes,
            pageIndices,
            contextPages: Number(opts.contextPages ?? 12),
            classify: opts.classify !== false,
        });
        if (opts.overlayDir) await writeOverlays(deps, bytes, pdfPath, result, opts.overlayDir);
        if (opts.json) {
            emitSuccess(deps, opts, pdfPath, bytes, effective, result);
        } else {
            deps.stdout.write(formatPlain(result));
        }
    } catch (e) {
        emitFailure(deps, opts, pdfPath, bytes, effective, e);
    }
}

function formatPlain(result: RegionDetectionResult): string {
    const lines = [`model: ${result.model ?? "(none — unclassified candidates)"}`];
    for (const p of result.pages) {
        const head = `page ${p.pageIndex}: ${p.candidates.length} candidates` +
            ` (walk ${p.walkMs.toFixed(1)} ms, detect ${p.detectMs.toFixed(1)} ms` +
            `${p.scanned ? ", scanned" : ""}${p.error ? `, error: ${p.error}` : ""})`;
        lines.push(head);
        for (const c of p.candidates) {
            const box = c.bbox.map((v) => v.toFixed(0)).join(",");
            const prob = c.label && c.probs ? ` ${c.probs[c.label].toFixed(2)}` : "";
            lines.push(`  ${(c.label ?? "candidate").padEnd(10)}${prob}  [${box}]${c.anchored ? " anchored" : ""}`);
        }
    }
    return lines.join("\n") + "\n";
}

async function writeOverlays(
    deps: CliDeps,
    bytes: Uint8Array,
    pdfPath: string,
    result: RegionDetectionResult,
    dir: string,
): Promise<void> {
    // Loaded lazily: `sharp` is a CLI-only dependency.
    const { drawBBoxOverlayPNGNode } = await import("../../node/overlayPng");
    await mkdir(dir, { recursive: true });
    const rendered = await deps.api.renderPages({
        pdfData: bytes,
        pageIndices: result.pages.map((p) => p.pageIndex),
        options: { scale: 1.5 },
    });
    for (const page of result.pages) {
        const image = rendered.pages.find((r) => r.pageIndex === page.pageIndex);
        if (!image) continue;
        const rects: OverlayRect[] = page.candidates.map((c, i) => {
            const label = c.label ?? "unclassified";
            return {
                rect: bboxFromXYWH(c.bbox[0], c.bbox[1], c.bbox[2] - c.bbox[0], c.bbox[3] - c.bbox[1], "top-left"),
                color: LABEL_COLORS[label],
                label: c.probs && c.label ? `${label} ${c.probs[c.label].toFixed(2)}` : label,
                group: i,
            };
        });
        const png = await drawBBoxOverlayPNGNode(
            image.data, image.width, image.height, page.width, page.height, rects,
        );
        const stem = basename(pdfPath).replace(/\.pdf$/i, "");
        await writeFile(join(dir, `${stem}-p${page.pageIndex}.png`), png);
    }
}

async function readPageList(path: string, root: string): Promise<PageListRow[]> {
    const rows: PageListRow[] = [];
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as Record<string, unknown>;
        const pdf = String(row.pdf_path ?? row.pdfPath);
        rows.push({
            id: String(row.id ?? row.page_id),
            pdfPath: isAbsolute(pdf) ? pdf : resolve(root, pdf),
            pageIndex: Number(row.page_index ?? row.pageIndex),
        });
    }
    return rows;
}

async function readDoneIds(path: string): Promise<Set<string>> {
    const done = new Set<string>();
    if (!existsSync(path)) return done;
    for (const line of (await readFile(path, "utf8")).split("\n")) {
        if (line.trim()) done.add((JSON.parse(line) as { id: string }).id);
    }
    return done;
}

/**
 * Writes the batch sidecar for a fresh output, or checks that the existing one
 * describes this run. Rows carry feature vectors and predictions without their
 * schema, so appending under different metadata would mislabel earlier rows.
 */
async function ensureBatchMeta(out: string, meta: BatchMeta, hasRows: boolean): Promise<void> {
    const metaPath = `${out}.meta.json`;
    if (!hasRows) {
        await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
        return;
    }
    if (!existsSync(metaPath)) {
        throw new Error(`${out} has results but no ${metaPath}; their provenance is unknown. Use a new --out.`);
    }
    const existing = JSON.parse(await readFile(metaPath, "utf8")) as Partial<BatchMeta>;
    const mismatched = (Object.keys(meta) as (keyof BatchMeta)[]).filter(
        (key) => JSON.stringify(existing[key]) !== JSON.stringify(meta[key]),
    );
    if (mismatched.length > 0) {
        throw new Error(
            `${metaPath} does not match this run (${mismatched.join(", ")}); ` +
            "use a new --out or the settings that produced it.",
        );
    }
}

async function runBatch(deps: CliDeps, opts: RegionsOptions): Promise<void> {
    const effective: Record<string, unknown> = { pageList: opts.pageList, out: opts.out };
    try {
        if (!opts.out) throw new Error("--page-list needs --out");
        const rows = await readPageList(opts.pageList!, opts.root ?? process.cwd());
        const done = await readDoneIds(opts.out);
        const contextPages = Number(opts.contextPages ?? 12);
        await ensureBatchMeta(
            opts.out,
            { ...regionDetectionMeta(opts.classify !== false), contextPages },
            done.size > 0,
        );
        const byPdf = new Map<string, PageListRow[]>();
        for (const row of rows) {
            if (done.has(row.id)) continue;
            const list = byPdf.get(row.pdfPath);
            if (list) list.push(row);
            else byPdf.set(row.pdfPath, [row]);
        }
        let written = 0;
        let failedDocs = 0;
        for (const [pdfPath, pdfRows] of byPdf) {
            let lines: string[];
            try {
                const bytes = await deps.loadPdf(pdfPath);
                const result = await deps.api.detectRegions({
                    pdfData: bytes,
                    pageIndices: pdfRows.map((r) => r.pageIndex),
                    contextPages,
                    classify: opts.classify !== false,
                });
                const sha = pdfSha256(bytes);
                lines = pdfRows.map((row) => {
                    const page = result.pages.find((p) => p.pageIndex === row.pageIndex) as RegionPageResult;
                    return JSON.stringify({ id: row.id, pdf_path: pdfPath, pdf_sha256: sha, ...page });
                });
            } catch (e) {
                failedDocs++;
                const message = e instanceof Error ? e.message : String(e);
                lines = pdfRows.map((row) =>
                    JSON.stringify({ id: row.id, pdf_path: pdfPath, pageIndex: row.pageIndex, candidates: [], error: message }),
                );
            }
            await appendFile(opts.out, lines.join("\n") + "\n");
            written += lines.length;
            if (written % 200 < lines.length) deps.stderr.write(`[regions] ${written} pages written\n`);
        }
        emitSuccess(deps, opts, opts.pageList!, undefined, effective, {
            pages: rows.length, skipped: rows.length - written, written, failedDocs, out: opts.out,
        });
    } catch (e) {
        emitFailure(deps, opts, opts.pageList ?? "", undefined, effective, e);
    }
}
