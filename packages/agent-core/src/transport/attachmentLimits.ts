/**
 * Attachment size and page-count ceilings applied before a file is read.
 *
 * The file-size ceiling protects local resources — memory, and the time spent
 * moving bytes — so it belongs to the client and is user-configurable through a
 * host preference (advanced, no UI) rather than compiled in. A caller-requested
 * cap is not consulted for it. The page-count ceiling is the opposite: it is a
 * hard cap, and a caller may only ask for a stricter one.
 */

import { getRuntimeAdapter } from '../platform/runtime';

/**
 * Unqualified preference key for the file-size ceiling, in MB. The host adds
 * its own preference namespace (see `RuntimeAdapter.getPluginPref`).
 */
const MAX_FILE_SIZE_MB_PREF = 'maxAttachmentFileSizeMB';

/**
 * File-size ceiling used when the host exposes no preference store or the
 * stored value is unusable (absent, non-numeric, or not positive).
 */
export const DEFAULT_MAX_FILE_SIZE_MB = 100;

export const HARD_ATTACHMENT_LIMITS = {
    // Whole-document transfers are additionally bounded by the backend's
    // serialized-payload budget (max_payload_bytes on the document request);
    // oversized extractions fail cleanly with document_too_large.
    maxPageCount: 1500,
} as const;

function positiveFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : null;
}

/**
 * Return the file-size ceiling in MB: the host preference when it holds a
 * positive number, otherwise `DEFAULT_MAX_FILE_SIZE_MB`. Read at the point of
 * use so a preference change takes effect without a reload.
 */
export function effectiveMaxFileSizeMB(): number {
    const configured = getRuntimeAdapter().getPluginPref?.(MAX_FILE_SIZE_MB_PREF);
    return positiveFiniteNumber(configured) ?? DEFAULT_MAX_FILE_SIZE_MB;
}

/**
 * Return the effective page-count ceiling after applying Beaver's hard cap.
 */
export function effectiveMaxPageCount(requested?: number | null): number {
    const requestedLimit = positiveFiniteNumber(requested);
    return Math.min(requestedLimit ?? HARD_ATTACHMENT_LIMITS.maxPageCount, HARD_ATTACHMENT_LIMITS.maxPageCount);
}

/**
 * Snapshots are parsed twice in memory, so they carry their own hard ceiling.
 * The file-size preference can lower it but not raise it: this cap guards the
 * host's memory, not the transfer budget.
 */
export const SNAPSHOT_HARD_MAX_FILE_SIZE_MB = 50;

/**
 * Return the effective snapshot file-size ceiling after both caps.
 */
export function effectiveMaxSnapshotFileSizeMB(): number {
    return Math.min(effectiveMaxFileSizeMB(), SNAPSHOT_HARD_MAX_FILE_SIZE_MB);
}
