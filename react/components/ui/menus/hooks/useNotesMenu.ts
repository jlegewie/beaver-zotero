import { useEffect, useRef, useState } from 'react';
import { SearchMenuItem } from '../SearchMenu';
import { SourceMenuItemContext, createNoteMenuItem } from '../utils/menuItemFactories';
import { loadFullItemData, getActiveZoteroLibraryId } from '../../../../../src/utils/zoteroUtils';

const NOTES_DISPLAY_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 200;

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
    const [recentNotes, setRecentNotes] = useState<Zotero.Item[]>([]);
    const [searchResults, setSearchResults] = useState<Zotero.Item[]>([]);
    const [hasSearchResults, setHasSearchResults] = useState(false);
    const [activeLibraryId, setActiveLibraryId] = useState<number | null>(null);
    const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Phase 1: Fetch recent notes from the active library when active
    useEffect(() => {
        if (!isActive) {
            setRecentNotes([]);
            setSearchResults([]);
            setHasSearchResults(false);
            setMenuItems([]);
            setActiveLibraryId(null);
            return;
        }

        let isCancelled = false;

        const fetchNotes = async () => {
            const libraryId = getActiveZoteroLibraryId();

            if (!libraryId || !searchableLibraryIds.includes(libraryId)) {
                if (!isCancelled) {
                    setActiveLibraryId(null);
                    setRecentNotes([]);
                }
                return;
            }

            if (!isCancelled) {
                setActiveLibraryId(libraryId);
            }

            try {
                const noteTypeID = Zotero.ItemTypes.getID('note');
                const sql = `SELECT itemID FROM items
                    WHERE itemTypeID = ?
                    AND libraryID = ?
                    AND itemID NOT IN (SELECT itemID FROM deletedItems)
                    ORDER BY dateModified DESC
                    LIMIT ?`;
                const params = [noteTypeID, libraryId, NOTES_DISPLAY_LIMIT];
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
                        setRecentNotes(validItems);
                    }
                } else if (!isCancelled) {
                    setRecentNotes([]);
                }
            } catch (error) {
                console.error('Error fetching notes:', error);
                if (!isCancelled) {
                    setRecentNotes([]);
                }
            }
        };

        fetchNotes();

        return () => {
            isCancelled = true;
        };
    }, [isActive, searchableLibraryIds]);

    // Phase 2: Search notes via Zotero.Search when query changes (debounced)
    useEffect(() => {
        if (!isActive || !activeLibraryId) return;

        if (searchTimerRef.current) {
            clearTimeout(searchTimerRef.current);
            searchTimerRef.current = null;
        }

        if (!searchQuery.trim()) {
            setSearchResults([]);
            setHasSearchResults(false);
            return;
        }

        let isCancelled = false;
        setHasSearchResults(false);

        searchTimerRef.current = setTimeout(async () => {
            try {
                const search = new Zotero.Search({ libraryID: activeLibraryId });
                search.addCondition('itemType', 'is', 'note');
                search.addCondition('note', 'contains', searchQuery.trim());
                const ids = await search.search();

                if (isCancelled) return;

                const limitedIds = ids.slice(0, NOTES_DISPLAY_LIMIT);
                if (limitedIds.length > 0) {
                    const items = await Zotero.Items.getAsync(limitedIds);
                    const validItems = items.filter((item: Zotero.Item) => Boolean(item));
                    await loadFullItemData(validItems, {
                        includeParents: true,
                        includeChildren: false,
                        dataTypes: ["primaryData", "creators", "itemData", "note"]
                    });

                    // Rank title matches above content-only matches, then by dateModified
                    const lowerQuery = searchQuery.trim().toLowerCase();
                    validItems.sort((a: Zotero.Item, b: Zotero.Item) => {
                        const aTitle = (a.getNoteTitle() || '').toLowerCase().includes(lowerQuery);
                        const bTitle = (b.getNoteTitle() || '').toLowerCase().includes(lowerQuery);
                        if (aTitle !== bTitle) return aTitle ? -1 : 1;
                        return (b.dateModified || '').localeCompare(a.dateModified || '');
                    });

                    if (!isCancelled) {
                        setSearchResults(validItems);
                        setHasSearchResults(true);
                    }
                } else if (!isCancelled) {
                    setSearchResults([]);
                    setHasSearchResults(true);
                }
            } catch (error) {
                console.error('Error searching notes:', error);
                if (!isCancelled) {
                    setSearchResults([]);
                    setHasSearchResults(true);
                }
            }
        }, SEARCH_DEBOUNCE_MS);

        return () => {
            isCancelled = true;
            if (searchTimerRef.current) {
                clearTimeout(searchTimerRef.current);
                searchTimerRef.current = null;
            }
        };
    }, [isActive, searchQuery, activeLibraryId]);

    // Phase 3: Build menu items from the appropriate note set
    useEffect(() => {
        if (!isActive) return;

        let isCancelled = false;

        const buildMenuItems = async () => {
            let displayNotes: Zotero.Item[];
            if (!searchQuery.trim()) {
                displayNotes = recentNotes;
            } else if (hasSearchResults) {
                displayNotes = searchResults;
            } else {
                // Local filter as immediate fallback while debounced search is pending
                const lowerQuery = searchQuery.trim().toLowerCase();
                displayNotes = recentNotes.filter(note => {
                    const title = (note.getNoteTitle() || '').toLowerCase();
                    if (title.includes(lowerQuery)) return true;
                    const content = (note.getNote() || '').replace(/<[^>]*>/g, '').toLowerCase();
                    return content.includes(lowerQuery);
                });
            }

            const items = await Promise.all(
                displayNotes.map(note => createNoteMenuItem(note, sourceMenuItemContext))
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
                        setMenuItems([...[...items].reverse(), header]);
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
    }, [isActive, searchQuery, recentNotes, searchResults, hasSearchResults, sourceMenuItemContext, activeLibraryId, verticalPosition]);

    return { menuItems };
};
