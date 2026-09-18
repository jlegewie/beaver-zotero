import { libraryRefForLibraryID, parseItemReference, resolveItemReference } from '../../utils/libraryIdentity';
import { CollectionResolutionError, resolveCollection, resolveCollectionList, type ResolvedCollection } from './collectionIdentity';

/** Check write access again at execution, including actions restored from history. */
export function assertLibraryWritable(libraryID: number, { requirePortable = true }: { requirePortable?: boolean } = {}): void {
    if (!Zotero.Beaver?.libraryScopeInitialized || !Zotero.Beaver.searchableLibraryIds?.includes(libraryID)) {
        throw new CollectionResolutionError('library_not_searchable', 'The target library is not accessible to Beaver.');
    }
    const library = Zotero.Libraries.get(libraryID);
    if (!library) throw new CollectionResolutionError('library_unavailable', 'The target library is unavailable.');
    if (requirePortable && !libraryRefForLibraryID(libraryID)) throw new CollectionResolutionError('library_unavailable', 'The target library has no portable identity. Make the intended library available and retry.');
    if (!library.editable) throw new CollectionResolutionError('library_not_editable', 'The target library is read-only.');
}

/** Writes require every requested membership to resolve before approval. */
export function resolveCollectionMemberships(inputs: readonly string[], libraryID: number): ResolvedCollection[] {
    const result = resolveCollectionList(inputs, { libraryID });
    if (result.failures.length) throw result.failures[0].error;
    return result.collections;
}

/** Native execution keys are exact identities, never names to resolve again. */
export function recheckCollection(input: string, libraryID: number, includeTrashed = false): ResolvedCollection {
    assertLibraryWritable(libraryID);
    return resolveCollection(parseItemReference(input) ? input : `${libraryID}-${input}`, { libraryID, includeTrashed });
}

export function recheckCollectionMemberships(inputs: readonly string[], libraryID: number): ResolvedCollection[] {
    assertLibraryWritable(libraryID);
    return inputs.map(input => recheckCollection(input, libraryID));
}

/** Recheck move constraints after approval and before undoing a move. */
export function recheckCollectionParent(collection: Zotero.Collection, parent: string | null | undefined): string | null {
    if (!parent) return null;
    const target = recheckCollection(parent, collection.libraryID).collection;
    if (target.id === collection.id || collection.getDescendents(false, 'collection', false).some(entry => entry.id === target.id)) {
        throw new Error('Cannot move a collection into itself or a descendant.');
    }
    return target.key;
}

/** Check surviving item libraries before any organize mutation begins. */
export async function resolveOrganizeLibrary(itemIds: readonly string[], hasCollections: boolean): Promise<number | null> {
    const libraries = new Set<number>();
    for (const id of new Set(itemIds)) {
        const parsed = parseItemReference(id);
        if (!parsed) continue;
        const resolved = await resolveItemReference(parsed);
        if (resolved.status !== 'found') continue;
        assertLibraryWritable(resolved.item.libraryID);
        libraries.add(resolved.item.libraryID);
    }
    if (hasCollections && libraries.size > 1) {
        throw new CollectionResolutionError('library_collection_mismatch', 'Collection changes require all items to be in the same library.');
    }
    return libraries.size === 1 ? [...libraries][0] : null;
}
