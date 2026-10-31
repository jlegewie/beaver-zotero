/**
 * Helpers for reading Zotero items whose library may not be loaded yet.
 *
 * Zotero registers every item id at startup but only loads a library's item
 * objects when the library is first opened (or something else requests it).
 * Until then, synchronous lookups — `Zotero.Items.get`, `getByLibraryAndKey`,
 * `item.parentItem`, `item.isInTrash()` on child items — throw
 * `UnloadedDataException: Item N not yet loaded`. Use the async helpers here
 * on paths that may reach items the user has not opened this session.
 *
 * React-free and safe for both bundles.
 */

import { logger } from '@beaver/agent-core/platform/logger';

/**
 * Load all items of the given libraries, the same way Zotero does when a
 * library is first opened. Afterwards every item in those libraries is cached
 * with all of its data types, so synchronous lookups and field reads succeed.
 *
 * Use before synchronous code that resolves arbitrary item references (e.g.
 * citation expansion). Libraries that are already loaded cost nothing; a
 * large unopened library takes as long as opening it in Zotero. Never throws:
 * failures are logged and callers fall through to their own not-found paths.
 * Returns the ids of the libraries this call loaded.
 */
export async function ensureLibraryItemsLoaded(
    libraryIds: Iterable<number | null | undefined>,
): Promise<number[]> {
    const unique = new Set<number>();
    for (const id of libraryIds) {
        if (typeof id === 'number' && Number.isInteger(id) && id > 0) unique.add(id);
    }
    const loaded: number[] = [];
    await Promise.all([...unique].map(async (libraryId) => {
        try {
            if (!Zotero.Libraries.exists(libraryId)) return;
            const library = Zotero.Libraries.get(libraryId);
            if (!library || library.getDataLoaded('item')) return;
            await library.waitForDataLoad('item');
            loaded.push(libraryId);
        } catch (error) {
            logger(`ensureLibraryItemsLoaded: failed to load items for library ${libraryId}: ${error}`, 1);
        }
    }));
    return loaded;
}

/**
 * Async `item.parentItem`: loads the parent if it is not cached yet.
 */
export async function getParentItemAsync(item: Zotero.Item): Promise<Zotero.Item | null> {
    const parentID = item.parentID;
    if (!parentID) return null;
    return (await Zotero.Items.getAsync(parentID)) || null;
}

/**
 * Async `item.isInTrash()`: whether the item or any ancestor is in the trash,
 * loading uncached ancestors instead of throwing.
 */
export async function isInTrashAsync(item: Zotero.Item): Promise<boolean> {
    let current: Zotero.Item | null = item;
    while (current) {
        if (current.deleted) return true;
        current = await getParentItemAsync(current);
    }
    return false;
}

/** Whether an error is Zotero's `UnloadedDataException`. */
export function isUnloadedDataError(error: unknown): boolean {
    return (error as { name?: unknown } | null)?.name === 'UnloadedDataException';
}

/**
 * Run a synchronous read of an item's data, reloading the given data types
 * once if Zotero reports them as unloaded. Zotero clears an item's loaded
 * flags when it reloads the item (e.g. after a sync or another write), so data
 * loaded at the start of a long async pass can be gone by the time it is read.
 */
export async function readWithDataReload<T>(
    item: Zotero.Item,
    dataTypes: string[],
    read: () => T,
): Promise<T> {
    try {
        return read();
    } catch (error) {
        if (!isUnloadedDataError(error)) throw error;
        await Zotero.Items.loadDataTypes([item], dataTypes);
        return read();
    }
}

/**
 * IDs of a file attachment's annotations, in Zotero's order, as a new array.
 * The attachment's `childItems` data must be loaded.
 *
 * Zotero 9 added `getAnnotations(includeTrashed, asIDs)`. Zotero 7 and 8
 * ignore `asIDs` and return items, which requires the library's items to be
 * cached. Never pass that result to `Zotero.Items.getAsync`: it reads each item
 * as `NaN`, the load fails with "no such column: NaN", and on Zotero 7 the
 * failed load leaves every later `getAsync` waiting until Zotero restarts.
 */
export async function getAnnotationIDs(
    attachment: Zotero.Item,
    includeTrashed = false,
): Promise<number[]> {
    const read = () =>
        attachment
            .getAnnotations(includeTrashed, true)
            .map((annotation) => (typeof annotation === 'number' ? annotation : annotation.id));
    try {
        return read();
    } catch (error) {
        if (!isUnloadedDataError(error)) throw error;
        await ensureLibraryItemsLoaded([attachment.libraryID]);
        return read();
    }
}

/**
 * Run a synchronous read of an item's data, returning `fallback` when Zotero
 * reports the data as unloaded. For render paths that cannot await a load;
 * pair with {@link loadItemDisplayData} so the real value follows.
 */
export function readOrFallback<T>(read: () => T, fallback: T): T {
    try {
        return read();
    } catch (error) {
        if (isUnloadedDataError(error)) return fallback;
        throw error;
    }
}

/**
 * Whether reading an item's display label would throw because its data (or
 * its parent) is not loaded. An item from a library that has not been opened
 * this session carries only primary data until something loads the rest.
 */
export function hasUnloadedDisplayData(item: Zotero.Item): boolean {
    try {
        item.getDisplayTitle();
        void item.parentItem;
        return false;
    } catch (error) {
        return isUnloadedDataError(error);
    }
}

/**
 * Load the data synchronous label reads need: all data types of the given
 * items and of their parents. Items and parents are deduplicated and loaded
 * in one batch, and only data types that are not loaded yet are read, so
 * cached objects — and any unsaved edits on them — are left alone (unlike
 * `item.loadAllData()`, which re-queries every type). Never throws: failures
 * are logged and labels keep their fallback.
 */
export async function loadItemDisplayData(items: Zotero.Item[]): Promise<void> {
    try {
        const parentIds = [...new Set(items.map(item => item.parentID).filter((id): id is number => !!id))];
        const parents = parentIds.length > 0 ? await Zotero.Items.getAsync(parentIds) : [];
        const unique = new Map<number, Zotero.Item>();
        for (const object of [...items, ...parents]) {
            if (object) unique.set(object.id, object);
        }
        await Zotero.Items.loadDataTypes([...unique.values()]);
    } catch (error) {
        logger(`loadItemDisplayData: failed to load data for ${items.length} item(s): ${error}`, 1);
    }
}
