import { ThreadItemFilter } from '../atoms/threads';
import { loadFullItemData } from '../../src/utils/zoteroUtils';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';
import { getDisplayNameFromItem } from './sourceUtils';

/**
 * Builds a `ThreadItemFilter` descriptor for filtering the thread list view
 * by a Zotero item.
 *
 * Regular items expand to their own key plus every child attachment/note
 * key (citations and user attachments can reference either), so `/by-item`
 * matches threads regardless of which key was actually referenced.
 * Attachments and notes expand to their own key plus their parent's key.
 * Any other item type (e.g. an annotation) is not a valid filter target.
 *
 * `searchableLibraryIds` is a plain parameter rather than read from the
 * store so this stays pure and testable: items in an excluded library are
 * never offered as filter targets (privacy boundary).
 */
export async function buildThreadItemFilter(
    item: Zotero.Item,
    searchableLibraryIds: number[],
): Promise<ThreadItemFilter | null> {
    if (!searchableLibraryIds.includes(item.libraryID)) return null;

    await loadFullItemData([item]);

    let keys: string[];
    if (item.isRegularItem()) {
        const childIDs = [...item.getAttachments(), ...item.getNotes()];
        const children = childIDs.length > 0 ? await Zotero.Items.getAsync(childIDs) : [];
        const childKeys = children.map((child: Zotero.Item) => child?.key).filter(Boolean) as string[];
        keys = [item.key, ...childKeys];
    } else if (item.isAttachment() || item.isNote()) {
        keys = [item.key, ...(item.parentKey ? [item.parentKey] : [])];
    } else {
        return null;
    }

    return {
        libraryId: item.libraryID,
        libraryRef: libraryRefForLibraryID(item.libraryID) ?? undefined,
        itemKey: item.key,
        keys,
        itemType: item.getItemTypeIconName(),
        label: getDisplayNameFromItem(item),
    };
}
