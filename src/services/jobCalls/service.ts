/**
 * `addon.jobCalls`: this device's job calls, kept until each job's result has
 * reached the backend.
 *
 * A job call is a table fill that an agent tool started and that may outlive
 * the run that waits for it: the run parks the call and ends, and the job
 * goes on in Zotero. When the job ends, this service stores its result on the
 * parked call (the parked-call result endpoint), and announces the stored
 * result so the window that has been waiting on the job resumes the run.
 *
 * It is the only code that stores job results. Entries are persisted, so a
 * result the device could not report before a quit is reported at the next
 * start: a job that ended has its result kept with the entry; one that was cut
 * off gets an interrupted result derived from local state.
 *
 * A job whose result reached its run live (the run waited for it) needs no
 * stored result: the window that saw the tool call return drops the entry. Posting a
 * result the run already has is harmless: the backend answers `busy` while
 * that run lasts and `gone` after it.
 */

import type {
    JobKind,
    JobResult,
    StoredJobCall,
    StoreJobResultOutcome,
} from '@beaver/agent-core/protocol/jobCallProtocol';

/** A job call as this device keeps it. */
export interface JobCallEntry {
    threadId: string;
    toolCallId: string;
    /** The account the job ran for; only that account posts it. */
    userId: string;
    kind: JobKind;
    jobId: string;
    /** What the job covers, to derive a result after a restart (per kind). */
    coverage: Record<string, unknown>;
    /** The job's result once it ended, until it is stored. */
    result: JobResult | null;
    createdAt: string;
}

export interface JobCallStorage {
    upsert(entry: JobCallEntry): Promise<void>;
    setResult(entry: JobCallEntry, result: JobResult): Promise<void>;
    delete(entry: JobCallEntry): Promise<void>;
    list(): Promise<JobCallEntry[]>;
}

/** The endpoint's answer, `not_found` for a thread the account cannot reach. */
export type PostOutcome = StoreJobResultOutcome | 'not_found';

export interface JobCallDeps {
    storage: JobCallStorage;
    /** Stores a result; throws on a network or server error (retried). */
    post(entry: JobCallEntry, result: JobResult): Promise<PostOutcome>;
    /** The signed-in user, or null. */
    userId(): string | null;
    /** Subscribe to account changes; a newly signed-in account posts its kept results. */
    subscribeAccount?(listener: () => void): () => void;
    /**
     * Whether the account's library scope is known. Exclusion checks fail
     * closed before then, so results are neither derived nor posted until it is.
     */
    ready?(): boolean;
    /** Whether this device still runs the job (a live job reports its own end). */
    isLive(kind: JobKind, jobId: string): boolean;
    /** The result of a job cut off by a quit, derived from local state; null when it cannot be. */
    deriveInterrupted(entry: JobCallEntry): Promise<JobResult | null>;
    /**
     * The result as it may leave the device now; null when nothing of it may.
     * A result kept through an outage or a restart is checked again here,
     * since a library may have been excluded meanwhile.
     */
    sendable(entry: JobCallEntry, result: JobResult): JobResult | null;
    /** A result was stored on its parked call. */
    onStored(stored: StoredJobCall): void;
    /** The jobs some window waits on changed (see {@link InstanceJobCalls.setWaiting}). */
    onWaitersChanged?(jobIds: string[]): void;
    /** Whether the plugin is shutting down: results are kept, not posted. */
    shuttingDown(): boolean;
    setTimer(callback: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
    now(): number;
    log(message: string): void;
}

/** Retry delays for `busy` and transient failures: doubles from the first to the cap. */
export const RETRY_FIRST_MS = 3_000;
export const RETRY_MAX_MS = 60_000;

function entryKey(threadId: string, toolCallId: string): string {
    return `${threadId}\u0000${toolCallId}`;
}

interface Pending {
    entry: JobCallEntry;
    attempt: number;
    timer?: unknown;
    posting: boolean;
}

export class InstanceJobCalls {
    private entries = new Map<string, Pending>();
    private loaded: Promise<void> | null = null;
    private writes = new Set<Promise<unknown>>();
    private disposed = false;
    private unsubscribeAccount?: () => void;
    /** The job each window waits on, by window id. */
    private waiters = new Map<string, string>();

    constructor(private readonly deps: JobCallDeps) {}

    /**
     * Load the persisted entries and report every job this device is not
     * running any more: a result kept from before a quit is posted, and a job
     * cut off before it could end gets a derived interrupted result.
     */
    start(): Promise<void> {
        if (!this.loaded) {
            this.loaded = this.load();
            let userId = this.deps.userId();
            let ready = this.isReady();
            this.unsubscribeAccount = this.deps.subscribeAccount?.(() => {
                const next = this.deps.userId();
                const nowReady = this.isReady();
                if (next === userId && nowReady === ready) return;
                const becameReady = nowReady && (!ready || next !== userId);
                userId = next;
                ready = nowReady;
                if (next && becameReady) void this.loaded?.then(() => this.resume());
            });
        }
        return this.loaded;
    }

    private async load(): Promise<void> {
        let stored: JobCallEntry[] = [];
        try {
            stored = await this.deps.storage.list();
        } catch (error) {
            this.deps.log(`jobCalls: could not read job calls: ${String(error)}`);
            return;
        }
        for (const entry of stored) {
            const key = entryKey(entry.threadId, entry.toolCallId);
            if (this.entries.has(key)) continue;
            this.entries.set(key, { entry, attempt: 0, posting: false });
        }
        await this.resume();
    }

    /** Post every entry of the signed-in account that is ready to post. */
    async resume(): Promise<void> {
        // Resumed again once the library scope is known.
        if (!this.isReady()) return;
        const userId = this.deps.userId();
        for (const pending of [...this.entries.values()]) {
            const { entry } = pending;
            if (entry.userId !== userId) continue;
            if (!entry.result) {
                if (this.deps.isLive(entry.kind, entry.jobId)) continue;
                const derived = await this.deps.deriveInterrupted(entry).catch((error) => {
                    this.deps.log(`jobCalls: could not derive the result of ${entry.jobId}: ${String(error)}`);
                    return null;
                });
                if (!derived) {
                    this.deps.log(`jobCalls: no result could be derived for ${entry.jobId}; keeping it`);
                    continue;
                }
                await this.keepResult(pending, derived);
            }
            this.schedule(pending, 0);
        }
    }

    /** A job call started: keep it until its result is stored or delivered live. */
    async register(entry: Omit<JobCallEntry, 'result' | 'createdAt' | 'userId'> & { userId?: string }): Promise<void> {
        const userId = entry.userId ?? this.deps.userId();
        if (!userId || this.disposed) return;
        const full: JobCallEntry = {
            ...entry,
            userId,
            result: null,
            createdAt: new Date(this.deps.now()).toISOString(),
        };
        const key = entryKey(full.threadId, full.toolCallId);
        const held = this.entries.get(key);
        // A tool call is one job: a replayed start of the same job keeps its entry.
        if (held && held.entry.jobId === full.jobId) return;
        if (held) this.cancel(held);
        this.entries.set(key, { entry: full, attempt: 0, posting: false });
        await this.track(this.deps.storage.upsert(full));
    }

    /** A job ended: keep its result with every call it answers, and post it. */
    async jobEnded(kind: JobKind, jobId: string, result: JobResult): Promise<void> {
        const matching = [...this.entries.values()].filter(
            (pending) => pending.entry.kind === kind && pending.entry.jobId === jobId,
        );
        for (const pending of matching) {
            await this.keepResult(pending, result);
            if (!this.deps.shuttingDown()) this.schedule(pending, 0);
        }
    }

    /** The run that waited for the job received its result: nothing is left to store. */
    delivered(threadId: string, toolCallId: string): void {
        const pending = this.entries.get(entryKey(threadId, toolCallId));
        if (!pending) return;
        this.drop(pending);
    }

    /** A run on the thread ended: retry its `busy` results now. */
    retryThread(threadId: string): void {
        for (const pending of this.entries.values()) {
            if (pending.entry.threadId !== threadId || !pending.entry.result || pending.posting) continue;
            if (pending.entry.userId !== this.deps.userId()) continue;
            this.schedule(pending, 0);
        }
    }

    /** A window waits on a job (`jobId`), or no longer waits on any (`null`). */
    setWaiting(windowId: string, jobId: string | null): void {
        if (jobId ? this.waiters.get(windowId) === jobId : !this.waiters.has(windowId)) return;
        if (jobId) this.waiters.set(windowId, jobId);
        else this.waiters.delete(windowId);
        this.deps.onWaitersChanged?.(this.waitedJobs());
    }

    /** The jobs some window waits on. */
    waitedJobs(): string[] {
        return [...new Set(this.waiters.values())];
    }

    /** The job call this device keeps for a tool call, if any. */
    get(threadId: string, toolCallId: string): JobCallEntry | null {
        return this.entries.get(entryKey(threadId, toolCallId))?.entry ?? null;
    }

    list(): JobCallEntry[] {
        return [...this.entries.values()].map((pending) => pending.entry);
    }

    /** Wait for the writes in flight, e.g. the results kept at shutdown. */
    async flush(): Promise<void> {
        while (this.writes.size) await Promise.allSettled([...this.writes]);
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        this.unsubscribeAccount?.();
        for (const pending of this.entries.values()) this.cancel(pending);
        await this.flush();
    }

    private isReady(): boolean {
        return this.deps.ready?.() ?? true;
    }

    private async keepResult(pending: Pending, result: JobResult): Promise<void> {
        pending.entry = { ...pending.entry, result };
        await this.track(this.deps.storage.setResult(pending.entry, result));
    }

    private schedule(pending: Pending, delayMs: number): void {
        if (this.disposed || !pending.entry.result) return;
        this.cancel(pending);
        pending.timer = this.deps.setTimer(() => {
            pending.timer = undefined;
            void this.post(pending);
        }, delayMs);
    }

    private cancel(pending: Pending): void {
        if (pending.timer !== undefined) this.deps.clearTimer(pending.timer);
        pending.timer = undefined;
    }

    private retryLater(pending: Pending): void {
        const delay = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** pending.attempt);
        pending.attempt += 1;
        this.schedule(pending, delay);
    }

    private async post(pending: Pending): Promise<void> {
        const { entry } = pending;
        const result = entry.result;
        if (!result || pending.posting || this.disposed || this.deps.shuttingDown()) return;
        if (this.entries.get(entryKey(entry.threadId, entry.toolCallId)) !== pending) return;
        // Another account's result waits for that account to sign in again;
        // any result waits for the library scope (resumed then).
        if (entry.userId !== this.deps.userId() || !this.isReady()) return;
        const outbound = this.deps.sendable(entry, result);
        if (!outbound) {
            this.deps.log(`jobCalls: the result of ${entry.jobId} may no longer leave the device; dropping it`);
            this.drop(pending);
            return;
        }
        pending.posting = true;
        let outcome: PostOutcome;
        try {
            outcome = await this.deps.post(entry, outbound);
        } catch (error) {
            pending.posting = false;
            this.deps.log(`jobCalls: storing the result of ${entry.jobId} failed, retrying: ${String(error)}`);
            this.retryLater(pending);
            return;
        }
        pending.posting = false;
        // Dropped meanwhile (delivered live, replaced by another job).
        if (this.entries.get(entryKey(entry.threadId, entry.toolCallId)) !== pending) return;
        switch (outcome) {
            case 'stored':
                this.drop(pending);
                this.deps.onStored({
                    threadId: entry.threadId,
                    toolCallId: entry.toolCallId,
                    kind: entry.kind,
                    jobId: entry.jobId,
                    userId: entry.userId,
                    result: outbound,
                });
                return;
            case 'busy':
                this.retryLater(pending);
                return;
            case 'gone':
            case 'not_found':
                this.deps.log(`jobCalls: the call of ${entry.jobId} is no longer open (${outcome}); dropping its result`);
                this.drop(pending);
                return;
        }
    }

    private drop(pending: Pending): void {
        this.cancel(pending);
        const key = entryKey(pending.entry.threadId, pending.entry.toolCallId);
        if (this.entries.get(key) === pending) this.entries.delete(key);
        this.track(this.deps.storage.delete(pending.entry));
    }

    private track<T>(promise: Promise<T>): Promise<T | undefined> {
        const tracked = promise.catch((error) => {
            this.deps.log(`jobCalls: storage failed: ${String(error)}`);
            return undefined;
        });
        this.writes.add(tracked);
        void tracked.finally(() => this.writes.delete(tracked));
        return tracked;
    }
}
