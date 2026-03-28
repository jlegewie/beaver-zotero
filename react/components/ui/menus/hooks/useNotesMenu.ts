import { useEffect, useState } from 'react';
import { SearchMenuItem } from '../SearchMenu';
import { SourceMenuItemContext, createNoteMenuItem } from '../utils/menuItemFactories';
import { loadFullItemData, getActiveZoteroLibraryId } from '../../../../../src/utils/zoteroUtils';

const NOTES_FETCH_LIMIT = 100;
const NOTES_DISPLAY_LIMIT = 20;

interface UseNotesMenuOptions {
    isActive: boolean;
    searchQuery: string;
    searchableLibraryIds: number[];
    sourceMenuItemContext: SourceMenuItemContext;
    verticalPosition?: 'above' | 'below';
}

interface UseNotesMenuResult {
    menuItems: SearchMenuItem[];
}

export const useNotesMenu = ({
    isActive,
    searchQuery,
    searchableLibraryIds,
    sourceMenuItemContext,
    verticalPosition = 'above'
}: UseNotesMenuOptions): UseNotesMenuResult => {
    const [menuItems, setMenuItems] = useState<SearchMenuItem[]>([]);
    const [notes, setNotes] = useState<Zotero.Item[]>([]);
    const [activeLibraryId, setActiveLibraryId] = useState<number | null>(null);

    // Phase 1: Fetch recent notes from the active library when active
    useEffect(() => {
        if (!isActive) {
            setNotes([]);
            setMenuItems([]);
            setActiveLibraryId(null);
            return;
        }

        let isCancelled = false;

        const fetchNotes = async () => {
            const libraryId = getActiveZoteroLibraryId();
            setActiveLibraryId(libraryId);

            if (!libraryId || !searchableLibraryIds.includes(libraryId)) {
                if (!isCancelled) {
                    setNotes([]);
                }
                return;
            }

            try {
                const noteTypeID = Zotero.ItemTypes.getID('note');
                const sql = `SELECT itemID FROM items
                    WHERE itemTypeID = ?
                    AND libraryID = ?
                    AND itemID NOT IN (SELECT itemID FROM deletedItems)
                    ORDER BY dateModified DESC
                    LIMIT ?`;
                const params = [noteTypeID, libraryId, NOTES_FETCH_LIMIT];
                const ids = await Zotero.DB.columnQueryAsync(sql, params) as number[];

                if (ids.length > 0) {
                    const items = await Zotero.Items.getAsync(ids);
                    const validItems = items.filter((item: Zotero.Item) => Boolean(item));
                    await loadFullItemData(validItems, {
                        includeParents: true,
                        includeChildren: false,
                        dataTypes: ["primaryData", "creators", "itemData", "note"]
                    });

                    // Re-sort by dateModified since getAsync doesn't preserve order
                    validItems.sort((a: Zotero.Item, b: Zotero.Item) =>
                        (b.dateModified || '').localeCompare(a.dateModified || '')
                    );

                    if (!isCancelled) {
                        setNotes(validItems);
                    }
                } else if (!isCancelled) {
                    setNotes([]);
                }
            } catch (error) {
                console.error('Error fetching notes:', error);
                if (!isCancelled) {
                    setNotes([]);
                }
            }
        };

        fetchNotes();

        return () => {
            isCancelled = true;
        };
    }, [isActive, searchableLibraryIds]);

    // Phase 2: Filter and build menu items based on search query
    useEffect(() => {
        if (!isActive) return;

        let isCancelled = false;

        const buildMenuItems = async () => {
            let displayNotes: Zotero.Item[];

            if (searchQuery.trim()) {
                const lowerQuery = searchQuery.toLowerCase();
                displayNotes = notes
                    .map(note => {
                        const title = (note.getNoteTitle() || '').toLowerCase();
                        const content = (note.getNote() || '').replace(/<[^>]*>/g, '').toLowerCase();
                        const titleMatch = title.includes(lowerQuery);
                        const contentMatch = content.includes(lowerQuery);
                        // Title matches score higher; ties preserve dateModified order
                        const score = titleMatch ? 2 : contentMatch ? 1 : 0;
                        return { note, score };
                    })
                    .filter(r => r.score > 0)
                    .sort((a, b) => b.score - a.score)
                    .map(r => r.note);
            } else {
                displayNotes = notes;
            }

            const limited = displayNotes.slice(0, NOTES_DISPLAY_LIMIT);
            const items = await Promise.all(
                limited.map(note => createNoteMenuItem(note, sourceMenuItemContext))
            );

            if (!isCancelled) {
                if (items.length === 0) {
                    setMenuItems([]);
                } else {
                    let headerLabel = searchQuery.trim() ? 'Search Results' : 'Recent Notes';
                    if (!searchQuery.trim() && activeLibraryId) {
                        const library = Zotero.Libraries.get(activeLibraryId);
                        headerLabel = library ? `Notes in ${library.name}` : headerLabel;
                    }
                    const header: SearchMenuItem = { label: headerLabel, isGroupHeader: true, onClick: () => {} };

                    if (verticalPosition === 'above') {
                        setMenuItems([...items.reverse(), header]);
                    } else {
                        setMenuItems([header, ...items]);
                    }
                }
            }
        };

        buildMenuItems();

        return () => {
            isCancelled = true;
        };
    }, [isActive, searchQuery, notes, sourceMenuItemContext, activeLibraryId, verticalPosition]);

    return { menuItems };
};
