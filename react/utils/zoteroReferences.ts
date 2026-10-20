/**
 * Zotero-side constructors for the reference DTOs defined in
 * `@beaver/agent-core/types/zotero`. They read live Zotero state — the `Zotero.Collection`
 * type and this device's library resolution — which is why they live here and
 * not next to the DTOs, so that module stays Zotero-free.
 */
import { serializeCollectionReadIdentity } from '../../src/services/collections/collectionIdentity';
import { libraryRefForLibraryID, resolveObjectId } from '../../src/utils/libraryIdentity';
import type { CollectionReference, ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { SPECIAL_COLLECTION_TYPES, type ViewAttachment } from '@beaver/agent-core/types/attachments/apiTypes';

/**
 * Parses a model-facing item id: either a portable `<library_ref>-<zotero_key>`
 * (`u-KEY`, `g<groupID>-KEY`) or a legacy `<libraryID>-zoteroKey`. Returns
 * `null` for `ext-<KEY>` external-file ids and other malformed input.
 */
export function createZoteroItemReference(id: string): ZoteroItemReference | null {
    return resolveObjectId(id);
}

/** A selected saved search or built-in view, as the collections pane reports it. */
export interface ViewSelection {
    /** Collections-tree row type: 'search' or a built-in view type. */
    type: string;
    name: string;
    libraryId: number;
    /** Search key, for saved searches. */
    key?: string;
}

/**
 * Build the message attachment for a selected saved search or built-in view.
 * Returns null for a row that cannot be attached: a saved search that no
 * longer exists, or a view type requests cannot be scoped to.
 */
export function viewToAttachment(view: ViewSelection): ViewAttachment | null {
    const libraryRef = libraryRefForLibraryID(view.libraryId) ?? undefined;
    if (view.type === 'search') {
        if (!view.key) return null;
        const search = Zotero.Searches.getByLibraryAndKey(view.libraryId, view.key) as Zotero.Search | false;
        if (!search || search.deleted) return null;
        return {
            type: 'saved_search',
            library_id: view.libraryId,
            zotero_key: view.key,
            ...(libraryRef ? { library_ref: libraryRef } : {}),
            name: search.name || view.name,
        };
    }
    if (!(SPECIAL_COLLECTION_TYPES as readonly string[]).includes(view.type)) return null;
    return {
        type: 'special_collection',
        special_collection: view.type,
        library_id: view.libraryId,
        ...(libraryRef ? { library_ref: libraryRef } : {}),
        name: view.name,
    };
}

/** Build a CollectionReference from a live Zotero collection. */
export function collectionToReference(collection: Zotero.Collection): CollectionReference {
    return {
        library_id: collection.libraryID,
        zotero_key: collection.key,
        ...serializeCollectionReadIdentity(collection),
        parent_key: collection.parentKey || null,
    };
}
