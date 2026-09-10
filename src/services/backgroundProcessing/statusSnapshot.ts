import type {
    AttachmentProcessingAggregates,
    BackgroundProcessingFailureSummary,
    BackgroundQueueStats,
} from '../database';
import type { DocumentCacheStats } from '../documentCache';
import type { ProcessingIssueSummary } from './issues';
import type { IndexStatusResponse } from '../searchIndex/searchIndexApiClient';
import { searchIndexApiClient } from '../searchIndex/searchIndexApiClient';
import { getZoteroUserIdentifier } from '../../utils/zoteroUtils';
import { getUncachedCandidates } from './cachePreparation';

/** Entitlements the snapshot's shape depends on. */
export interface ProcessingStatusEntitlements {
    hasOcrAccess: boolean;
    hasSearchIndexAccess: boolean;
}

export interface ProcessingStatusOptions {
    /** Fetch cloud-index coverage (only meaningful with search-index access). */
    includeCoverage?: boolean;
    /**
     * Fetch the recent-failures list (three-way union across tables) and the
     * reason-grouped issues the preferences UI renders.
     */
    includeFailures?: boolean;
    /** Restrict ledger aggregates to one library; omit for all libraries. */
    libraryId?: number;
}

/** Dispatcher activity at read time, for the status sentence. */
export interface BackgroundWorkerSnapshot {
    /** A dispatcher precondition preventing new jobs from starting. */
    dispatchBlocker: string | null;
    /** Available and deferred jobs restricted to registered, entitled lanes. */
    available: number;
    deferred: number;
    /** Jobs currently running across all lanes. */
    inFlight: number;
    /** A one-off "process now" is bypassing the idle gate until the queue drains. */
    drainNow: boolean;
    /** Queued backlog work may run right now (idle, continuous, or draining). */
    backlogGateOpen: boolean;
}

/**
 * One background-processing status read: queue counts, ledger aggregates,
 * failures and reason-grouped issues, worker activity, cloud coverage and
 * local cache size.
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
    issues: ProcessingIssueSummary[] | undefined;
    worker: BackgroundWorkerSnapshot;
    coverage: IndexStatusResponse | null | undefined;
    documentCache: DocumentCacheStats | null;
}> {
    const db = Zotero.Beaver?.db;
    if (!db) throw new Error('db not available');
    const { hasOcrAccess, hasSearchIndexAccess } = entitlements;
    const [queue, ledger, failures, issues, coverage, documentCache] = await Promise.all([
        db.getBackgroundQueueStats(Date.now()),
        db.getAttachmentProcessingAggregates(options.libraryId, {
            ocr: hasOcrAccess,
            upsert: hasSearchIndexAccess,
        }),
        options.includeFailures
            ? db.getBackgroundProcessingFailures(50)
            : Promise.resolve(undefined),
        options.includeFailures
            ? db.getProcessingIssueCounts(entitlements)
            : Promise.resolve(undefined),
        options.includeCoverage && hasSearchIndexAccess
            ? searchIndexApiClient.status(getZoteroUserIdentifier().localUserKey)
                .catch(() => null)
            : Promise.resolve(undefined),
        Zotero.Beaver?.documentCache?.getStats().catch(() => null)
            ?? Promise.resolve(null),
    ]);
    if (documentCache) {
        documentCache.can_prepare_uncached_files = (await getUncachedCandidates(documentCache, true)).length > 0;
    }
    const extractor = Zotero.Beaver?.backgroundExtractor;
    const lanes = extractor?.getLaneStatus?.() ?? {};
    const activeTypes = Object.keys(lanes).filter((type) =>
        (type !== 'fulltext_upsert' || hasSearchIndexAccess)
        && (type !== 'document_ocr' || hasOcrAccess));
    const activeQueue = await db.getBackgroundQueueStats(Date.now(), activeTypes);
    const worker: BackgroundWorkerSnapshot = {
        dispatchBlocker: extractor?.getDispatchBlocker?.() ?? null,
        available: activeQueue.available,
        deferred: activeQueue.deferred,
        inFlight: Object.values(lanes).reduce((sum, lane) => sum + (lane?.inFlight ?? 0), 0),
        drainNow: extractor?.isImmediateDrainRequested?.() ?? false,
        backlogGateOpen: extractor?.isBacklogGateOpen?.() ?? false,
    };
    return { queue, ledger, failures, issues, worker, coverage, documentCache };
}
