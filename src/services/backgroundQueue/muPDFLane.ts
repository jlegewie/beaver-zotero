import { disposeMuPDFWorker } from '../../beaver-extract';
import { logger } from '../../utils/logger';

/**
 * Serializes background MuPDF worker use and recycles the worker after a
 * fixed number of completed worker operations.
 */
export class MuPDFLane {
    private tail: Promise<void> = Promise.resolve();
    private completedSinceRecycle = 0;

    constructor(private readonly recycleAfter: number) {}

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
            try {
                await this.afterWorkerOperation();
            } finally {
                release();
            }
        }
    }

    private async afterWorkerOperation(): Promise<void> {
        this.completedSinceRecycle += 1;
        if (this.completedSinceRecycle < this.recycleAfter) return;
        try {
            await disposeMuPDFWorker('background');
        } catch (e) {
            logger(`MuPDFLane: recycle disposeMuPDFWorker failed: ${e}`, 1);
        }
        this.completedSinceRecycle = 0;
    }
}
