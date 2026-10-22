/**
 * Recovery for a Zotero tag cache that no longer matches the `tags` table.
 *
 * `Zotero.Tags` maps tag names to IDs in memory, and every tag write goes
 * through that map. `Zotero.Tags.create` adds a new tag to it as soon as it is
 * inserted, not when its transaction commits, and nothing undoes that on
 * rollback. A rolled-back transaction that created a tag therefore leaves a
 * name mapped to an ID with no row; the reverse (a row whose name the map has
 * lost) also occurs. Every later save of that tag name then fails, until
 * Zotero restarts:
 * - mapped ID without a row: `FOREIGN KEY constraint failed` on `itemTags`
 * - row without a mapping: `UNIQUE constraint failed: tags.name`
 * - removing such a tag: `Invalid boolean parameter` (tagID `false`) on `itemTags`
 *
 * Rebuilding the map from the database (`Zotero.Tags.init`) repairs it.
 *
 * Esbuild-safe: no `react/*` imports, no bare `addon`.
 */

import { logger } from '@beaver/agent-core/platform/logger';

/** `error_code` for a write that failed on a stale tag cache. */
export const TAG_CACHE_ERROR_CODE = 'tag_cache_out_of_sync';

const TAG_CACHE_ERROR_PATTERNS = [
    /FOREIGN KEY constraint failed[\s\S]*\bitemTags\b/,
    /UNIQUE constraint failed: tags\.name/,
    /Invalid boolean parameter[\s\S]*\bitemTags\b/,
];

function errorText(error: unknown): string {
    if (typeof error === 'string') return error;
    const message = (error as { message?: unknown } | null)?.message;
    return typeof message === 'string' ? message : String(error);
}

/** Whether a failed write's error comes from a stale `Zotero.Tags` cache. */
export function isTagCacheError(error: unknown): boolean {
    const text = errorText(error);
    return TAG_CACHE_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

// Concurrent callers share one rebuild.
let pendingRebuild: Promise<void> | null = null;
let pendingQueuedRebuild: Promise<void> | null = null;

/**
 * Reload `Zotero.Tags` from the database.
 *
 * `Zotero.Tags.init` clears the map before reading the table, so it runs in
 * its own transaction: no other write can create a tag against the empty map
 * meanwhile. Call only from work already running in the library mutation
 * queue (and outside a transaction); elsewhere use `rebuildTagCacheQueued`.
 */
export function rebuildTagCache(): Promise<void> {
    if (!pendingRebuild) {
        pendingRebuild = Promise.resolve()
            .then(() => Zotero.DB.executeTransaction(() => Zotero.Tags.init()))
            .then(() => undefined)
            .finally(() => { pendingRebuild = null; });
    }
    return pendingRebuild;
}

/**
 * `rebuildTagCache` for callers outside the library mutation queue (action
 * validation). A transaction that begins while another Beaver write is still
 * delivering its Notifier events discards that write's pending native undo
 * entry (see `committedTransaction`), so the rebuild waits its turn.
 */
export function rebuildTagCacheQueued(): Promise<void> {
    if (!pendingQueuedRebuild) {
        pendingQueuedRebuild = Promise.resolve()
            .then(() => Zotero.Beaver.libraryOperations.run('rebuildTagCache', []))
            .finally(() => { pendingQueuedRebuild = null; });
    }
    return pendingQueuedRebuild;
}

export interface TagCacheRepairOptions {
    /**
     * Checks run after the rebuild, before the save is retried. The rebuild
     * can wait on other transactions, so access and cancellation checks made
     * before the first attempt no longer hold.
     */
    beforeRetry?: () => void;
}

/**
 * Run a tag-writing save, and if it fails on a stale tag cache, rebuild the
 * cache and run it once more. Call only from work running in the library
 * mutation queue.
 *
 * `save` must be safe to repeat after a rollback: it builds new objects or
 * re-applies its changes to objects Zotero reloaded when their save failed.
 */
export async function withTagCacheRepair<T>(
    save: () => Promise<T>,
    label: string,
    { beforeRetry }: TagCacheRepairOptions = {},
): Promise<T> {
    try {
        return await save();
    } catch (error) {
        if (!isTagCacheError(error) || (error as { committed?: boolean } | null)?.committed) throw error;
        logger(`tagCache: ${label} failed on a stale tag cache, rebuilding and retrying: ${errorText(error)}`, 1);
        await rebuildTagCache();
        beforeRetry?.();
        return await save();
    }
}

/**
 * Model-facing message for an action that failed on a stale tag cache after
 * the cache was rebuilt: the arguments were fine, so one retry is expected to
 * succeed.
 */
export function tagCacheErrorMessage(repaired: boolean): string {
    return repaired
        ? 'Zotero\'s tag list was out of sync with its database, so no changes were applied. Beaver has refreshed it. '
            + 'This was not caused by the action\'s arguments: retry the same action once. If it fails again, ask the user to restart Zotero.'
        : 'Zotero\'s tag list is out of sync with its database, so no changes were applied. '
            + 'This was not caused by the action\'s arguments: do not retry; ask the user to restart Zotero.';
}
