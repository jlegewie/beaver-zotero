export const HARD_ATTACHMENT_LIMITS = {
    maxFileSizeMB: 100,
    // Whole-document transfers are additionally bounded by the backend's
    // serialized-payload budget (max_payload_bytes on the document request);
    // oversized extractions fail cleanly with document_too_large.
    maxPageCount: 1500,
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

// Snapshots are parsed twice in memory, so use a tighter cap than other files.
export const SNAPSHOT_HARD_MAX_FILE_SIZE_MB = 50;

/**
 * Return the effective snapshot file-size ceiling after both hard caps.
 */
export function effectiveMaxSnapshotFileSizeMB(requested?: number | null): number {
    return Math.min(effectiveMaxFileSizeMB(requested), SNAPSHOT_HARD_MAX_FILE_SIZE_MB);
}
