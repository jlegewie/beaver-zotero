import type {
    IndexDocumentRef,
    IndexUntagResult,
    SearchIndexApiClient,
} from '../searchIndex/searchIndexApiClient';

/** Refs per `POST /index/delete`; the backend claims documents in batches of this size. */
export const UNTAG_BATCH_MAX_REFS = 100;
/** A batch is sent once no new ref has joined it for this long... */
const UNTAG_BATCH_SETTLE_MS = 50;
/** ...or this long after its first ref, whichever comes first. */
const UNTAG_BATCH_MAX_WAIT_MS = 500;
/** Untag requests in flight at once, across all batches. */
const UNTAG_MAX_CONCURRENT_REQUESTS = 2;

/** One ref's outcome plus how its whole batch fared. */
export interface UntagBatchResult {
    /** The server's result for this ref; absent when the response omitted it. */
    result?: IndexUntagResult;
    /** True when no ref in the batch was untagged or busy. */
    batchFailed: boolean;
}

interface Entry {
    ref: IndexDocumentRef;
    /** True once the job no longer wants its ref sent. */
    cancelled: () => boolean;
    resolve: (result: UntagBatchResult) => void;
    reject: (error: unknown) => void;
}

interface Batch {
    key: string;
    accountId: string;
    zoteroLocalId: string;
    entries: Entry[];
    openedAt: number;
    timer?: ReturnType<typeof setTimeout>;
}

function accountChangedError(): Error {
    return Object.assign(new Error('Account changed before the cleanup request was sent'), {
        code: 'ACCOUNT_CHANGED',
    });
}

function abortError(): Error {
    return Object.assign(new Error('Cleanup batching stopped'), { name: 'AbortError' });
}

/**
 * Merges the refs of concurrently running cleanup jobs into shared
 * `POST /index/delete` requests. Each job still owns its queue row and
 * outcome; it only waits for its ref's entry in the shared response.
 */
export class UntagBatcher {
    private readonly open = new Map<string, Batch>();
    private readonly ready: Batch[] = [];
    private inFlight = 0;
    private closed = false;

    /**
     * @param isRejectedRequest True for an error that rejects the request as a
     *     whole, such as one malformed ref failing validation. Such a batch is
     *     retried one ref per request, so only the offending ref gets the error.
     */
    constructor(
        private readonly api: Pick<SearchIndexApiClient, 'untag'>,
        private readonly isRejectedRequest: (error: unknown) => boolean = () => false,
    ) {}

    /**
     * Queue one ref for untagging under `accountId`. Rejects with the request's
     * error; with an `ACCOUNT_CHANGED` error when the signed-in account changed
     * before the batch was sent; or with an `AbortError` when `cancelled`
     * returns true before then, in which case the ref is never sent.
     */
    untag(
        accountId: string,
        zoteroLocalId: string,
        ref: IndexDocumentRef,
        cancelled: () => boolean = () => false,
    ): Promise<UntagBatchResult> {
        if (this.closed) return Promise.reject(abortError());
        return new Promise<UntagBatchResult>((resolve, reject) => {
            const key = `${accountId}\n${zoteroLocalId}`;
            let batch = this.open.get(key);
            if (!batch) {
                batch = { key, accountId, zoteroLocalId, entries: [], openedAt: Date.now() };
                this.open.set(key, batch);
            }
            batch.entries.push({ ref, cancelled, resolve, reject });
            if (batch.entries.length >= UNTAG_BATCH_MAX_REFS) {
                this.seal(batch);
                return;
            }
            if (batch.timer !== undefined) clearTimeout(batch.timer);
            const remaining = UNTAG_BATCH_MAX_WAIT_MS - (Date.now() - batch.openedAt);
            const sealed = batch;
            batch.timer = setTimeout(() => this.seal(sealed), Math.max(0, Math.min(UNTAG_BATCH_SETTLE_MS, remaining)));
        });
    }

    /** Reject every ref not yet sent; requests already in flight still settle. */
    close(): void {
        this.closed = true;
        const pending = [...this.open.values(), ...this.ready.splice(0)];
        this.open.clear();
        for (const batch of pending) {
            if (batch.timer !== undefined) clearTimeout(batch.timer);
            for (const entry of batch.entries) entry.reject(abortError());
        }
    }

    private seal(batch: Batch): void {
        if (this.open.get(batch.key) !== batch) return;
        this.open.delete(batch.key);
        if (batch.timer !== undefined) clearTimeout(batch.timer);
        this.ready.push(batch);
        this.pump();
    }

    private pump(): void {
        while (this.inFlight < UNTAG_MAX_CONCURRENT_REQUESTS && this.ready.length > 0) {
            void this.send(this.ready.shift()!);
        }
    }

    private async send(batch: Batch): Promise<void> {
        this.inFlight += 1;
        const entries: Entry[] = [];
        for (const entry of batch.entries) {
            if (entry.cancelled()) entry.reject(abortError());
            else entries.push(entry);
        }
        try {
            if (entries.length === 0) return;
            // Requests authenticate as the signed-in account; never send one
            // account's refs under another's session.
            if (Zotero.Beaver?.account?.getSnapshot().session?.user.id !== batch.accountId) {
                throw accountChangedError();
            }
            const response = await this.api.untag(batch.zoteroLocalId, entries.map((entry) => entry.ref));
            // Results come back in request order.
            const results = entries.map((_, index) => response.results[index]);
            const batchFailed = results.every((result) => !result || result.outcome === 'failed');
            entries.forEach((entry, index) => entry.resolve({ result: results[index], batchFailed }));
        } catch (error) {
            if (entries.length > 1 && this.isRejectedRequest(error)) {
                // Nothing in the request was processed; retry each ref alone.
                this.ready.unshift(...entries.map((entry) => ({ ...batch, entries: [entry], timer: undefined })));
            } else {
                for (const entry of entries) entry.reject(error);
            }
        } finally {
            this.inFlight -= 1;
            this.pump();
        }
    }
}
