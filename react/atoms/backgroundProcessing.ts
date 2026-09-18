import type { ProcessingProgress } from '../../src/services/backgroundProcessing/progress';
import { atom } from 'jotai';
import type { SearchReadinessStatus } from '../../src/services/searchIndex/instanceSearchReadiness';
import type {
    AttachmentProcessingAggregates,
    BackgroundQueueStats,
    BackgroundProcessingFailureSummary,
} from '../../src/services/database';
import type { DocumentCacheStats } from '../../src/services/documentCache';
import type { ProcessingIssueSummary } from '../../src/services/backgroundProcessing/issues';
import type { BackgroundWorkerSnapshot } from '../../src/services/backgroundProcessing/statusSnapshot';

export interface BackgroundProcessingStatus {
    searchReadiness?: SearchReadinessStatus;
    progress: ProcessingProgress | null;
    queue: BackgroundQueueStats;
    ledger: AttachmentProcessingAggregates;
    failures: BackgroundProcessingFailureSummary[];
    /** Attachments that could not be processed, grouped by user-facing reason. */
    issues: ProcessingIssueSummary[];
    /** Last successful refresh that included issue counts, rather than only general status. */
    issuesUpdatedAt: number | null;
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
    attachments: 0,
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

export const EMPTY_BACKGROUND_PROCESSING_STATUS: BackgroundProcessingStatus = {
    progress: null,
    queue: EMPTY_BACKGROUND_QUEUE_STATS,
    ledger: EMPTY_ATTACHMENT_PROCESSING_AGGREGATES,
    failures: [],
    issues: [],
    issuesUpdatedAt: null,
    worker: null,
    documentCache: null,
    error: null,
    updatedAt: null,
};

export const backgroundProcessingStatusAtom = atom<BackgroundProcessingStatus>(EMPTY_BACKGROUND_PROCESSING_STATUS);
