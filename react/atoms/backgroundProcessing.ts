import { atom } from 'jotai';
import type {
    AttachmentProcessingAggregates,
    BackgroundQueueStats,
    BackgroundProcessingFailureSummary,
} from '../../src/services/database';
import type { IndexStatusResponse } from '../../src/services/searchIndex/searchIndexApiClient';
import type { DocumentCacheStats } from '../../src/services/documentCache';
import type { ProcessingIssueSummary } from '../../src/services/backgroundProcessing/issues';
import type { BackgroundWorkerSnapshot } from '../../src/services/backgroundProcessing/statusSnapshot';

export interface BackgroundProcessingStatus {
    queue: BackgroundQueueStats;
    ledger: AttachmentProcessingAggregates;
    coverage: IndexStatusResponse | null;
    coverageUpdatedAt: number | null;
    coverageError: string | null;
    failures: BackgroundProcessingFailureSummary[];
    /** Attachments that could not be processed, grouped by user-facing reason. */
    issues: ProcessingIssueSummary[];
    /** Dispatcher activity at the last read; null until first read. */
    worker: BackgroundWorkerSnapshot | null;
    /** Local extraction-cache size and budget; null until first read. */
    documentCache: DocumentCacheStats | null;
    error: string | null;
    updatedAt: number | null;
}

export const EMPTY_BACKGROUND_QUEUE_STATS: BackgroundQueueStats = {
    pending: 0,
    available: 0,
    deferred: 0,
    dead: 0,
    byJobType: {},
};

export const EMPTY_ATTACHMENT_PROCESSING_AGGREGATES: AttachmentProcessingAggregates = {
    total: 0,
    readable: 0,
    unreadable: 0,
    awaitingOcr: 0,
    extracted: 0,
    ocrNeeded: 0,
    ocrDone: 0,
    upserted: 0,
    failed: 0,
    skipped: 0,
    oldestPendingAt: null,
};

export const backgroundProcessingStatusAtom = atom<BackgroundProcessingStatus>({
    queue: EMPTY_BACKGROUND_QUEUE_STATS,
    ledger: EMPTY_ATTACHMENT_PROCESSING_AGGREGATES,
    coverage: null,
    coverageUpdatedAt: null,
    coverageError: null,
    failures: [],
    issues: [],
    worker: null,
    documentCache: null,
    error: null,
    updatedAt: null,
});
