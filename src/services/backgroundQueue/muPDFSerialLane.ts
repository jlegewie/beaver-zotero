/**
 * Serializes background MuPDF worker use: one user touches the background
 * worker at a time. Users are queued jobs (`run`) and interactive overflow
 * requests (`tryAcquire`), which never wait.
 *
 * Load-bearing even though each executor has its own `maxInFlight`: document
 * extraction and OCR are separate lanes with independent limits, so without
 * this mutex two of them could enter the background worker concurrently.
 *
 * Worker recycling is *not* this class's job — `MuPDFWorkerClient` retires the
 * background worker itself once it crosses its heap or completed-operation
 * threshold, which keeps poison-PDF suppression and the spawn/retry counters
 * alive across recycles.
 */
export class MuPDFSerialLane {
    private tail: Promise<void> = Promise.resolve();
    /** Holders plus waiters; 0 means the lane can be taken without waiting. */
    private users = 0;

    /** True when nobody holds or waits for the lane. */
    get isFree(): boolean {
        return this.users === 0;
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        const { previous, release } = this.enter();
        try {
            await previous;
            return await fn();
        } finally {
            release();
        }
    }

    /**
     * Take the lane only if it is free right now. Returns its release
     * function (idempotent), or null when the lane is held or waited for.
     */
    tryAcquire(): (() => void) | null {
        if (this.users > 0) return null;
        return this.enter().release;
    }

    private enter(): { previous: Promise<void>; release: () => void } {
        const previous = this.tail;
        let resolve!: () => void;
        this.tail = new Promise<void>((r) => {
            resolve = r;
        });
        this.users += 1;
        let released = false;
        return {
            previous,
            release: () => {
                if (released) return;
                released = true;
                this.users -= 1;
                resolve();
            },
        };
    }
}
