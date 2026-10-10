/**
 * Zotero write transactions that return once their data is committed.
 *
 * `Zotero.DB.executeTransaction` resolves only after its commit callbacks have
 * run, and one of them delivers the transaction's Notifier events to every
 * registered observer, one after another. An observer from another plugin that
 * waits on the network therefore holds every save for as long as it waits, and
 * one that never settles holds it forever. The helpers here wait for that
 * delivery for a short grace period after the commit, then return and let it
 * finish in the background.
 *
 * Zotero's UndoHistory keeps one pending entry for whichever transaction is
 * open and records it in a commit callback that runs after the observers,
 * without checking the transaction. So:
 * - Use these helpers only for writes that stage no native undo entry: a
 *   transaction that begins before the callback runs discards that entry.
 * - Before a Beaver write that does stage one (a native merge), call
 *   `waitForDeferredCommits`: a deferred write's late callback would otherwise
 *   record that write's partly staged entry and clear the rest.
 *
 * Other plugins' observers also write to the items they are told about
 * (citation keys, normalized fields), so those writes can land after a helper
 * has returned. Code that snapshots items for a later staleness check (action
 * validation) waits for deferred writes first, too.
 *
 * Esbuild-safe: no `react/*` imports, no bare `addon`.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import type { TimingAccumulator } from '../utils/timing';

/** How long a committed write waits for Notifier observers before returning. */
export const OBSERVER_GRACE_MS = 3000;

/** Post-commit delivery at least this slow is worth naming the active add-ons for. */
export const SLOW_OBSERVERS_MS = 1000;

/** Default bound for `waitForDeferredCommits`. */
export const DEFERRED_COMMIT_WAIT_MS = 30_000;

export interface CommittedTransactionOptions {
    /** Defaults to `OBSERVER_GRACE_MS`. */
    graceMs?: number;
    /**
     * Accumulates `tx_commit_ms` (start to commit), `post_commit_ms` (commit to
     * return) and `observers_deferred` (writes returned before their observers
     * finished).
     */
    timing?: TimingAccumulator;
    /** Names the write in logs. */
    label?: string;
}

type TransactionOptions = { onCommit?: (id: string) => unknown; [option: string]: unknown };
type ExecuteTransaction = (func: (...args: any[]) => unknown, options?: TransactionOptions) => Promise<unknown>;

interface CommitSignal {
    promise: Promise<void>;
    resolve: () => void;
    /** Time of the commit, or null while uncommitted. */
    at: number | null;
}

function commitSignal(): CommitSignal {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    const signal: CommitSignal = {
        promise,
        at: null,
        resolve: () => {
            if (signal.at === null) signal.at = Date.now();
            resolve();
        },
    };
    return signal;
}

function getTimers(): { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } {
    // Plugin-realm timers keep firing when the window that started the write closes.
    return typeof ChromeUtils !== 'undefined'
        ? ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs')
        : { setTimeout, clearTimeout };
}

/**
 * Wait for `write` to settle, but no longer than the grace period after its
 * commit. Resolves `true` when it settled, `false` when it was left running.
 * Rejects with the write's error if it fails within that window.
 */
async function settleAfterCommit(
    write: Promise<unknown>,
    commit: CommitSignal,
    startedAt: number,
    options: CommittedTransactionOptions,
): Promise<boolean> {
    const timers = getTimers();
    const graceMs = options.graceMs ?? OBSERVER_GRACE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const graceElapsed = commit.promise.then(() => new Promise<false>((resolve) => {
        if (!done) timer = timers.setTimeout(() => resolve(false), graceMs);
    }));
    let settled = false;
    try {
        settled = await Promise.race([write.then(() => true as const), graceElapsed]);
    } finally {
        done = true;
        if (timer !== undefined) timers.clearTimeout(timer);
        const returnedAt = Date.now();
        if (commit.at !== null) {
            options.timing?.record('tx_commit_ms', commit.at - startedAt);
            options.timing?.record('post_commit_ms', returnedAt - commit.at);
            options.timing?.record('observers_deferred', settled ? 0 : 1);
        }
    }
    if (!settled) {
        const label = options.label ?? 'transaction';
        const committedAt = commit.at!;
        logger(`committedTransaction: ${label} returned ${graceMs}ms after commit; Notifier observers are still running`, 1);
        deferredCommits().track(write.then(
            () => logger(`committedTransaction: ${label} observers finished ${Date.now() - committedAt}ms after commit`, 1),
            (error) => logger(`committedTransaction: ${label} failed after commit: ${error}`, 1),
        ));
    }
    return settled;
}

/**
 * Run `work` in a Zotero transaction and return its value once the
 * transaction has committed and either its Notifier observers have finished
 * or the grace period has passed.
 *
 * `work` runs inside the transaction: save with `item.save()`, not `saveTx()`.
 */
export async function runCommittedTransaction<T>(
    work: () => Promise<T>,
    options: CommittedTransactionOptions = {},
): Promise<T> {
    const startedAt = Date.now();
    const commit = commitSignal();
    let produced = false;
    let value!: T;
    const execute = Zotero.DB.executeTransaction as unknown as ExecuteTransaction;
    const write = execute.call(Zotero.DB, async () => {
        value = await work();
        produced = true;
        return value;
    }, { onCommit: () => commit.resolve() });
    try {
        await settleAfterCommit(write, commit, startedAt, options);
    } catch (error) {
        // A failure after the commit (in Zotero's own post-commit work) leaves the
        // data written; reporting it as failed would orphan the write.
        if (commit.at !== null && produced) {
            logger(`committedTransaction: ${options.label ?? 'transaction'} failed after commit: ${error}`, 1);
            return value;
        }
        throw error;
    }
    return value;
}

/**
 * Writes the helpers returned from before their commit callbacks finished.
 *
 * The plugin realm owns the instance (`Zotero.Beaver.deferredCommits`):
 * executes run there, while action validation runs in a window bundle and
 * must see the same writes.
 */
export class DeferredCommits {
    private readonly pending = new Set<Promise<void>>();

    /** Track `write` (which must not reject) until it settles. */
    track(write: Promise<void>): void {
        const tracked: Promise<void> = write.finally(() => this.pending.delete(tracked));
        this.pending.add(tracked);
    }

    /**
     * Wait until the writes deferred so far have finished their commit
     * callbacks, for at most `timeoutMs`. Resolves `false` when it gave up.
     *
     * A write still running after a full wait is treated as hung and no
     * longer waited for: one observer that never settles costs a single wait,
     * not one per later caller. Zotero never runs the remaining commit
     * callbacks of such a write either.
     */
    async wait(timeoutMs = DEFERRED_COMMIT_WAIT_MS): Promise<boolean> {
        const writes = [...this.pending];
        if (!writes.length) return true;
        const timers = getTimers();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([
            Promise.allSettled(writes).then(() => true),
            new Promise<false>((resolve) => { timer = timers.setTimeout(() => resolve(false), timeoutMs); }),
        ]);
        if (timer !== undefined) timers.clearTimeout(timer);
        if (!settled) {
            for (const write of writes) this.pending.delete(write);
            logger(`committedTransaction: stopped waiting for ${writes.length} write(s) still delivering Notifier events after ${timeoutMs}ms`, 1);
        }
        return settled;
    }
}

/** Fallback for code running without the plugin instance (tests). */
const localDeferredCommits = new DeferredCommits();

function deferredCommits(): DeferredCommits {
    return Zotero.Beaver?.deferredCommits ?? localDeferredCommits;
}

/**
 * Wait until writes the helpers returned from early have finished their
 * commit callbacks, for at most `timeoutMs` (see `DeferredCommits.wait`). Call
 * it before a transaction that stages a native undo entry and before
 * snapshotting items for a later staleness check.
 */
export function waitForDeferredCommits(timeoutMs = DEFERRED_COMMIT_WAIT_MS): Promise<boolean> {
    return deferredCommits().wait(timeoutMs);
}

let activeAddons: Promise<string | null> | null = null;

/**
 * `id@version` of every active non-system extension except Beaver, comma
 * separated, for attributing slow Notifier observers. Read once per session.
 */
export function describeActiveAddons(): Promise<string | null> {
    activeAddons ??= (async () => {
        try {
            if (typeof ChromeUtils === 'undefined') return null;
            const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs') as any;
            const { addons } = await AddonManager.getActiveAddons(['extension']);
            const ids = (addons as Array<{ id: string; version: string; isSystem?: boolean }>)
                .filter((addon) => !addon.isSystem && addon.id !== 'beaver@jlegewie.com')
                .map((addon) => `${addon.id}@${addon.version}`)
                .sort();
            return ids.join(',').slice(0, 2000);
        } catch (error) {
            logger(`committedTransaction: could not list active add-ons: ${error}`, 2);
            return null;
        }
    })();
    return activeAddons;
}
