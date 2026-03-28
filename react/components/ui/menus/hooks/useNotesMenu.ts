import { useEffect, useState } from 'react';
import { SearchMenuItem } from '../SearchMenu';
import { SourceMenuItemContext, createNoteMenuItem } from '../utils/menuItemFactories';
import { loadFullItemData } from '../../../../../src/utils/zoteroUtils';

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

    // Phase 1: Fetch recent notes when active
    useEffect(() => {
        if (!isActive) {
            setNotes([]);
            setMenuItems([]);
            return;
        }

        let isCancelled = false;

        const fetchNotes = async () => {
            try {
                const noteTypeID = Zotero.ItemTypes.getID('note');
                const placeholders = searchableLibraryIds.map(() => '?').join(',');
                const sql = `SELECT itemID FROM items
                    WHERE itemTypeID = ?
                    AND libraryID IN (${placeholders})
                    AND itemID NOT IN (SELECT itemID FROM deletedItems)
                    ORDER BY dateModified DESC
                    LIMIT ?`;
                const params = [noteTypeID, ...searchableLibraryIds, NOTES_FETCH_LIMIT];
                const ids = await Zotero.DB.columnQueryAsync(sql, params) as number[];

                if (ids.length > 0) {
                    const items = await Zotero.Items.getAsync(ids);
                    const validItems = items.filter((item: Zotero.Item) => Boolean(item));
                    await loadFullItemData(validItems);

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
                displayNotes = notes.filter(note => {
                    const title = (note.getNoteTitle() || '').toLowerCase();
                    return title.includes(lowerQuery);
                });
            } else {
                displayNotes = notes;
            }

            const limited = displayNotes.slice(0, NOTES_DISPLAY_LIMIT);
            const items = await Promise.all(
                limited.map(note => createNoteMenuItem(note, sourceMenuItemContext))
            );

            if (!isCancelled) {
                const headerLabel = searchQuery.trim() ? 'Search Results' : 'Recent Notes';
                const header: SearchMenuItem = { label: headerLabel, isGroupHeader: true, onClick: () => {} };

                if (verticalPosition === 'above') {
                    setMenuItems([...items.reverse(), header]);
                } else {
                    setMenuItems([header, ...items]);
                }
            }
        };

        buildMenuItems();

        return () => {
            isCancelled = true;
        };
    }, [isActive, searchQuery, notes, sourceMenuItemContext, verticalPosition]);

    return { menuItems };
};
