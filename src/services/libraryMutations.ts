interface QueuedMutation {
    owner?: string;
    start: () => Promise<void>;
    cancel: () => void;
}

/** Serializes complete library read/modify/write operations across renderer realms. */
export class LibraryMutations {
    constructor(
        private readonly pause: (token: string) => void = () => {},
        private readonly release: (token: string) => void = () => {},
    ) {}

    private queue: QueuedMutation[] = [];
    private closing = false;
    private closedOwners = new Set<string>();
    private sequence = 0;
    private active: string | null = null;
    private settlement: Promise<void> = Promise.resolve();

    getSnapshot() {
        return { pending: this.queue.length, active: this.active, closing: this.closing };
    }

    cancelOwner(owner: string): void {
        this.closedOwners.add(owner);
        for (const job of [...this.queue]) if (job.owner === owner) job.cancel();
    }

    run<T>(work: () => Promise<T>, options: MutationOptions = {}): Promise<T> {
        const token = `mutation:${++this.sequence}`;
        const cancelled = () => Object.assign(new Error('Library operation cancelled'), { code: 'operation_cancelled' });
        const assertAvailable = () => {
            if (this.closing || options.signal?.aborted || (options.owner && this.closedOwners.has(options.owner))) throw cancelled();
            options.assertCurrent?.();
        };
        try { assertAvailable(); } catch (error) { return Promise.reject(error); }
        return new Promise<T>((resolve, reject) => {
            const cleanup = () => options.signal?.removeEventListener('abort', job.cancel);
            const job: QueuedMutation = {
                owner: options.owner,
                cancel: () => {
                    const index = this.queue.indexOf(job);
                    if (index < 0) return;
                    this.queue.splice(index, 1);
                    cleanup();
                    reject(cancelled());
                },
                start: async () => {
                    cleanup();
                    this.active = token;
                    try {
                        assertAvailable();
                        this.pause(token);
                        // An active save retains the queue until it commits or rolls
                        // back. Cancellation must never race this promise.
                        resolve(await work());
                    } catch (error) {
                        reject(error);
                    } finally {
                        this.release(token);
                        this.active = null;
                    }
                },
            };
            this.queue.push(job);
            options.signal?.addEventListener('abort', job.cancel, { once: true });
            this.drain();
        });
    }

    private drain(): void {
        if (this.active || this.closing) return;
        const job = this.queue.shift();
        if (!job) return;
        this.settlement = job.start().then(() => { this.drain(); });
    }

    async dispose(): Promise<void> {
        this.closing = true;
        for (const job of [...this.queue]) job.cancel();
        await this.settlement;
        this.closedOwners.clear();
    }
}

export interface MutationOptions {
    owner?: string;
    signal?: AbortSignal;
    assertCurrent?: () => void;
}

/** Call at the outer operation boundary, before acquiring a table-specific lock. */
export function coordinateLibraryMutation<T>(work: () => Promise<T>, options?: MutationOptions): Promise<T> {
    const mutations = Zotero.Beaver?.mutations;
    if (!mutations) return Promise.reject(new Error('Library mutation service is unavailable'));
    const generation = Zotero.Beaver.account?.getGeneration();
    return mutations.run(work, {
        ...options,
        assertCurrent: () => {
            if (generation !== Zotero.Beaver.account?.getGeneration()) {
                throw Object.assign(new Error('Account changed'), { code: 'account_changed' });
            }
            options?.assertCurrent?.();
        },
    });
}
