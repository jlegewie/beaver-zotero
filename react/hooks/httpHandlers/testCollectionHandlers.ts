/**
 * Dev-only HTTP handlers for collection seeding and teardown.
 *
 * Collection-scoped search behavior (subcollection recursion, pagination inside
 * a scope) can only be verified against a hierarchy whose contents the test
 * controls, and no production endpoint creates collections. These handlers let
 * a live test build one and tear it down again:
 *
 * - `/beaver/test/collection-create` — create a collection, optionally nested
 *   under a parent, and add existing items to it.
 * - `/beaver/test/collection-delete` — erase collections (their items are left
 *   untouched; erasing a parent also erases its descendants).
 *
 * Handler exports are wired to paths in `useHttpEndpoints.ts` →
 * `registerEndpoints()`.
 */

import { checkLibraryExcluded } from "../../../src/services/agentDataProvider/utils";

/**
 * Pick up to `count` regular items from a library.
 *
 * Reads ids straight from a Zotero search so seeding a collection does not
 * depend on the search endpoints a test is about to assert against.
 */
async function regularItemKeys(libraryID: number, count: number): Promise<string[]> {
    const search = new Zotero.Search();
    search.addCondition('libraryID', 'is', String(libraryID));
    search.addCondition('itemType', 'isNot', 'attachment');
    search.addCondition('itemType', 'isNot', 'note');
    search.addCondition('itemType', 'isNot', 'annotation');
    const itemIDs = (await search.search()).slice(0, count);
    const items = await Zotero.Items.getAsync(itemIDs);
    return items.map((item) => item.key);
}

export async function handleTestCollectionCreateHttpRequest(request: any) {
    const { library_id, name, parent_key, item_keys, fill_regular_items } = request as {
        library_id?: number;
        name?: string;
        parent_key?: string;
        item_keys?: string[];
        fill_regular_items?: number;
    };
    if (!name) return { error: 'name is required' };

    const libraryID = typeof library_id === 'number' ? library_id : Zotero.Libraries.userLibraryID;
    const excluded = checkLibraryExcluded(libraryID);
    if (excluded)
        return {
            ok: false,
            error: excluded.message,
            error_code: "library_excluded",
        };

    const collection = new Zotero.Collection({ libraryID, name, parentKey: parent_key });
    await collection.saveTx();

    // Seeding failures are reported rather than thrown: the collection already
    // exists at this point, and only the response carries the key its creator
    // needs to delete it again.
    const addedKeys: string[] = [];
    let error: string | undefined;
    try {
        const keys = item_keys?.length
            ? item_keys
            : fill_regular_items
                ? await regularItemKeys(libraryID, fill_regular_items)
                : [];

        const items = (await Promise.all(
            keys.map((key) => Zotero.Items.getByLibraryAndKeyAsync(libraryID, key))
        )).filter((item): item is Zotero.Item => !!item);
        // addItems reads each item's current collections, which
        // getByLibraryAndKeyAsync does not load.
        await Zotero.Items.loadDataTypes(items, ['collections']);

        // One transaction for the batch. These are the user's real items, so
        // the membership change is kept local: addItems skips the dateModified
        // bump, and skipSyncedUpdate keeps it from being pushed to zotero.org
        // (teardown erases the collection, restoring the original membership).
        await Zotero.DB.executeTransaction(() =>
            collection.addItems(items.map((item) => item.id), { skipSyncedUpdate: true })
        );
        addedKeys.push(...items.map((item) => item.key));
    } catch (e) {
        error = e instanceof Error ? e.message : String(e);
    }

    return {
        ok: !error,
        error,
        library_id: libraryID,
        collection_key: collection.key,
        collection_id: collection.id,
        name,
        added_item_keys: addedKeys,
    };
}

export async function handleTestCollectionDeleteHttpRequest(request: any) {
    const { library_id, collection_keys } = request as {
        library_id?: number;
        collection_keys?: string[];
    };
    if (!Array.isArray(collection_keys)) return { error: 'collection_keys is required' };

    const libraryID = typeof library_id === 'number' ? library_id : Zotero.Libraries.userLibraryID;
    const excluded = checkLibraryExcluded(libraryID);
    if (excluded)
        return {
            ok: false,
            error: excluded.message,
            error_code: "library_excluded",
        };

    const deleted: string[] = [];
    for (const key of collection_keys) {
        const collection = Zotero.Collections.getByLibraryAndKey(libraryID, key);
        if (!collection) continue;
        await (collection as Zotero.Collection).eraseTx();
        deleted.push(key);
    }

    return { ok: true, deleted };
}
