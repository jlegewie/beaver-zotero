/**
 * `beaver-extract features` — export item-classifier training features
 * over a corpus of PDFs as JSONL.
 *
 * One row per detected item:
 *   { sha256, path, pageIndex, pageCount, itemId, kind, text,
 *     features, featureVersion, neighborIds, columnIndex, bbox }
 *
 * The column layout is written once per run to `<out>.features.json`
 * (`{ featureVersion, featureNames }`) so the export stays interpretable
 * without the source tree at the matching commit. Resuming checks that
 * sidecar first: an export produced under a different feature version or
 * name list is refused rather than extended with incompatible vectors,
 * and an export with committed rows but no sidecar cannot be verified, so
 * it is refused too. A validated sidecar is never rewritten, and a new
 * one is written atomically, so no interruption can leave it partial.
 *
 * Document selection comes either from an explicit `--manifest` CSV
 * (`sha256,path,page_count`) or from a deterministic stratified sample of
 * `--inventory` (`sha256,path,byte_size,page_count,copies,error`) drawn
 * with `--sample` / `--seed`. When sampling, the chosen manifest is
 * written next to the output as `<out>.manifest.csv` so the run can be
 * reproduced or resumed with `--manifest`.
 *
 * Page policy: documents up to `PAGE_POLICY_FULL_MAX` pages are processed
 * in full; longer documents contribute their first `PAGE_POLICY_HEAD` and
 * last `PAGE_POLICY_TAIL` pages, where reference lists live. The worker
 * applies it against the page count it reads from the PDF; the manifest's
 * `page_count` only drives sampling.
 *
 * Process recycling: extraction leaks memory across many documents in one
 * process, so long runs should be driven as a shell loop rather than a
 * single invocation. `--limit` processes at most N unprocessed documents
 * and prints a JSON summary including `remaining`; it implies `--resume`,
 * since a non-resuming step would redo the same documents. The sample draw is
 * deterministic, so passing the same `--inventory/--sample/--seed` on
 * every iteration selects the same documents (after the first iteration
 * `--manifest <out>.manifest.csv` is equivalent):
 *
 *   while :; do
 *     out=$(npm run -s beaver-extract -- features \
 *       --inventory inventory.csv --sample 1500 --seed 7 \
 *       --out out.jsonl --resume --limit 40) || break   # command failed
 *     echo "$out"
 *     rem=$(printf '%s' "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["remaining"])') || break
 *     [ "$rem" = 0 ] && break
 *   done
 *
 * The `|| break` guards matter: a failed invocation (bad path, or a
 * process the OS killed) prints no summary, and a loop that only tests
 * `remaining` would retry it forever.
 *
 * Every attempted document gets one line in `<out>.ledger.jsonl`
 * (`{ sha256, status: "ok" | "empty" | "failed" | "aborted", pages, rows,
 * outputBytes, error? }`), and failures are additionally recorded in
 * `<out>.failures.jsonl`. The ledger is the only resume authority:
 * `--resume` treats a document as done when it has a terminal ledger status
 * (`ok` / `empty` / `failed`) or has been aborted `ABORT_RETRY_LIMIT` times,
 * so a permanently broken PDF or one whose pages yield no items cannot
 * stall the loop.
 *
 * Writes are made crash-safe by commit offsets rather than by atomic
 * appends (a single `appendFileSync` is not atomic). The ledger file is
 * created before the first document, so its presence marks the output as
 * owned by this command. A document's rows are appended first; its ledger
 * line then records `outputBytes`, the output size after that append. On
 * resume the ledger's own torn tail (a kill mid-line) is cut back to the
 * last complete line, then output beyond the last committed `outputBytes`
 * — zero for a ledger with no entries — is truncated, so the interrupted
 * document is processed again from scratch. The output is never scanned
 * for document ids, so a surviving fragment can neither mark a document
 * done nor leave a torn line behind. Resume refuses an output shorter than
 * the committed offset (rows the ledger vouches for are missing), and a
 * fresh run refuses an output or ledger that already has content.
 *
 * Persisting a document (rows append, then ledger line) is separate from
 * extracting it: an I/O error there is not a property of the document, so
 * it writes no ledger line and stops the run with a non-zero exit. The
 * next resume discards whatever fragment the failed append left and
 * retries the document.
 *
 * Runtime health decides how an error is handled. A WASM trap is specific
 * to the document: the runtime is reset, the document is recorded as
 * failed and the batch continues. Heap exhaustion and a `--timeout-ms`
 * expiry leave the runtime in an unknown state (worker ops run on a serial
 * queue and cannot be interrupted, so a timed-out op is still executing),
 * so the document is recorded as `aborted`, the batch stops and — after a
 * timeout — the process exits as soon as the summary is written, since
 * the stuck op would otherwise keep it alive. The outer loop's next
 * invocation starts a fresh process and retries the document. The timer
 * can only fire between pages (page processing itself is synchronous), so
 * a document wedged inside a single page still blocks until it finishes.
 */
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    statSync,
    truncateSync,
    writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import { Command } from "commander";

import type { CliDeps } from "../runCliTypes";
import type { ItemFeatureExtractResult } from "../../worker/ops";
import { FEATURE_NAMES, FEATURE_VERSION } from "../../classify/itemFeatures";
import { resetMuPDFNode, setCliLogLevel } from "../../node/bootstrap";
import { isFatalWasmError, isHeapExhaustionError } from "../../wasmFatal";

// ---------------------------------------------------------------------------
// Page policy
// ---------------------------------------------------------------------------

export {
    PAGE_POLICY_FULL_MAX,
    PAGE_POLICY_HEAD,
    PAGE_POLICY_TAIL,
    resolveExportPageIndices,
} from "../../classify/exportPagePolicy";

// ---------------------------------------------------------------------------
// Inventory + stratified sampling
// ---------------------------------------------------------------------------

export interface InventoryRow {
    sha256: string;
    path: string;
    pageCount: number;
}

/**
 * Page-count strata. The corpus is heavily skewed toward short articles,
 * so proportional allocation alone would starve the long-document
 * buckets where book-style bibliographies live.
 */
export const PAGE_BUCKETS: ReadonlyArray<{ label: string; min: number; max: number }> = [
    { label: "1-4", min: 1, max: 4 },
    { label: "5-15", min: 5, max: 15 },
    { label: "16-30", min: 16, max: 30 },
    { label: "31-60", min: 31, max: 60 },
    { label: "61-200", min: 61, max: 200 },
    { label: "201+", min: 201, max: Number.POSITIVE_INFINITY },
];

function bucketIndexFor(pageCount: number): number {
    for (let i = 0; i < PAGE_BUCKETS.length; i++) {
        const bucket = PAGE_BUCKETS[i];
        if (pageCount >= bucket.min && pageCount <= bucket.max) return i;
    }
    return -1;
}

/** Deterministic PRNG so a given seed always yields the same sample. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function next() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffle<T>(values: T[], random: () => number): T[] {
    const out = [...values];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

export interface StratifiedSampleOptions {
    /** Total documents to draw. */
    sample: number;
    seed: number;
    /**
     * Desired minimum per bucket. Capped at `floor(sample / bucketCount)`
     * so a small sample stays feasible, and at the bucket's own size.
     */
    bucketFloor?: number;
}

export interface StratifiedSampleResult {
    rows: InventoryRow[];
    /** Chosen count per bucket, in `PAGE_BUCKETS` order. */
    allocation: number[];
    /** Available count per bucket, in `PAGE_BUCKETS` order. */
    available: number[];
    /** Rows dropped because they carried no usable page count. */
    skipped: number;
}

/**
 * Draw a deterministic stratified sample over {@link PAGE_BUCKETS}.
 *
 * Allocation is proportional to bucket size, raised to the effective
 * floor, capped at bucket size, and then trimmed or topped up so the
 * total matches `sample` whenever the population allows it. Rows without
 * a usable page count are skipped — a PDF the inventory could not open
 * has nothing to featurize.
 */
export function stratifiedSample(
    inventory: readonly InventoryRow[],
    options: StratifiedSampleOptions,
): StratifiedSampleResult {
    const buckets: InventoryRow[][] = PAGE_BUCKETS.map(() => []);
    let skipped = 0;
    for (const row of inventory) {
        const index = bucketIndexFor(row.pageCount);
        if (index < 0) {
            skipped++;
            continue;
        }
        buckets[index].push(row);
    }

    const available = buckets.map((bucket) => bucket.length);
    const population = available.reduce((sum, n) => sum + n, 0);
    const target = Math.max(0, Math.min(Math.floor(options.sample), population));
    const effectiveFloor = Math.min(
        options.bucketFloor ?? 0,
        Math.floor(target / PAGE_BUCKETS.length),
    );

    const allocation = available.map((n) => {
        if (n === 0) return 0;
        const proportional = Math.round((target * n) / Math.max(1, population));
        return Math.min(n, Math.max(proportional, Math.min(effectiveFloor, n)));
    });

    // Reconcile to exactly `target`: trim from the largest allocations
    // that still sit above their floor, top up where capacity remains.
    const floorFor = (i: number): number => Math.min(effectiveFloor, available[i]);
    let total = allocation.reduce((sum, n) => sum + n, 0);
    while (total > target) {
        let best = -1;
        for (let i = 0; i < allocation.length; i++) {
            if (allocation[i] <= floorFor(i)) continue;
            if (best < 0 || allocation[i] > allocation[best]) best = i;
        }
        // Every bucket is already at its floor — trim the largest anyway
        // so the requested total is still honoured.
        if (best < 0) {
            for (let i = 0; i < allocation.length; i++) {
                if (allocation[i] > 0 && (best < 0 || allocation[i] > allocation[best])) {
                    best = i;
                }
            }
        }
        if (best < 0) break;
        allocation[best]--;
        total--;
    }
    while (total < target) {
        let best = -1;
        for (let i = 0; i < allocation.length; i++) {
            if (allocation[i] >= available[i]) continue;
            const headroom = available[i] - allocation[i];
            if (best < 0 || headroom > available[best] - allocation[best]) best = i;
        }
        if (best < 0) break;
        allocation[best]++;
        total++;
    }

    const random = mulberry32(options.seed);
    const rows: InventoryRow[] = [];
    for (let i = 0; i < buckets.length; i++) {
        // Sort before shuffling so the draw is independent of input order.
        const sorted = [...buckets[i]].sort((a, b) =>
            a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0,
        );
        rows.push(...shuffle(sorted, random).slice(0, allocation[i]));
    }

    // Interleave the buckets so any prefix of the manifest — a run stopped
    // early, or one still in progress — is itself stratified.
    return { rows: shuffle(rows, random), allocation, available, skipped };
}

// ---------------------------------------------------------------------------
// CSV / JSONL helpers
// ---------------------------------------------------------------------------

/**
 * Split one CSV record into cells. Handles double-quoted fields with
 * embedded commas and doubled quotes (RFC 4180); a quoted field may not
 * span lines, which no file path needs.
 */
export function parseCsvLine(line: string): string[] {
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"') {
                if (line[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else {
                    quoted = false;
                }
            } else {
                cell += ch;
            }
        } else if (ch === '"' && cell.length === 0) {
            quoted = true;
        } else if (ch === ",") {
            cells.push(cell);
            cell = "";
        } else {
            cell += ch;
        }
    }
    cells.push(cell);
    return cells;
}

/** Quote a cell when it holds a comma, quote or line break. */
export function toCsvCell(value: string): string {
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Parse a header-bearing CSV into rows with `sha256` / `path` /
 * `page_count` columns. Paths may be quoted when they contain commas or
 * quotes; other columns are ignored.
 */
export function parseInventoryCsv(text: string): InventoryRow[] {
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) return [];
    const header = parseCsvLine(lines[0]).map((cell) => cell.trim());
    const shaAt = header.indexOf("sha256");
    const pathAt = header.indexOf("path");
    const pagesAt = header.indexOf("page_count");
    if (shaAt < 0 || pathAt < 0) {
        throw new Error("CSV must have `sha256` and `path` columns");
    }
    const rows: InventoryRow[] = [];
    for (let i = 1; i < lines.length; i++) {
        const cells = parseCsvLine(lines[i]);
        const sha256 = (cells[shaAt] ?? "").trim();
        const path = (cells[pathAt] ?? "").trim();
        if (!sha256 || !path) continue;
        const rawPages = pagesAt >= 0 ? (cells[pagesAt] ?? "").trim() : "";
        const pageCount = rawPages === "" ? 0 : Number(rawPages);
        rows.push({
            sha256,
            path,
            pageCount: Number.isFinite(pageCount) ? pageCount : 0,
        });
    }
    return rows;
}

function toManifestCsv(rows: readonly InventoryRow[]): string {
    const lines = ["sha256,path,page_count"];
    for (const row of rows) {
        lines.push(`${toCsvCell(row.sha256)},${toCsvCell(row.path)},${row.pageCount}`);
    }
    return lines.join("\n") + "\n";
}

/** Ledger line written for every attempted document. */
export interface LedgerEntry {
    sha256: string;
    status: "ok" | "empty" | "failed" | "aborted";
    pages: number;
    rows: number;
    /** Output file size once this document's rows were on disk: the commit offset. */
    outputBytes: number;
    error?: string;
}

/**
 * A document aborted this many times (heap exhaustion or timeout in
 * separate processes) is treated as done so it cannot stall the loop.
 */
export const ABORT_RETRY_LIMIT = 2;

export interface LedgerSummary {
    /** Documents with a terminal status, or aborted at least `abortLimit` times. */
    done: Set<string>;
    /** Abort count per document that has no terminal status yet. */
    abortCounts: Map<string, number>;
    /** Number of ledger lines that parsed as entries. */
    entryCount: number;
    /**
     * Largest recorded output size; everything past it is uncommitted.
     * Zero for a ledger with no entries. `null` when entries exist but none
     * carries `outputBytes`, so nothing can be trusted as a commit point.
     */
    committedOutputBytes: number | null;
}

/**
 * Read the attempt ledger. Only newline-terminated lines count: an
 * interrupted append can leave a complete JSON object without its newline,
 * and `repairLedger` removes exactly that tail, so the two must agree on
 * what is committed. Malformed lines are ignored.
 */
export async function readLedger(
    path: string,
    abortLimit: number = ABORT_RETRY_LIMIT,
): Promise<LedgerSummary> {
    const done = new Set<string>();
    const abortCounts = new Map<string, number>();
    let entryCount = 0;
    let committedOutputBytes: number | null = null;
    if (!existsSync(path)) return { done, abortCounts, entryCount, committedOutputBytes };
    const text = readFileSync(path, "utf8");
    const terminated = text.slice(0, text.lastIndexOf("\n") + 1);
    for (const line of terminated.split("\n")) {
        if (line.trim().length === 0) continue;
        let entry: Partial<LedgerEntry>;
        try {
            entry = JSON.parse(line) as Partial<LedgerEntry>;
        } catch {
            continue;
        }
        if (typeof entry.sha256 !== "string") continue;
        entryCount++;
        if (typeof entry.outputBytes === "number" && Number.isFinite(entry.outputBytes)) {
            committedOutputBytes = Math.max(committedOutputBytes ?? 0, entry.outputBytes);
        }
        if (entry.status === "aborted") {
            abortCounts.set(entry.sha256, (abortCounts.get(entry.sha256) ?? 0) + 1);
        } else if (entry.status === "ok" || entry.status === "empty" || entry.status === "failed") {
            done.add(entry.sha256);
        }
    }
    for (const [sha256, count] of abortCounts) {
        if (count >= abortLimit || done.has(sha256)) {
            done.add(sha256);
            abortCounts.delete(sha256);
        }
    }
    if (entryCount === 0) committedOutputBytes = 0;
    return { done, abortCounts, entryCount, committedOutputBytes };
}

function fileSize(path: string): number {
    return existsSync(path) ? statSync(path).size : 0;
}

/**
 * Cut a ledger back to its last complete line. A process killed while
 * appending a ledger line leaves a fragment without a trailing newline;
 * appending to it would glue the next entry onto the fragment and hide
 * both. Returns the number of bytes discarded.
 */
export function repairLedger(path: string): number {
    if (!existsSync(path)) return 0;
    const bytes = readFileSync(path);
    if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return 0;
    const lastNewline = bytes.lastIndexOf(0x0a);
    const keep = lastNewline + 1;
    truncateSync(path, keep);
    return bytes.length - keep;
}

/**
 * Roll the output back to the last commit offset the ledger recorded, so a
 * document whose rows were only partly written is retried from scratch.
 * Returns the number of bytes discarded.
 */
export function discardUncommittedOutput(outPath: string, ledger: LedgerSummary): number {
    const size = fileSize(outPath);
    if (ledger.committedOutputBytes == null || size <= ledger.committedOutputBytes) return 0;
    truncateSync(outPath, ledger.committedOutputBytes);
    return size - ledger.committedOutputBytes;
}

export interface BatchPlan {
    /** Documents not yet done, in manifest order. */
    pending: InventoryRow[];
    /** The slice of `pending` this invocation will process. */
    batch: InventoryRow[];
    /** Documents skipped because they were already done. */
    skipped: number;
    /** Pending documents left for a later invocation. */
    remaining: number;
}

/** Split the manifest into done / this batch / later, honouring `--limit`. */
export function planBatch(
    documents: readonly InventoryRow[],
    done: ReadonlySet<string>,
    limit: number | undefined,
): BatchPlan {
    const pending = documents.filter((doc) => !done.has(doc.sha256));
    const batch = limit != null ? pending.slice(0, limit) : pending;
    return {
        pending,
        batch,
        skipped: documents.length - pending.length,
        remaining: Math.max(0, pending.length - batch.length),
    };
}

/** An output or ledger write failed; the document must not be recorded either way. */
class OutputWriteError extends Error {
    constructor(path: string, cause: unknown) {
        super(
            `writing ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        this.name = "OutputWriteError";
    }
}

class DocumentTimeoutError extends Error {
    constructor(label: string, ms: number) {
        super(`${label} timed out after ${ms}ms`);
        this.name = "DocumentTimeoutError";
    }
}

/**
 * Race `promise` against a timer. A timed-out promise is not cancelled —
 * worker ops are serial and cannot be interrupted — so the caller must
 * stop issuing work to this process; the late settlement is observed only
 * to keep it from surfacing as an unhandled rejection.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    if (!Number.isFinite(ms) || ms <= 0) return promise;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DocumentTimeoutError(label, ms)), ms);
    });
    promise.then(
        () => undefined,
        () => undefined,
    );
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    }) as Promise<T>;
}

/** The column layout an export was produced with, from its sidecar. */
export interface FeatureContract {
    featureVersion: number;
    featureNames: readonly string[];
}

/**
 * Compare an existing export's sidecar against this build's layout. Returns
 * a description of the mismatch, or `null` when the export can be extended.
 */
export function featureContractMismatch(
    existing: unknown,
    current: FeatureContract,
): string | null {
    const record = existing as Partial<FeatureContract> | null;
    if (!record || typeof record !== "object") return "sidecar is not an object";
    if (record.featureVersion !== current.featureVersion) {
        return `feature version ${String(record.featureVersion)} differs from ${current.featureVersion}`;
    }
    const names = record.featureNames;
    if (!Array.isArray(names)) return "sidecar has no feature name list";
    if (names.length !== current.featureNames.length) {
        return `${names.length} feature names differ from ${current.featureNames.length}`;
    }
    for (let i = 0; i < names.length; i++) {
        if (names[i] !== current.featureNames[i]) {
            return `feature ${i} is "${String(names[i])}" but this build emits "${current.featureNames[i]}"`;
        }
    }
    return null;
}

/** Errors after which this process must not run another extraction. */
function poisonsRuntime(error: unknown): boolean {
    return error instanceof DocumentTimeoutError || isHeapExhaustionError(error);
}

function resetRuntimeAfterFatalError(error: unknown): boolean {
    if (!isFatalWasmError(error)) return false;
    try {
        resetMuPDFNode();
    } catch {
        // Dead WASM heap; the next op re-instantiates.
    }
    return true;
}

/**
 * Replace a small file atomically (write a sibling temp file, then rename)
 * so an interrupted write can never leave it empty or partial.
 */
function writeFileAtomic(path: string, content: string): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
}

function appendLedger(path: string, entry: LedgerEntry): void {
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

function ensureParentDir(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
}

function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
    if (raw == null) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer (got ${raw})`);
    }
    return value;
}

function parseNonNegativeInt(raw: string, label: string): number {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative integer (got ${raw})`);
    }
    return value;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function buildFeaturesCommand(deps: CliDeps): Command {
    const cmd = new Command("features");
    cmd.description(
        "Export item-classifier features over a PDF corpus as JSONL. " +
            "Select documents with --manifest, or draw a deterministic " +
            "stratified sample from --inventory with --sample/--seed.",
    )
        .requiredOption("--out <jsonl>", "output JSONL path")
        .option("--inventory <csv>", "corpus inventory CSV (sha256,path,page_count,...)")
        .option("--manifest <csv>", "explicit document list (sha256,path,page_count)")
        .option("--sample <n>", "draw N documents from --inventory")
        .option("--seed <n>", "PRNG seed for --sample", "42")
        .option(
            "--bucket-floor <n>",
            "desired minimum documents per page-count bucket",
            "60",
        )
        .option(
            "--resume",
            "skip documents already settled in the ledger, the output or the failure log",
        )
        .option(
            "--limit <n>",
            "process at most N unsettled documents, then exit (implies --resume)",
        )
        .option(
            "--timeout-ms <n>",
            "per-document timeout; on expiry the document is recorded as aborted and the batch stops",
            "300000",
        )
        .option("--language <lang>", "splitter language code (e.g. 'en')")
        .action(async (opts: Record<string, string | boolean | undefined>) => {
            const startedAt = performance.now();
            const outPath = String(opts.out);
            const manifestOutPath = `${outPath}.manifest.csv`;
            const failuresPath = `${outPath}.failures.jsonl`;
            const ledgerPath = `${outPath}.ledger.jsonl`;
            const featureNamesPath = `${outPath}.features.json`;

            try {
                const sample = parsePositiveInt(
                    opts.sample as string | undefined,
                    "--sample",
                );
                const limit = parsePositiveInt(
                    opts.limit as string | undefined,
                    "--limit",
                );
                const timeoutMs = parseNonNegativeInt(
                    String(opts.timeoutMs ?? "300000"),
                    "--timeout-ms",
                );
                const seed = Number(opts.seed ?? "42");
                const bucketFloor = parseNonNegativeInt(
                    String(opts.bucketFloor ?? "60"),
                    "--bucket-floor",
                );
                if (!Number.isFinite(seed)) {
                    throw new Error(`--seed must be a number (got ${opts.seed})`);
                }

                let documents: InventoryRow[];
                let drawnManifest: string | undefined;
                let drawnSummary: string | undefined;
                if (opts.manifest) {
                    documents = parseInventoryCsv(
                        await readTextFile(String(opts.manifest)),
                    );
                } else {
                    if (!opts.inventory) {
                        throw new Error(
                            "either --manifest or --inventory with --sample is required",
                        );
                    }
                    if (sample == null) {
                        throw new Error("--sample is required with --inventory");
                    }
                    const inventory = parseInventoryCsv(
                        await readTextFile(String(opts.inventory)),
                    );
                    const drawn = stratifiedSample(inventory, {
                        sample,
                        seed,
                        bucketFloor,
                    });
                    documents = drawn.rows;
                    drawnManifest = toManifestCsv(documents);
                    drawnSummary =
                        `manifest: ${documents.length} documents -> ${manifestOutPath} ` +
                        `(per bucket ${drawn.allocation.join("/")} of ${drawn.available.join("/")}, ` +
                        `${drawn.skipped} row(s) without a page count skipped)\n`;
                }

                // Everything up to the mutation block below only reads the
                // export: every refusal must leave the files exactly as found.
                // `--limit` only makes sense as one step of a resumable loop;
                // without resume every step would redo the same first N
                // documents and append their rows again.
                const resume = Boolean(opts.resume) || limit != null;
                const ledgerExists = existsSync(ledgerPath);
                // Reading tolerates a torn final line; repairing it comes later.
                const ledger = await readLedger(ledgerPath);
                if (!resume && (fileSize(outPath) > 0 || ledger.entryCount > 0)) {
                    throw new Error(
                        `${outPath} or its ledger already has content; pass --resume to continue it or choose another --out`,
                    );
                }
                if (fileSize(outPath) > 0 && !ledgerExists) {
                    throw new Error(
                        `${outPath} exists but has no ledger (${ledgerPath}), so nothing in it is ` +
                            "known to be complete; move it aside or choose another --out",
                    );
                }
                if (
                    resume &&
                    ledger.committedOutputBytes != null &&
                    fileSize(outPath) < ledger.committedOutputBytes
                ) {
                    throw new Error(
                        `${outPath} is ${fileSize(outPath)} bytes but ${ledgerPath} vouches for ` +
                            `${ledger.committedOutputBytes}; committed rows are missing, so the export ` +
                            "cannot be continued safely. Restore the output or start a new --out",
                    );
                }
                // An export already holding rows must have been produced
                // under this build's column layout, or extending it would
                // mix incompatible vectors under one sidecar.
                const contract: FeatureContract = {
                    featureVersion: FEATURE_VERSION,
                    featureNames: FEATURE_NAMES,
                };
                const sidecarValidated = ledger.entryCount > 0;
                if (sidecarValidated) {
                    if (!existsSync(featureNamesPath)) {
                        throw new Error(
                            `${outPath} has committed rows but no ${featureNamesPath}, so its column ` +
                                "layout cannot be verified; start a new --out",
                        );
                    }
                    let existing: unknown;
                    try {
                        existing = JSON.parse(readFileSync(featureNamesPath, "utf8"));
                    } catch (e) {
                        throw new Error(
                            `${featureNamesPath} is unreadable (${e instanceof Error ? e.message : String(e)}); ` +
                                "start a new --out",
                        );
                    }
                    const mismatch = featureContractMismatch(existing, contract);
                    if (mismatch) {
                        throw new Error(
                            `${outPath} was produced with a different feature layout (${mismatch}); ` +
                                "it cannot be resumed with this build. Start a new --out",
                        );
                    }
                }

                // Mutations start here, once the export is known to be
                // continuable: recover from an interrupted write, then
                // record the run's manifest, ledger and column layout.
                const tornLedgerBytes = repairLedger(ledgerPath);
                if (tornLedgerBytes > 0) {
                    deps.stderr.write(
                        `discarded a torn ${tornLedgerBytes}-byte ledger line left by an interrupted write\n`,
                    );
                }
                const discarded = discardUncommittedOutput(outPath, ledger);
                if (discarded > 0) {
                    deps.stderr.write(
                        `discarded ${discarded} uncommitted byte(s) of output left by an interrupted write\n`,
                    );
                }
                ensureParentDir(outPath);
                if (drawnManifest !== undefined && drawnSummary !== undefined) {
                    writeFileAtomic(manifestOutPath, drawnManifest);
                    deps.stderr.write(drawnSummary);
                }
                // Create the ledger before any output so a kill during the
                // first document still leaves the output recoverable.
                appendFileSync(ledgerPath, "", "utf8");
                // A sidecar that was just validated is left exactly as it
                // is; rewriting it would open a window in which a kill
                // leaves the export unverifiable.
                if (!sidecarValidated) {
                    writeFileAtomic(featureNamesPath, JSON.stringify(contract, null, 2) + "\n");
                }
                const done = resume ? ledger.done : new Set<string>();
                const { pending, batch } = planBatch(documents, done, limit);
                // Documents settled by this invocation, for the final count.
                const settled = new Set<string>();
                setCliLogLevel("silent");

                let processed = 0;
                let failed = 0;
                let aborted = 0;
                let rowCount = 0;
                let exitAfterSummary = false;

                for (let i = 0; i < batch.length; i++) {
                    const doc = batch[i];
                    const label = `[${i + 1}/${batch.length}] ${doc.sha256.slice(0, 12)}`;
                    let wasmReset = false;
                    let extracted:
                        | { result: ItemFeatureExtractResult; lines: string[] }
                        | undefined;
                    try {
                        const bytes = await deps.loadPdf(doc.path);
                        const result = await withTimeout(
                            deps.api.extractItemFeatures({
                                pdfData: bytes,
                                applyExportPagePolicy: true,
                                splitterConfig: opts.language
                                    ? {
                                          type: "sentencex",
                                          language: String(opts.language),
                                      }
                                    : undefined,
                            }),
                            timeoutMs,
                            "extractItemFeatures",
                        );

                        const lines: string[] = [];
                        for (const page of result.pages) {
                            for (const item of page.items) {
                                lines.push(
                                    JSON.stringify({
                                        sha256: doc.sha256,
                                        path: doc.path,
                                        pageIndex: page.pageIndex,
                                        pageCount: result.pageCount,
                                        itemId: item.itemId,
                                        kind: item.kind,
                                        text: item.text,
                                        features: item.features,
                                        featureVersion: result.featureVersion,
                                        neighborIds: item.neighborIds,
                                        columnIndex: item.columnIndex,
                                        bbox: item.bbox,
                                    }),
                                );
                            }
                        }
                        extracted = { result, lines };
                    } catch (e) {
                        const message = e instanceof Error ? e.message : String(e);
                        if (poisonsRuntime(e)) {
                            aborted++;
                            appendLedger(ledgerPath, {
                                sha256: doc.sha256,
                                status: "aborted",
                                pages: 0,
                                rows: 0,
                                outputBytes: fileSize(outPath),
                                error: message,
                            });
                            const attempts = (ledger.abortCounts.get(doc.sha256) ?? 0) + 1;
                            if (attempts >= ABORT_RETRY_LIMIT) settled.add(doc.sha256);
                            exitAfterSummary = e instanceof DocumentTimeoutError;
                            deps.stderr.write(
                                `${label} ABORTED (attempt ${attempts}/${ABORT_RETRY_LIMIT}): ${message}\n` +
                                    "stopping this batch; rerun with --resume to continue in a fresh process\n",
                            );
                            break;
                        }
                        wasmReset = resetRuntimeAfterFatalError(e);
                        failed++;
                        appendFileSync(
                            failuresPath,
                            JSON.stringify({
                                sha256: doc.sha256,
                                path: doc.path,
                                error: message,
                                wasmReset,
                            }) + "\n",
                            "utf8",
                        );
                        appendLedger(ledgerPath, {
                            sha256: doc.sha256,
                            status: "failed",
                            pages: 0,
                            rows: 0,
                            outputBytes: fileSize(outPath),
                            error: message,
                        });
                        settled.add(doc.sha256);
                        deps.stderr.write(
                            `${label} FAILED${wasmReset ? " (wasm reset)" : ""}: ` +
                                `${e instanceof Error ? e.message : String(e)}\n`,
                        );
                    }
                    if (!extracted) continue;

                    // Persistence is outside the document's try/catch on
                    // purpose: a write error says nothing about the document
                    // and must not record it. Rows first, ledger second: the
                    // ledger's commit offset is what makes an interrupted
                    // append safe.
                    const { result, lines } = extracted;
                    try {
                        appendFileSync(
                            outPath,
                            lines.length > 0 ? lines.join("\n") + "\n" : "",
                            "utf8",
                        );
                    } catch (e) {
                        throw new OutputWriteError(outPath, e);
                    }
                    try {
                        appendLedger(ledgerPath, {
                            sha256: doc.sha256,
                            status: lines.length > 0 ? "ok" : "empty",
                            pages: result.pages.length,
                            rows: lines.length,
                            outputBytes: fileSize(outPath),
                        });
                    } catch (e) {
                        throw new OutputWriteError(ledgerPath, e);
                    }
                    settled.add(doc.sha256);
                    rowCount += lines.length;
                    processed++;
                    deps.stderr.write(
                        `${label} ok pages=${result.pages.length} rows=${lines.length}\n`,
                    );
                }

                const remaining = pending.filter((doc) => !settled.has(doc.sha256)).length;
                const summary = {
                    processed,
                    failed,
                    aborted,
                    skipped: documents.length - pending.length,
                    remaining,
                    rows: rowCount,
                    out: outPath,
                    elapsedMs: Math.round(performance.now() - startedAt),
                };
                if (exitAfterSummary) {
                    // The timed-out op is still running and would keep the
                    // process alive; leave once the summary has been flushed.
                    deps.stdout.write(JSON.stringify(summary) + "\n", () => {
                        process.exit(process.exitCode ?? 0);
                    });
                } else {
                    deps.stdout.write(JSON.stringify(summary) + "\n");
                }
            } catch (e) {
                deps.stderr.write(
                    `beaver-extract features: ${e instanceof Error ? e.message : String(e)}\n`,
                );
                process.exitCode = 1;
            }
        });
    return cmd;
}

async function readTextFile(path: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    return readFile(path, "utf8");
}
