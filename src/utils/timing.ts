/**
 * Lightweight timing accumulator for diagnosing async performance.
 *
 * Tracks cumulative wall-clock time across parallel operations, grouped by
 * named buckets. Because parallel branches are timed independently,
 * the sum of all buckets may exceed wall-clock time — this is intentional
 * and shows total CPU-time per operation type.
 *
 * Usage:
 *   const ta = new TimingAccumulator();
 *   const [a, b] = await Promise.all([
 *       ta.track('serialize', () => serializeItem(item)),
 *       ta.track('attachments', () => processAttachments(item)),
 *   ]);
 *   console.log(ta.getAll()); // { serialize: 45, attachments: 120 }
 */
export class TimingAccumulator {
    private buckets = new Map<string, number>();

    /** Time an async operation and accumulate its duration under `name`. */
    async track<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const start = Date.now();
        try {
            return await fn();
        } finally {
            this.buckets.set(name, (this.buckets.get(name) ?? 0) + (Date.now() - start));
        }
    }

    /** Get cumulative ms for a single bucket. */
    get(name: string): number {
        return this.buckets.get(name) ?? 0;
    }

    /** Get all buckets as a plain object (suitable for JSON serialization). */
    getAll(): Record<string, number> {
        return Object.fromEntries(this.buckets);
    }
}
