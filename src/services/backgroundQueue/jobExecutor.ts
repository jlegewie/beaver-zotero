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
    | { kind: 'retry'; error: string; reason?: string }
    | {
        kind: 'failPermanent';
        failure: DocumentProcessingFailureInput;
        reason?: string;
    };

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
}
