/**
 * Batch helpers of the export commands (`references export`, `items export`):
 * document lists, sharding, the resume ledger and WASM runtime recovery.
 */
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

import type { CliDeps } from "./runCliTypes";
import { isFatalWasmError, isHeapExhaustionError } from "../wasmFatal";
import { pdfExtractionPreset } from "../schema/presets";

/** A row of a document list: JSONL with `doc_id`, `pdf_path` and, for page lists, `page_index`. */
export interface ListRow {
    doc_id: string;
    pdf_path: string;
    page_index?: number;
}

/** Fail before any output is written when an explicitly supplied input is missing. */
export function requireFiles(paths: readonly string[]): void {
    for (const path of paths) {
        if (!existsSync(path)) throw new Error(`input file not found: ${path}`);
    }
}

/**
 * Read a JSONL file. A missing file is an error unless `optional` (the
 * resume ledger, which does not exist before the first run).
 */
export async function readJsonl<T>(path: string, { optional = false } = {}): Promise<T[]> {
    const rows: T[] = [];
    if (!existsSync(path)) {
        if (optional) return rows;
        throw new Error(`input file not found: ${path}`);
    }
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of rl) {
        if (line.trim()) rows.push(JSON.parse(line) as T);
    }
    return rows;
}

export function parseShard(value: string | undefined): { index: number; count: number } {
    if (!value) return { index: 0, count: 1 };
    const m = /^(\d+)\/(\d+)$/.exec(value);
    if (!m || Number(m[1]) >= Number(m[2])) throw new Error(`invalid --shard ${value}`);
    return { index: Number(m[1]), count: Number(m[2]) };
}

/**
 * After a fatal MuPDF error the cached WASM runtime is unusable; replace it
 * so the next document runs on a fresh one. Returns how the error relates to
 * the runtime: a trap is the document's own failure, heap exhaustion may not
 * be (the document can succeed on a fresh runtime), anything else left the
 * runtime intact.
 */
export function recoverRuntime(deps: CliDeps, err: unknown): "trap" | "heap" | null {
    const kind = isHeapExhaustionError(err) ? "heap" : isFatalWasmError(err) ? "trap" : null;
    if (kind) deps.api.resetExtractionRuntime();
    return kind;
}

export function shardOf(id: string, count: number): number {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % count;
}

/**
 * Cut an interrupted append (a last line without its newline) off the end of
 * an output file, so resumed rows start on a fresh line. A row written in full
 * whose ledger entry was lost is exported again; readers keep the last row
 * per document.
 */
export async function dropTornLine(path: string): Promise<void> {
    if (!existsSync(path)) return;
    const handle = await open(path, "r+");
    try {
        const { size } = await handle.stat();
        if (size === 0) return;
        const tail = Buffer.alloc(Math.min(size, 1 << 20));
        let end = size;
        for (;;) {
            const start = Math.max(0, end - tail.length);
            await handle.read(tail, 0, end - start, start);
            if (end === size && tail[end - start - 1] === 0x0a) return;
            const nl = tail.subarray(0, end - start).lastIndexOf(0x0a);
            if (nl >= 0) {
                await handle.truncate(start + nl + 1);
                return;
            }
            if (start === 0) {
                await handle.truncate(0);
                return;
            }
            end = start;
        }
    } finally {
        await handle.close();
    }
}


/**
 * Documents of `pdfList` in shard `shard` that the ledger at `ledgerPath`
 * does not record as finished. A document is done once it succeeded or its
 * extraction failed. It is given up after two starts without an outcome:
 * the process died on it, or it exhausted the WASM heap and was left for a
 * retry on a fresh runtime. A start that ended in an output error is not
 * held against it.
 */
export async function pendingDocuments(
    pdfList: string,
    ledgerPath: string,
    shard: { index: number; count: number },
): Promise<ListRow[]> {
    const ledger = await readJsonl<{ doc_id: string; status: string }>(ledgerPath, { optional: true });
    const starts = new Map<string, number>();
    const finished = new Set<string>();
    for (const row of ledger) {
        const delta = row.status === "start" ? 1 : row.status === "output_error" ? -1 : 0;
        if (delta !== 0) starts.set(row.doc_id, (starts.get(row.doc_id) ?? 0) + delta);
        else if (row.status !== "retry") finished.add(row.doc_id);
    }
    return (await readJsonl<ListRow>(pdfList)).filter(
        (row) =>
            shardOf(row.doc_id, shard.count) === shard.index &&
            !finished.has(row.doc_id) &&
            (starts.get(row.doc_id) ?? 0) < 2,
    );
}

/**
 * Fail before any document is attempted when `--schema` names a schema
 * without an extraction preset: every extraction would fail, and the ledger
 * would record the documents as finished.
 */
export function checkSchemaOption(schema: string | undefined): void {
    if (schema !== undefined && !pdfExtractionPreset(schema)) {
        throw new Error(`--schema: no extraction preset for PDF schema "${schema}"`);
    }
}

/** The code an export runs: its commit, and whether tracked files differ from it. */
export interface SourceCommit {
    commit: string | null;
    /** Uncommitted changes to tracked files; null when unknown. */
    dirty: boolean | null;
}

/**
 * The commit of the checkout in the working directory. A frozen snapshot
 * (`git archive` plus a `SNAPSHOT_COMMIT` file, as the training repos run
 * exports) reports the file's commit.
 */
export function sourceCommit(): SourceCommit {
    if (existsSync("SNAPSHOT_COMMIT")) {
        return { commit: readFileSync("SNAPSHOT_COMMIT", "utf8").trim(), dirty: false };
    }
    const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    try {
        return {
            commit: git(["rev-parse", "HEAD"]),
            dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "",
        };
    } catch {
        return { commit: null, dirty: null };
    }
}
