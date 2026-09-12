/** Bounded admission for a single worker; queued cancellation never touches active work. */
export class DocumentWorkQueue {
    private active = false;
    private closed = false;
    private waiting: { start(): void; cancel(): void }[] = [];

    constructor(private readonly maxQueued = 32) {}

    run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (this.closed || signal?.aborted)
            return Promise.reject(this.abortError());
        if (this.active && this.waiting.length >= this.maxQueued) {
            return Promise.reject(
                Object.assign(new Error("The document work queue is full"), {
                    name: "WorkerQueueFullError",
                }),
            );
        }
        return new Promise<T>((resolve, reject) => {
            const entry = {
                start: () => {
                    signal?.removeEventListener("abort", entry.cancel);
                    this.active = true;
                    let pending: Promise<T>;
                    try {
                        pending = work();
                    } catch (error) {
                        pending = Promise.reject(error);
                    }
                    pending.then(resolve, reject).finally(() => {
                        this.active = false;
                        this.waiting.shift()?.start();
                    });
                },
                cancel: () => {
                    const index = this.waiting.indexOf(entry);
                    if (index >= 0) this.waiting.splice(index, 1);
                    signal?.removeEventListener("abort", entry.cancel);
                    reject(this.abortError());
                },
            };
            if (this.active) {
                this.waiting.push(entry);
                signal?.addEventListener("abort", entry.cancel, { once: true });
            } else entry.start();
        });
    }
    close(): void {
        this.closed = true;
        for (const entry of this.waiting.splice(0)) entry.cancel();
    }
    get queued(): number {
        return this.waiting.length;
    }
    private abortError(): Error {
        return Object.assign(new Error("Document work cancelled"), {
            name: "WorkerAbortError",
        });
    }
}
