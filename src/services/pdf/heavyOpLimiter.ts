/**
 * Shared concurrency limiter for heavy MuPDF operations.
 *
 * MuPDF runs as synchronous WASM on Zotero's main thread (no worker), so each
 * full extraction / render / search call is a multi-hundred-ms CPU burst that
 * blocks the UI. The agent dispatcher (`agentService.ts`) fires every incoming
 * attachment request immediately with no queue, which under load means many
 * 10-100MB pdf buffers and many MuPDF documents coexist in the shared WASM
 * heap.
 *
 * `runHeavyPdfOp` gates the heavy section (loadPdfData + WASM call) of each
 * handler so at most 2 are in flight. As a rule, cache hits and standalone
 * metadata-only calls (getPageCount, getPageCountAndLabels, analyzeOCRNeeds)
 * MUST NOT be wrapped — they finish in <100ms and would suffer head-of-line
 * blocking behind a slow extract.
 *
 * Exception: a metadata call that runs *inside* an already-gated block (e.g.
 * page-label hydration on bytes that are about to be rendered) is fine — the
 * slot is held for the surrounding heavy work anyway, and splitting the gate
 * around it would just churn the limiter.
 *
 */

type Task<T> = () => Promise<T>;

function createLimiter(concurrency: number) {
    let active = 0;
    const queue: Array<() => void> = [];

    return async function run<T>(task: Task<T>): Promise<T> {
        // `while`, not `if`: a woken task must re-check the count in case
        // another caller acquired a slot between the wake-up and this point
        // (defensive against future intermediate-microtask call patterns).
        while (active >= concurrency) {
            await new Promise<void>((resolve) => queue.push(resolve));
        }
        active++;
        try {
            return await task();
        } finally {
            active--;
            const next = queue.shift();
            if (next) next();
        }
    };
}

export const runHeavyPdfOp = createLimiter(2);
