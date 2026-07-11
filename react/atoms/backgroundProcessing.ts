import { atom } from 'jotai';
import type {
    AttachmentProcessingAggregates,
    BackgroundQueueStats,
    BackgroundProcessingFailureSummary,
} from '../../src/services/database';
import type { IndexStatusResponse } from '../../src/services/searchIndex/searchIndexApiClient';

export interface BackgroundProcessingStatus {
    queue: BackgroundQueueStats;
    ledger: AttachmentProcessingAggregates;
    coverage: IndexStatusResponse | null;
    failures: BackgroundProcessingFailureSummary[];
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
    failures: [],
    error: null,
    updatedAt: null,
});
