/**
 * Zotero-side constructors for the reference DTOs defined in
 * `@beaver/agent-core/types/zotero`. They read live Zotero state — the `Zotero.Collection`
 * type and this device's library resolution — which is why they live here and
 * not next to the DTOs, so that module stays Zotero-free.
 */
import { serializeCollectionReadIdentity } from '../../src/services/collections/collectionIdentity';
import { resolveObjectId } from '../../src/utils/libraryIdentity';
import type { CollectionReference, ZoteroItemReference } from '@beaver/agent-core/types/zotero';

/**
 * Parses a model-facing item id: either a portable `<library_ref>-<zotero_key>`
 * (`u-KEY`, `g<groupID>-KEY`) or a legacy `<libraryID>-zoteroKey`. Returns
 * `null` for `ext-<KEY>` external-file ids and other malformed input.
 */
export function createZoteroItemReference(id: string): ZoteroItemReference | null {
    return resolveObjectId(id);
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
