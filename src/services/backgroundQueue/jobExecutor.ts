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
    | { kind: 'retry'; error: string; reason?: string; retryAfterMs?: number }
    | {
        kind: 'failPermanent';
        failure: DocumentProcessingFailureInput;
        reason?: string;
    }
    // Free the lane slot while leaving the queue row parked. The executor must
    // wake the row later, such as after a slot-free remote tracker settles.
    | { kind: 'defer'; reason: string };

export interface JobExecutor {
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
     * Release executor-owned work that outlives a single `execute()` call.
     */
    dispose?(): void;
}
