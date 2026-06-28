/**
 * Heap exhaustion can be recoverable after replacing the current runtime, so
 * callers classify it separately from permanent WASM traps.
 */
const HEAP_EXHAUSTION_PATTERNS: RegExp[] = [
    /malloc\b[\s\S]*failed/i,
    /realloc\b[\s\S]*failed/i,
    /calloc\b[\s\S]*failed/i,
    /out of memory/i,
    /Cannot enlarge memory/i,
    /Aborted\(OOM\)/i,
];

export function isHeapExhaustionError(err: unknown): boolean {
    const msg = errorText(err);
    return HEAP_EXHAUSTION_PATTERNS.some((re) => re.test(msg));
}

/**
 * MuPDF WASM traps leave the current WebAssembly instance unusable and are
 * treated as permanent failures for the current PDF operation.
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
    if (isHeapExhaustionError(err)) return false;
    const msg = errorText(err);
    return WASM_FATAL_PATTERNS.some((re) => re.test(msg));
}

/**
 * Page-resolution failures that mean a page index cannot be resolved, not that
 * the document or runtime is unusable.
 */
const RECOVERABLE_PAGE_ERROR_PATTERN = /page tree|invalid page number/i;

/**
 * True only when page iteration may skip a single unresolved page. Later
 * extraction failures, WASM traps, and heap exhaustion still abort the document.
 */
export function isRecoverablePageError(err: unknown): boolean {
    if (isHeapExhaustionError(err)) return false;
    if (isFatalWasmError(err)) return false;
    return RECOVERABLE_PAGE_ERROR_PATTERN.test(errorText(err));
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
