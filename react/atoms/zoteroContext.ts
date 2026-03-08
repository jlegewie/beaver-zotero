import { atom } from 'jotai';
import { isLibraryTabAtom } from './ui';
import { currentReaderAttachmentAtom } from './messageComposition';

// --- Selected Items (library view) ---
// Capped at first 10 items for display; full count tracked separately
export const selectedZoteroItemsAtom = atom<Zotero.Item[]>([]);
export const selectedZoteroItemCountAtom = atom<number>(0);

// --- Library View State (collection tree row) ---
export type LibraryTreeRowType =
    | 'library' | 'collection' | 'search' | 'duplicates'
    | 'unfiled' | 'trash' | 'publications' | 'retracted'
    | 'feeds' | 'feed' | null;

export interface LibraryViewInfo {
    treeRowType: LibraryTreeRowType;
    libraryId: number;
    libraryName: string;
    collectionId: number | null;
    collectionName: string | null;
    searchName: string | null;
}

const defaultLibraryView: LibraryViewInfo = {
    treeRowType: 'library',
    libraryId: 1,
    libraryName: 'My Library',
    collectionId: null,
    collectionName: null,
    searchName: null,
};

export const libraryViewAtom = atom<LibraryViewInfo>(defaultLibraryView);

// --- Selected Tags (tag filter in library view) ---
export const selectedTagsAtom = atom<string[]>([]);

// --- Recently Added Items (today) ---
export const recentlyAddedTodayCountAtom = atom<number>(0);

// --- Derived Context ---
export type ZoteroContextType =
    | 'reader' | 'items_selected' | 'tag_filtered'
    | 'collection' | 'special_view' | 'library' | 'idle';

export interface ZoteroContext {
    type: ZoteroContextType;
    isLibraryTab: boolean;
    // Library view
    selectedItemCount: number;
    selectedItems: Zotero.Item[];
    libraryView: LibraryViewInfo;
    selectedTags: string[];
    // Reader view
    readerAttachment: Zotero.Item | null;
    // Global
    recentlyAddedTodayCount: number;
}

const SPECIAL_VIEW_TYPES: Set<LibraryTreeRowType> = new Set([
    'duplicates', 'unfiled', 'trash', 'publications', 'retracted', 'feeds', 'feed',
]);

export const zoteroContextAtom = atom<ZoteroContext>((get) => {
    const isLibraryTab = get(isLibraryTabAtom);
    const selectedItems = get(selectedZoteroItemsAtom);
    const selectedItemCount = get(selectedZoteroItemCountAtom);
    const libraryView = get(libraryViewAtom);
    const selectedTags = get(selectedTagsAtom);
    const readerAttachment = get(currentReaderAttachmentAtom);
    const recentlyAddedTodayCount = get(recentlyAddedTodayCountAtom);

    // Determine context type by priority
    let type: ZoteroContextType = 'idle';
    if (!isLibraryTab && readerAttachment) {
        type = 'reader';
    } else if (isLibraryTab) {
        if (selectedItemCount > 0) {
            type = 'items_selected';
        } else if (selectedTags.length > 0) {
            type = 'tag_filtered';
        } else if (libraryView.treeRowType === 'collection') {
            type = 'collection';
        } else if (SPECIAL_VIEW_TYPES.has(libraryView.treeRowType)) {
            type = 'special_view';
        } else if (libraryView.treeRowType === 'library') {
            type = 'library';
        }
    }

    return {
        type,
        isLibraryTab,
        selectedItemCount,
        selectedItems,
        libraryView,
        selectedTags,
        readerAttachment,
        recentlyAddedTodayCount,
    };
});
