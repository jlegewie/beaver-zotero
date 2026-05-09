/**
 * Shared option parsers for CLI commands.
 *
 * Commander hands us strings for every flag value; these helpers turn
 * `--pages 0,1,2`, `--page-range 5:12`, and `--settings settings.json`
 * into the structured shapes the Node API expects, with strict
 * validation so an agent typo surfaces as a clear error rather than
 * silently extracting page 0.
 */
import { readFile } from "node:fs/promises";

export function parsePagesList(value: string): number[] {
    const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
    const out: number[] = [];
    for (const p of parts) {
        const n = Number(p);
        if (!Number.isInteger(n) || n < 0) {
            throw new Error(`--pages: invalid page index "${p}"`);
        }
        out.push(n);
    }
    if (out.length === 0) throw new Error("--pages must list at least one index");
    return out;
}

export function parsePageInt(value: string): number {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
        throw new Error(`--page must be a non-negative integer, got "${value}"`);
    }
    return n;
}

export interface PageRangeOpt {
    startIndex: number;
    endIndex?: number;
    maxPages?: number;
}

export function parsePageRange(value: string): PageRangeOpt {
    // Format: "start:end" or "start:" with `--max-pages` separate.
    // Accept "start" alone for "from this page to the end".
    const m = /^(\d+)(?::(\d+)?)?$/.exec(value);
    if (!m) {
        throw new Error(
            `--page-range must look like "<start>" or "<start>:<end>", got "${value}"`,
        );
    }
    const startIndex = Number(m[1]);
    if (!Number.isInteger(startIndex) || startIndex < 0) {
        throw new Error(`--page-range start must be a non-negative integer`);
    }
    const range: PageRangeOpt = { startIndex };
    if (m[2] != null) {
        const endIndex = Number(m[2]);
        if (!Number.isInteger(endIndex) || endIndex < startIndex) {
            throw new Error(
                `--page-range end must be a non-negative integer >= start`,
            );
        }
        range.endIndex = endIndex;
    }
    return range;
}

export function parseAnalysisWindow(value: string): number {
    // Accept the literal "Infinity" / "inf" as a special case so
    // `Number(value)` produces +Infinity rather than NaN. The downstream
    // op layer (`resolveAnalysisPages`) explicitly handles Infinity.
    const lower = value.trim().toLowerCase();
    const n =
        lower === "infinity" || lower === "inf" ? Number.POSITIVE_INFINITY : Number(value);
    if (Number.isNaN(n) || n < 0) {
        throw new Error(
            `--analysis-window must be a non-negative number (or "Infinity"), got "${value}"`,
        );
    }
    // Finite values must also be integers (the op rejects fractional windows).
    if (Number.isFinite(n) && !Number.isInteger(n)) {
        throw new Error(
            `--analysis-window must be a non-negative integer (or "Infinity"), got "${value}"`,
        );
    }
    return n;
}

export async function loadJsonFile<T = unknown>(path: string): Promise<T> {
    const txt = await readFile(path, "utf8");
    try {
        return JSON.parse(txt) as T;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`failed to parse JSON in ${path}: ${msg}`);
    }
}
