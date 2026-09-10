/**
 * User-facing grouping of attachments background processing could not finish.
 *
 * The ledger records outcomes as machine codes (`file_missing`,
 * `too_many_pages`, ...). The preferences UI shows one row per *reason* instead,
 * with a title and a short explanation a user can act on, and lists the affected
 * attachments underneath. This module turns ledger rows and dead-lettered jobs
 * into those groups. It is React-free and imported by both bundles.
 */

export type ProcessingIssueReason =
    | 'scanned'
    | 'no_text'
    | 'file_unavailable'
    | 'encrypted'
    | 'too_large'
    | 'unsupported'
    | 'extract_failed'
    | 'ocr_failed'
    | 'index_failed';

export interface IssueEntitlements {
    hasOcrAccess: boolean;
    hasSearchIndexAccess: boolean;
}

/** One dead-lettered queue job, as read back for the issues list. */
export interface BackgroundQueueDeadRow {
    jobType: string;
    libraryId: number | null;
    zoteroKey: string | null;
    lastError: string | null;
    diedAt: number | null;
}

/** One ledger row that did not reach a readable state. */
export interface AttachmentProcessingIssueRow {
    contentKind: string | null;
    libraryId: number;
    zoteroKey: string;
    extractStatus: string | null;
    ocrStatus: string | null;
    upsertStatus: string | null;
    lastError: string | null;
    updatedAt: string | null;
}

/** Ledger identity of one attachment. */
export interface AttachmentRef {
    libraryId: number;
    zoteroKey: string;
}

export interface ProcessingIssueItem {
    libraryId: number;
    zoteroKey: string;
    /** Raw ledger/queue code, kept for diagnostics (never shown as-is). */
    error: string | null;
    timestamp: string | number | null;
}

export interface ProcessingIssueGroup {
    reason: ProcessingIssueReason;
    count: number;
    /** Most recent first. */
    items: ProcessingIssueItem[];
}

export type ProcessingIssueSummary = Pick<ProcessingIssueGroup, 'reason' | 'count'>;

/** Shared SQL inventory for counts and pages; no attachment rows cross into JS for counts. */
export function processingIssuesSql(entitlements: IssueEntitlements): string {
    const hasCodeSql = (code: string) => `(last_error = '${code}'
        OR instr(last_error, '${code}:') = 1 OR instr(last_error, ': ${code}') > 0)`;
    const anyCodeSql = (codes: string[]) => codes.map(hasCodeSql).join(' OR ');
    return `WITH ledger AS (
        SELECT library_id, zotero_key, extract_status, ocr_status, upsert_status, last_error,
            CAST(strftime('%s', updated_at) AS INTEGER) * 1000 AS timestamp,
            CASE
                WHEN extract_status IN ('failed', 'skipped') THEN CASE
                    WHEN ${anyCodeSql(FILE_UNAVAILABLE_CODES)} THEN 'file_unavailable'
                    WHEN ${hasCodeSql('encrypted')} THEN 'encrypted'
                    WHEN ${anyCodeSql(TOO_LARGE_CODES)} THEN 'too_large'
                    WHEN instr(last_error, 'unsupported_') = 1 OR instr(last_error, ': unsupported_') > 0 THEN 'unsupported'
                    WHEN ${anyCodeSql(NO_TEXT_CODES)} THEN CASE
                        WHEN content_kind = 'pdf' AND ${entitlements.hasOcrAccess ? 0 : 1} THEN 'scanned'
                        ELSE 'no_text' END
                    ELSE 'extract_failed' END
                WHEN upsert_status = 'failed' AND ${entitlements.hasSearchIndexAccess ? 1 : 0} THEN 'index_failed'
                WHEN ocr_status = 'failed' THEN CASE
                    WHEN ${anyCodeSql(FILE_UNAVAILABLE_CODES)} THEN 'file_unavailable'
                    ELSE 'ocr_failed' END
                WHEN ocr_status = 'needed' AND ${entitlements.hasOcrAccess ? 0 : 1} THEN 'scanned'
            END AS reason
        FROM attachment_processing_state
    ), dead AS (
        SELECT d.library_id, d.zotero_key, d.last_error, d.died_at AS timestamp,
            CASE d.job_type WHEN 'document_extract' THEN 'extract_failed'
                WHEN 'document_ocr' THEN 'ocr_failed' WHEN 'fulltext_upsert' THEN 'index_failed' END AS reason,
            ROW_NUMBER() OVER (PARTITION BY d.library_id, d.zotero_key ORDER BY d.died_at DESC, d.id DESC) AS rank
        FROM background_jobs_dead d
        JOIN ledger s ON s.library_id = d.library_id AND s.zotero_key = d.zotero_key
        WHERE s.reason IS NULL AND (
            (d.job_type = 'document_extract' AND coalesce(s.extract_status, '') != 'done')
            OR (d.job_type = 'document_ocr' AND NOT (s.extract_status IS 'done' AND coalesce(s.ocr_status, '') IN ('done', 'na')))
            OR (d.job_type = 'fulltext_upsert' AND ${entitlements.hasSearchIndexAccess ? 1 : 0} AND coalesce(s.upsert_status, '') != 'done')
        )
    ), issues AS (
        SELECT library_id, zotero_key, last_error, timestamp, reason FROM ledger WHERE reason IS NOT NULL
        UNION ALL
        SELECT library_id, zotero_key, last_error, timestamp, reason FROM dead WHERE rank = 1
    )`;
}

/** Display order: actionable and common reasons first. */
export const PROCESSING_ISSUE_REASON_ORDER: ProcessingIssueReason[] = [
    'scanned',
    'file_unavailable',
    'extract_failed',
    'no_text',
    'ocr_failed',
    'index_failed',
    'encrypted',
    'too_large',
    'unsupported',
];

/**
 * Reasons a user can retry from the issues list. The rest describe the bytes
 * themselves (encrypted, too large, unsupported, no text) or an entitlement
 * (scans without OCR access), so re-running them fails identically; a replaced
 * file is picked up by the reconciler's own signature check instead.
 */
export const RETRYABLE_PROCESSING_ISSUE_REASONS: readonly ProcessingIssueReason[] = [
    'file_unavailable',
    'extract_failed',
    'ocr_failed',
    'index_failed',
];

export function isRetryableProcessingIssue(reason: ProcessingIssueReason): boolean {
    return RETRYABLE_PROCESSING_ISSUE_REASONS.includes(reason);
}

const FILE_UNAVAILABLE_CODES = ['file_missing', 'download_failed', 'read_failed'];
const TOO_LARGE_CODES = ['file_too_large', 'too_many_pages'];
const NO_TEXT_CODES = ['no_text_layer', 'empty_document', 'insufficient_text'];

/**
 * True when `error` carries `code`, in any of the shapes the pipeline records:
 * a bare code, `"<code>: <message>"`, or a wrapped `"...: <code>"`.
 */
function hasCode(error: string | null, code: string): boolean {
    if (!error) return false;
    return error === code
        || error.startsWith(`${code}:`)
        || error.includes(`: ${code}`);
}

function hasAnyCode(error: string | null, codes: string[]): boolean {
    return codes.some((code) => hasCode(error, code));
}

/**
 * Map a ledger row to the reason shown to the user.
 *
 * With OCR entitlement a scan awaiting OCR is pending work, not an issue, so
 * `ocr_status = 'needed'` rows are only classified when the caller has no OCR
 * access; then they share the "scanned" group with extraction outcomes that
 * found no text in PDFs, since OCR is the remedy for both. Returns `null` for rows that
 * are not an issue from the user's point of view.
 */
export function classifyProcessingIssue(
    row: AttachmentProcessingIssueRow,
    entitlements: IssueEntitlements,
): ProcessingIssueReason | null {
    // Extraction retries can leave downstream statuses from the previous attempt.
    const extractTerminal = row.extractStatus === 'failed' || row.extractStatus === 'skipped';
    if (extractTerminal) {
        const error = row.lastError;
        if (hasAnyCode(error, FILE_UNAVAILABLE_CODES)) return 'file_unavailable';
        if (hasCode(error, 'encrypted')) return 'encrypted';
        if (hasAnyCode(error, TOO_LARGE_CODES)) return 'too_large';
        if (error && /(^|: )unsupported_/.test(error)) return 'unsupported';
        if (hasAnyCode(error, NO_TEXT_CODES)) {
            return row.contentKind === 'pdf' && !entitlements.hasOcrAccess ? 'scanned' : 'no_text';
        }
        return 'extract_failed';
    }

    if (row.upsertStatus === 'failed' && entitlements.hasSearchIndexAccess) return 'index_failed';
    if (row.ocrStatus === 'failed') {
        return hasAnyCode(row.lastError, FILE_UNAVAILABLE_CODES) ? 'file_unavailable' : 'ocr_failed';
    }
    if (row.ocrStatus === 'needed' && !entitlements.hasOcrAccess) return 'scanned';
    return null;
}

/** Order rows most recent first; ledger timestamps are ISO strings, queue ones epoch ms. */
function timestampValue(value: string | number | null): number {
    if (value == null) return 0;
    if (typeof value === 'number') return value;
    const parsed = Date.parse(value.endsWith('Z') ? value : `${value}Z`);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Group ledger rows and dead-lettered jobs by reason.
 *
 * A dead-lettered job whose attachment already has a terminal ledger row is
 * the same failure seen from the queue side, so the ledger row wins and the
 * dead letter is dropped; the rest join the group their job type implies.
 * Callers must filter recovered stages via getBackgroundDeadLetters's
 * onlyUnresolved option before passing historical queue failures here.
 */
export function groupProcessingIssues(
    rows: AttachmentProcessingIssueRow[],
    deadLetters: BackgroundQueueDeadRow[],
    entitlements: IssueEntitlements,
): ProcessingIssueGroup[] {
    const groups = new Map<ProcessingIssueReason, ProcessingIssueItem[]>();
    const seen = new Set<string>();
    const add = (reason: ProcessingIssueReason, item: ProcessingIssueItem) => {
        const key = `${item.libraryId}-${item.zoteroKey}`;
        if (seen.has(key)) return;
        seen.add(key);
        const list = groups.get(reason) ?? [];
        list.push(item);
        groups.set(reason, list);
    };

    for (const row of rows) {
        const reason = classifyProcessingIssue(row, entitlements);
        if (!reason) continue;
        add(reason, {
            libraryId: row.libraryId,
            zoteroKey: row.zoteroKey,
            error: row.lastError,
            timestamp: row.updatedAt,
        });
    }

    for (const dead of deadLetters) {
        if (dead.libraryId == null || !dead.zoteroKey) continue;
        if (dead.jobType === 'fulltext_upsert' && !entitlements.hasSearchIndexAccess) continue;
        const reason: ProcessingIssueReason | null = dead.jobType === 'fulltext_upsert'
            ? 'index_failed'
            : dead.jobType === 'document_ocr'
                ? 'ocr_failed'
                : dead.jobType === 'document_extract'
                    ? 'extract_failed'
                    : null;
        if (!reason) continue;
        add(reason, {
            libraryId: dead.libraryId,
            zoteroKey: dead.zoteroKey,
            error: dead.lastError,
            timestamp: dead.diedAt,
        });
    }

    return PROCESSING_ISSUE_REASON_ORDER
        .filter((reason) => groups.has(reason))
        .map((reason) => {
            const items = groups.get(reason)!
                .sort((a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp));
            return { reason, count: items.length, items };
        });
}
