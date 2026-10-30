/**
 * Zotero's database runs one write transaction at a time, and any code in the
 * app (Zotero itself, another plugin, a bulk edit in the UI) can hold it. A
 * transaction that starts while another is open waits up to 30 seconds and
 * then fails with `Zotero.DBConnection.TimeoutError`, and items read while
 * another write is open can still change when it commits.
 *
 * The helpers here let Beaver wait for such a write before snapshotting items
 * or starting its own transaction, and report how long one has been open.
 *
 * Esbuild-safe: no `react/*` imports, no bare `addon`.
 */

/** How long Zotero itself waits for an open transaction before failing. */
export const ZOTERO_TRANSACTION_WAIT_MS = 30_000;

/**
 * How long to wait for another write before snapshotting items for a later
 * staleness check. Kept under the backend's validation timeout.
 */
export const SNAPSHOT_TRANSACTION_WAIT_MS = 15_000;

function getTimers(): { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } {
    // Plugin-realm timers keep firing when the window that started the wait closes.
    return typeof ChromeUtils !== 'undefined'
        ? ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs')
        : { setTimeout, clearTimeout };
}

function inTransaction(): boolean {
    try {
        return !!(Zotero as any).DB?.inTransaction?.();
    } catch {
        return false;
    }
}

/**
 * Tracks when the current Zotero transaction began, through Zotero's `begin`
 * callback. Transactions never overlap, so the latest begin is the open one.
 * Owned by the plugin realm (`Zotero.Beaver.transactionWatch`).
 */
export class OpenTransactionWatch {
    private callbackId: number | null = null;
    private lastBeginAt: number | null = null;

    start(): void {
        if (this.callbackId !== null) return;
        try {
            this.callbackId = (Zotero as any).DB.addCallback('begin', () => {
                this.lastBeginAt = Date.now();
            });
        } catch {
            this.callbackId = null;
        }
    }

    stop(): void {
        if (this.callbackId === null) return;
        try {
            (Zotero as any).DB.removeCallback('begin', this.callbackId);
        } catch {
            // The database may already be closed during shutdown.
        }
        this.callbackId = null;
        this.lastBeginAt = null;
    }

    /** How long the open transaction has run, or 0 when none is open or its start was not seen. */
    openAgeMs(now = Date.now()): number {
        if (!inTransaction() || this.lastBeginAt === null) return 0;
        return Math.max(0, now - this.lastBeginAt);
    }
}

/**
 * Wait until the open Zotero transaction has settled, commit callbacks
 * included, and no other is open, for at most `timeoutMs`. Resolves `true`
 * then, and `false` at the deadline, including when the transaction committed
 * but its callbacks are still running.
 *
 * The callbacks matter as much as the commit. They deliver the transaction's
 * Notifier events (observers may write to the same items) and then record
 * Zotero's undo entry for it, from a pending entry the next transaction's
 * begin discards. A transaction started before they finish loses the earlier
 * undo step, or hands its own partly staged entry to that late callback. This
 * is the wait Zotero's own `executeTransaction` performs.
 *
 * Another write can begin right after this returns, so a caller that then
 * opens a transaction must still handle Zotero's own wait timing out.
 */
export async function waitForOpenTransaction(timeoutMs: number): Promise<boolean> {
    if (!inTransaction()) return true;
    if (timeoutMs <= 0) return false;
    const timers = getTimers();
    const deadline = Date.now() + timeoutMs;
    while (inTransaction()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        // Taken while the transaction is open: once it commits, Zotero hands
        // out an already resolved promise, though its callbacks still run.
        const settled = Promise.resolve((Zotero as any).DB.waitForTransaction()).then(() => true, () => true);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finished = await Promise.race([
            settled,
            new Promise<false>((resolve) => { timer = timers.setTimeout(() => resolve(false), remaining); }),
        ]);
        if (timer !== undefined) timers.clearTimeout(timer);
        if (!finished) return false;
    }
    return true;
}

/** Whether `error` is Zotero's "timed out waiting for another transaction", which writes nothing. */
export function isZoteroTransactionTimeout(error: unknown): boolean {
    const TimeoutError = (Zotero as any).DBConnection?.TimeoutError;
    return typeof TimeoutError === 'function' && error instanceof TimeoutError;
}
