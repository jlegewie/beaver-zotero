export const HARD_ATTACHMENT_LIMITS = {
    maxFileSizeMB: 100,
    maxPageCount: 2000,
} as const;

function positiveFiniteNumber(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : null;
}

/**
 * Return the effective file-size ceiling after applying Beaver's hard cap.
 */
export function effectiveMaxFileSizeMB(requested?: number | null): number {
    const requestedLimit = positiveFiniteNumber(requested);
    return Math.min(requestedLimit ?? HARD_ATTACHMENT_LIMITS.maxFileSizeMB, HARD_ATTACHMENT_LIMITS.maxFileSizeMB);
}

/**
 * Return the effective page-count ceiling after applying Beaver's hard cap.
 */
export function effectiveMaxPageCount(requested?: number | null): number {
    const requestedLimit = positiveFiniteNumber(requested);
    return Math.min(requestedLimit ?? HARD_ATTACHMENT_LIMITS.maxPageCount, HARD_ATTACHMENT_LIMITS.maxPageCount);
}

