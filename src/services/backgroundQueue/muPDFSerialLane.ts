/**
 * Serializes background MuPDF worker use: one queued job touches the
 * background worker at a time.
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

    async run<T>(fn: () => Promise<T>): Promise<T> {
        const previous = this.tail.catch(() => undefined);
        let release!: () => void;
        this.tail = new Promise<void>((resolve) => {
            release = resolve;
        });

        await previous;
        try {
            return await fn();
        } finally {
            release();
        }
    }
}
