/**
 * Race `promise` against an absolute deadline (epoch milliseconds).
 *
 * Work that outlives the deadline is not cancelled; it finishes unobserved, so
 * its failure is caught here rather than going unhandled.
 */
export async function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | 'timeout'> {
    promise.catch(() => undefined);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'timeout';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), remaining); }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
