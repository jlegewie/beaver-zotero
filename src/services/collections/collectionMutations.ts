import { libraryRefForLibraryID, parseItemReference } from '../../utils/libraryIdentity';
import { CollectionResolutionError, resolveCollection, resolveCollectionList, type ResolvedCollection } from './collectionIdentity';

/** Check write access again at execution, including actions restored from history. */
export function assertCollectionLibraryWritable(libraryID: number): void {
    if (!Zotero.Beaver?.libraryScopeInitialized || !Zotero.Beaver.searchableLibraryIds?.includes(libraryID)) {
        throw new CollectionResolutionError('library_not_searchable', 'The target library is not accessible to Beaver.');
    }
    const library = Zotero.Libraries.get(libraryID);
    if (!library) throw new CollectionResolutionError('library_unavailable', 'The target library is unavailable.');
    if (!libraryRefForLibraryID(libraryID)) throw new CollectionResolutionError('library_unavailable', 'The target library has no portable identity. Make the intended library available and retry.');
    if (!library.editable) throw Object.assign(new Error('The target library is read-only.'), { code: 'library_not_editable' });
}

/** Writes require every requested membership to resolve before approval. */
export function resolveCollectionMemberships(inputs: readonly string[], libraryID: number): ResolvedCollection[] {
    const result = resolveCollectionList(inputs, { libraryID });
    if (result.failures.length) throw result.failures[0].error;
    return result.collections;
}

/** Native execution keys are exact identities, never names to resolve again. */
export function recheckCollection(input: string, libraryID: number, includeTrashed = false): ResolvedCollection {
    assertCollectionLibraryWritable(libraryID);
    return resolveCollection(parseItemReference(input) ? input : `${libraryID}-${input}`, { libraryID, includeTrashed });
}

export function recheckCollectionMemberships(inputs: readonly string[], libraryID: number): ResolvedCollection[] {
    assertCollectionLibraryWritable(libraryID);
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
