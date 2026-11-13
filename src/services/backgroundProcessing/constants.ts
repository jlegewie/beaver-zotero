export const BACKGROUND_EXTRACT_PRIORITY = 110;
export const BACKGROUND_UPSERT_PRIORITY = 115;
export const BACKGROUND_UNTAG_PRIORITY = 80;
/**
 * Extraction requested by the embedding index for items with short abstracts.
 * The 100-104 band runs when Zotero is idle even with background processing
 * off; in that case its jobs only read local files.
 */
export const EMBEDDING_EXTRACT_PRIORITY = 102;
/** Upper bound (exclusive) of the local extraction band that starts at 100. */
export const LOCAL_EXTRACT_PRIORITY_CEILING = 105;

export const PROCESSING_RECONCILE_INTERVAL_MS = 5 * 60_000;
export const FULL_DIFF_SAFETY_INTERVAL_MS = 7 * 24 * 60 * 60_000;
export const INDEX_RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;
export const ATTACHMENT_SCAN_BATCH_SIZE = 250;

/** Frontend's minimum accepted backend chunk/index generation. */
export const EXPECTED_SEARCH_INDEX_VERSION = 3;
