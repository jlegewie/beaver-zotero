import type {
    AttachmentProcessingAggregates,
    BackgroundProcessingFailureSummary,
    BackgroundQueueStats,
} from '../database';
import type { DocumentCacheStats } from '../documentCache';
import type { IndexStatusResponse } from '../searchIndex/searchIndexApiClient';
import { searchIndexApiClient } from '../searchIndex/searchIndexApiClient';
import { getZoteroUserIdentifier } from '../../utils/zoteroUtils';

/** Entitlements the snapshot's shape depends on. */
export interface ProcessingStatusEntitlements {
    hasOcrAccess: boolean;
    hasSearchIndexAccess: boolean;
}

export interface ProcessingStatusOptions {
    /** Fetch cloud-index coverage (only meaningful with search-index access). */
    includeCoverage?: boolean;
    /** Fetch the recent-failures list (three-way union across tables). */
    includeFailures?: boolean;
    /** Restrict ledger aggregates to one library; omit for all libraries. */
    libraryId?: number;
}

/**
 * One background-processing status read: queue counts, ledger aggregates,
 * failures, cloud coverage and local cache size.
 *
 * Entitlements arrive as parameters rather than being read here so the React
 * hook can pass store-derived values while the dev endpoint passes the
 * `Zotero.Beaver` mirrors. Fields the caller did not ask for come back
 * `undefined`, which callers distinguish from "asked and got nothing" (`null`).
 */
export async function collectProcessingStatus(
    entitlements: ProcessingStatusEntitlements,
    options: ProcessingStatusOptions = {},
): Promise<{
    queue: BackgroundQueueStats;
    ledger: AttachmentProcessingAggregates;
    failures: BackgroundProcessingFailureSummary[] | undefined;
    coverage: IndexStatusResponse | null | undefined;
    documentCache: DocumentCacheStats | null;
}> {
    const db = Zotero.Beaver?.db;
    if (!db) throw new Error('db not available');
    const { hasOcrAccess, hasSearchIndexAccess } = entitlements;
    const [queue, ledger, failures, coverage, documentCache] = await Promise.all([
        db.getBackgroundQueueStats(Date.now()),
        db.getAttachmentProcessingAggregates(options.libraryId, {
            ocr: hasOcrAccess || hasSearchIndexAccess,
            upsert: hasSearchIndexAccess,
        }),
        options.includeFailures
            ? db.getBackgroundProcessingFailures(50)
            : Promise.resolve(undefined),
        options.includeCoverage && hasSearchIndexAccess
            ? searchIndexApiClient.status(getZoteroUserIdentifier().localUserKey)
                .catch(() => null)
            : Promise.resolve(undefined),
        Zotero.Beaver?.documentCache?.getStats().catch(() => null)
            ?? Promise.resolve(null),
    ]);
    return { queue, ledger, failures, coverage, documentCache };
}
