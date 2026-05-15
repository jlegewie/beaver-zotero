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
