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

/**
 * Execution-time error for a collection that validated but is gone by the time
 * the write runs (typically deleted while the action awaited approval). The
 * model's arguments were correct, so it must not retry with other IDs.
 */
export function collectionDeletedSinceValidationMessage(role: 'Collection' | 'Parent collection', reference: string): string {
    return `${role} ${reference} was deleted after this action was validated (for example while it awaited approval), so no changes were applied. `
        + 'Do not retry this action or look for a replacement collection; tell the user and ask how to proceed.';
}

export interface RecheckOptions {
    /** Exact recorded targets only, for explicit undo/restore operations. */
    includeTrashed?: boolean;
}

/** Native execution keys are exact identities, never names to resolve again. */
export function recheckCollection(input: string, libraryID: number, { includeTrashed = false }: RecheckOptions = {}): ResolvedCollection {
    // A resolved collection always carries a portable identity, so every
    // collection recheck needs one — only tag-only paths may relax this.
    assertLibraryWritable(libraryID);
    // A bare key is qualified with the target library so it resolves exactly
    // rather than by name; the caller's own reference is what errors quote.
    return resolveCollection(parseItemReference(input) ? input : `${libraryID}-${input}`,
        { libraryID, includeTrashed, displayReference: input });
}

export function recheckCollectionMemberships(inputs: readonly string[], libraryID: number): ResolvedCollection[] {
    assertLibraryWritable(libraryID);
    return inputs.map(input => recheckCollection(input, libraryID));
}

/**
 * Recheck recorded memberships, dropping collections that no longer exist.
 *
 * A remove target that vanished already holds the requested state. An add
 * target can vanish after approval, or when a redo recreates the collection
 * under a new key; the write then proceeds without that membership rather than
 * discarding the item, note or tag changes it was requested alongside. Access
 * and editability failures still propagate.
 */
export function recheckExistingCollections(inputs: readonly string[], libraryID: number): ResolvedCollection[] {
    assertLibraryWritable(libraryID);
    return inputs
        .map(input => recheckCollectionIfPresent(input, libraryID))
        .filter((entry): entry is ResolvedCollection => entry !== null);
}

/**
 * Recheck a recorded membership for undo.
 *
 * Undo is the user's escape hatch, so it resolves trashed collections (whose
 * memberships still exist) and reports a collection that is gone entirely as
 * "nothing to restore" rather than failing the whole undo and stranding the
 * action in `applied` with no way back.
 */
export function recheckCollectionForUndo(input: string, libraryID: number): ResolvedCollection | null {
    return recheckCollectionIfPresent(input, libraryID, { includeTrashed: true });
}

/**
 * `recheckCollection`, but a collection that no longer exists yields `null`.
 * Access and library errors still propagate: only "gone" is tolerated.
 */
export function recheckCollectionIfPresent(input: string, libraryID: number, options?: RecheckOptions): ResolvedCollection | null {
    try {
        return recheckCollection(input, libraryID, options);
    } catch (error) {
        if (error instanceof CollectionResolutionError && error.code === 'collection_not_found') return null;
        throw error;
    }
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
