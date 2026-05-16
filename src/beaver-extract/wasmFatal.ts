/**
 * MuPDF WASM traps leave the current WebAssembly instance unusable. Any caller
 * that sees one of these errors must discard the cached runtime before issuing
 * more PDF operations.
 */
export const WASM_FATAL_PATTERNS: RegExp[] = [
    /memory access out of bounds/i,
    /RuntimeError/,
    /unreachable executed/i,
    /table index is out of bounds/i,
    /call stack exhausted/i,
    /Maximum call stack size exceeded/i,
    /stack overflow/i,
];

export function isFatalWasmError(err: unknown): boolean {
    const msg = errorText(err);
    return WASM_FATAL_PATTERNS.some((re) => re.test(msg));
}

/**
 * MuPDF page-tree resolution failures. A malformed page tree can report N
 * pages via `countPages()` yet fail to resolve individual leaves; every such
 * `loadPage` error carries the substring "page tree" (e.g. "cannot find page N
 * in page tree", "non-page object in page tree", "malformed page tree", "cycle
 * in page tree"). See `source/pdf/pdf-page.c` in the MuPDF source.
 */
const PAGE_TREE_ERROR_PATTERN = /page tree/i;

/**
 * True only for MuPDF page-tree resolution failures — the case where a page
 * index cannot be resolved to a page object at all. Native `mutool` skips such
 * pages and extracts the rest; this predicate lets page-iteration code do the
 * same, isolating one unresolvable leaf instead of aborting the whole document.
 *
 * Deliberately narrow: a failure later in page processing (a corrupt content
 * stream that breaks `toStructuredText`, a JSON parse error) is NOT recoverable
 * here — silently dropping such a page would hide a real extraction failure, so
 * those propagate and abort. WASM traps are likewise non-recoverable: they
 * leave the runtime unusable.
 */
export function isRecoverablePageError(err: unknown): boolean {
    if (isFatalWasmError(err)) return false;
    return PAGE_TREE_ERROR_PATTERN.test(errorText(err));
}

function errorText(err: unknown): string {
    if (err instanceof Error) {
        return [err.name, err.message].filter(Boolean).join(": ");
    }
    if (err && typeof err === "object") {
        const record = err as Record<string, unknown>;
        return [record.name, record.message, record.code]
            .filter((v): v is string => typeof v === "string" && v.length > 0)
            .join(": ");
    }
    return String(err);
}
