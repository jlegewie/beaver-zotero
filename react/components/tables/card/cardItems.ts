import type { TableCardLibraryScope } from '@beaver/agent-core/protocol/tableCardProtocol';
import type { ZoteroTag } from '@beaver/agent-core/types/zotero';
import type { MessageFiltersState } from '../../../atoms/messageComposition';
import type { SourcesMenuEntries } from '../../ui/menus/hooks/useSourcesMenu';
import { libraryRefForLibraryID, resolveLibraryRef } from '../../../../src/utils/libraryIdentity';

/** The Add Sources menu's rows for a table: papers, collections and tags, added rather than filtered. */
export const TABLE_MENU_ENTRIES: SourcesMenuEntries = { libraries: false, notes: false, files: false, scopeVerb: 'add' };

/** A table's item search runs everywhere, not in the scopes it already has. */
export const NO_SEARCH_FILTERS: MessageFiltersState = { libraryIds: [], collectionIds: [], tagSelections: [] };

/**
 * The collections and tags a table already has, as the menu's filter state:
 * read only, for the checkmarks.
 */
export function scopeMenuFilters(scopes: readonly TableCardLibraryScope[]): MessageFiltersState {
    const collectionIds: number[] = [];
    const tagSelections: ZoteroTag[] = [];
    for (const scope of scopes) {
        const libraryId = resolveLibraryRef({ library_ref: scope.library_ref });
        if (!libraryId) continue;
        if (scope.kind === 'collection' && scope.key) {
            const collection = Zotero.Collections.getByLibraryAndKey(libraryId, scope.key) as Zotero.Collection | false;
            if (collection) collectionIds.push(collection.id);
        } else if (scope.kind === 'tag' && scope.tag) {
            const id = Zotero.Tags.getID(scope.tag);
            if (id) tagSelections.push({ id, tag: scope.tag, libraryId, type: 0, color: '' });
        }
    }
    return { libraryIds: [], collectionIds, tagSelections };
}

/** The collection a menu pick names, as a source scope; null when it cannot be one. */
export function pickedCollectionScope(collectionId: number): TableCardLibraryScope | null {
    const collection = Zotero.Collections.get(collectionId) as Zotero.Collection | false;
    const ref = collection ? libraryRefForLibraryID(collection.libraryID) : null;
    return collection && ref ? { kind: 'collection', library_ref: ref, key: collection.key, name: collection.name } : null;
}

/** The tag a menu pick names, as a source scope. */
export function pickedTagScope(tag: ZoteroTag): TableCardLibraryScope | null {
    const ref = libraryRefForLibraryID(tag.libraryId);
    return ref ? { kind: 'tag', library_ref: ref, tag: tag.tag } : null;
}

/** The regular item a pick stands for: itself, or a child attachment's parent. */
export function paperOf(item: Zotero.Item): Zotero.Item | null {
    if (item.isRegularItem()) return item;
    if (item.isAttachment() && item.parentItemID) {
        const parent = Zotero.Items.get(item.parentItemID) as Zotero.Item | false;
        return parent && parent.isRegularItem() ? parent : null;
    }
    return null;
}

export function portableItemId(item: Zotero.Item): string | null {
    const ref = libraryRefForLibraryID(item.libraryID);
    return ref ? `${ref}-${item.key}` : null;
}

/** Why an item cannot be a row of the table. */
export type RowRejection = 'note' | 'annotation' | 'standalone' | 'trash' | 'excluded' | 'other';

/**
 * The row an item becomes: a paper is itself, a child attachment its parent.
 * Notes, annotations and standalone attachments are not papers; neither is a
 * paper in the trash (the backend does not resolve it) or in a library the
 * user excluded from Beaver.
 */
export function rowForItem(
    item: Zotero.Item,
    searchableLibraryIds: number[],
): { id: string; paper: Zotero.Item } | { rejection: RowRejection } {
    const paper = paperOf(item);
    if (!paper) {
        if (item.isNote()) return { rejection: 'note' };
        if (item.isAnnotation()) return { rejection: 'annotation' };
        if (item.isAttachment()) return { rejection: 'standalone' };
        return { rejection: 'other' };
    }
    if (paper.deleted) return { rejection: 'trash' };
    if (!searchableLibraryIds.includes(paper.libraryID)) return { rejection: 'excluded' };
    const id = portableItemId(paper);
    return id ? { id, paper } : { rejection: 'other' };
}

/** What the card says about items it could not take. */
export function rejectionMessage(rejection: RowRejection, count = 1): string {
    const many = count !== 1;
    switch (rejection) {
        case 'note':
            return many ? 'Notes cannot be table rows' : 'A note cannot be a table row';
        case 'annotation':
            return many ? 'Annotations cannot be table rows' : 'An annotation cannot be a table row';
        case 'standalone':
            return many
                ? 'Standalone files cannot be table rows'
                : 'A standalone file cannot be a table row';
        case 'trash':
            return many ? 'Items in the trash cannot be added' : 'An item in the trash cannot be added';
        case 'excluded':
            return 'Items from excluded libraries cannot be added';
        default:
            return 'Only regular items can be table rows';
    }
}

/**
 * A collection or saved search as a source, or null when it cannot be one
 * (in the trash, or in a library the user excluded).
 */
export function scopeForCollection(
    collection: Zotero.Collection,
    searchableLibraryIds: number[],
): TableCardLibraryScope | null {
    if (collection.deleted || !searchableLibraryIds.includes(collection.libraryID)) return null;
    const ref = libraryRefForLibraryID(collection.libraryID);
    return ref ? { kind: 'collection', library_ref: ref, key: collection.key, name: collection.name } : null;
}

export function scopeForSavedSearch(
    search: Zotero.Search,
    searchableLibraryIds: number[],
): TableCardLibraryScope | null {
    if (search.deleted || !searchableLibraryIds.includes(search.libraryID)) return null;
    const ref = libraryRefForLibraryID(search.libraryID);
    return ref ? { kind: 'saved_search', library_ref: ref, key: search.key, name: search.name } : null;
}
