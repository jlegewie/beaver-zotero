import type {
    BackgroundJobInput,
    BackgroundJobRecord,
    BackgroundJobType,
    DocumentProcessingFailureInput,
} from '../database';

export type QueueDB = NonNullable<typeof Zotero.Beaver.db>;

export interface JobExecutionContext {
    db: QueueDB;
    runOnMuPDFWorker<T>(fn: () => Promise<T>): Promise<T>;
    externalAbortSignal: AbortSignal;
    shouldSkipDbWrites(): boolean;
    enqueue(input: BackgroundJobInput): Promise<void>;
}

export type JobOutcome =
    | { kind: 'complete'; reason: string }
    | { kind: 'release'; reason: string }
    | {
        kind: 'retry'; error: string; reason?: string; retryAfterMs?: number;
        /** Only document failures consume the finite attempt budget. */
        countsAsAttempt?: boolean;
        /** Pause new claims in this lane as well as delaying this job. */
        laneCooldownMs?: number;
    }
    | {
        kind: 'failPermanent';
        failure: DocumentProcessingFailureInput;
        reason?: string;
    }
    // Free the lane slot while leaving the queue row parked. The executor must
    // wake the row later, such as after a slot-free remote tracker settles.
    | { kind: 'defer'; reason: string };

export interface JobExecutor {
    /** Remote work being tracked without occupying a local lane slot. */
    getRemoteWaitingCount?(): number;
    readonly jobType: BackgroundJobType;
    execute(
        record: BackgroundJobRecord,
        ctx: JobExecutionContext,
    ): Promise<JobOutcome>;
    describeFailure?(
        record: BackgroundJobRecord,
        error: string,
    ): DocumentProcessingFailureInput | null;
    /**
     * Quiesce executor-owned work that outlives `execute()` without making the
     * executor unusable when the dispatcher resumes after maintenance.
     */
    suspend?(): void | Promise<void>;
    /**
     * Release executor-owned work that outlives a single `execute()` call.
     */
    dispose?(): void;
}
