import React from 'react';
import { useState, useEffect, useRef, useCallback, useMemo, useImperativeHandle, forwardRef } from 'react';
import { PlusSignIcon, Icon } from '../../icons/icons';
import { ItemSearchResult } from '@beaver/agent-core/transport/clients/searchService';
import { itemSearchResultFromZoteroItem } from '../../../../src/utils/zoteroSerializers';
import SearchMenu, { MenuPosition, SearchMenuCloseReason } from '@beaver/agent-ui/primitives/SearchMenu';
import { currentMessageFiltersAtom, removeItemFromMessageAtom, addItemToCurrentMessageItemsAtom, currentMessageItemsAtom } from '../../../atoms/messageComposition';
import { EXTERNAL_FILE_PICKER_EXTENSIONS } from '../../../../src/services/externalFiles';
import { useAttachExternalFiles } from '../../../hooks/useAttachExternalFiles';
import { useAtomValue, useSetAtom } from 'jotai';
import { getPref, setPref } from '../../../../src/utils/prefs';
import { getRecentAsync, loadFullItemData, getActiveZoteroLibraryId } from '../../../../src/utils/zoteroUtils';
import { libraryRefForLibraryID, UNRESOLVED_LIBRARY_ID } from '../../../../src/utils/libraryIdentity';
import { searchTitleCreatorYear, scoreSearchResult } from '../../../utils/search';
import { logger } from '@beaver/agent-core/platform/logger';
import { searchableLibraryIdsAtom } from '../../../atoms/profile';
import { selectedZoteroItemsAtom } from '../../../atoms/zoteroContext';
import { store } from '../../../store';
import { SourceMenuItemContext, LibraryMenuItemContext, CollectionMenuItemContext, TagMenuItemContext } from './utils/menuItemFactories';
import { useSourcesMenu } from './hooks/useSourcesMenu';
import { useLibrariesMenu } from './hooks/useLibrariesMenu';
import { useCollectionsMenu } from './hooks/useCollectionsMenu';
import { useTagsMenu } from './hooks/useTagsMenu';
import { useNotesMenu } from './hooks/useNotesMenu';
import { ZoteroTag } from '@beaver/agent-core/types/zotero';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { AddSourcesMenuHandle, AddSourcesQuerySource } from '@beaver/agent-ui/composer/useAddSourcesMenu';

/** How many recent items are carried in the `recentItems` preference. */
const RECENT_ITEMS_LIMIT = 5;
/**
 * How many item rows the menu offers at the top before anything is typed —
 * the Zotero selection, or the recently used items when nothing is selected.
 */
const PROPOSED_ITEMS_LIMIT = 3;

type MenuMode = 'sources' | 'libraries' | 'collections' | 'tags' | 'notes';

interface RecentItem {
    zotero_key: string;
    library_id: number;
    library_ref?: string;
}

const updateRecentItems = async (newRecentItems: RecentItem[]) => {
    // Get recent items from preferences
    const recentItemsPref = getPref("recentItems");
    let recentItems: RecentItem[] = [];
    if (recentItemsPref) {
        const recentItemsPrefParsed = JSON.parse(recentItemsPref as string);
        if (Array.isArray(recentItemsPrefParsed)) {
            recentItems = (await Promise.all(
                recentItemsPrefParsed
                    .filter((recentItem): recentItem is RecentItem => 
                        typeof recentItem === 'object' && 
                        recentItem !== null && 
                        'zotero_key' in recentItem && 
                        'library_id' in recentItem
                    )
            ));
        }
    }
    // Combine recent items and new recent items
    const combinedItems = [...newRecentItems, ...recentItems]
        .filter((item, index, self) =>
            index === self.findIndex((t) => t.zotero_key === item.zotero_key && t.library_id === item.library_id)
        )
        .map((item) => ({
            ...item,
            library_ref: item.library_ref ?? libraryRefForLibraryID(item.library_id) ?? undefined,
        }))
        .slice(0, RECENT_ITEMS_LIMIT)

    // Update recent items
    setPref('recentItems', JSON.stringify(combinedItems));
}

const getRecentItems = async (): Promise<Zotero.Item[]> => {
    const recentItemsPref = getPref("recentItems");
    let recentItems: Zotero.Item[] = [];
    if (recentItemsPref) {
        const recentItemsPrefParsed = JSON.parse(recentItemsPref as string);
        if (Array.isArray(recentItemsPrefParsed)) {
            const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
            recentItems = (await Promise.all(
                recentItemsPrefParsed
                    .filter((recentItem): recentItem is RecentItem =>
                        typeof recentItem === 'object' &&
                        recentItem !== null &&
                        'zotero_key' in recentItem &&
                        'library_id' in recentItem &&
                        // A portable library ref that couldn't be resolved on this
                        // device carries library_id 0, which throws synchronously
                        // if looked up.
                        recentItem.library_id !== UNRESOLVED_LIBRARY_ID &&
                        // Never look up recents from libraries the user excluded
                        // from Beaver — stored recents can predate an exclusion.
                        searchableLibraryIds.includes(recentItem.library_id)
                    )
                    .map(async (recentItem) => await Zotero.Items.getByLibraryAndKeyAsync(recentItem.library_id, recentItem.zotero_key))
            )).filter((item): item is Zotero.Item => Boolean(item));
        }
    }
    return recentItems;
}


export interface AddSourcesMenuProps {
    isMenuOpen: boolean;
    menuPosition: MenuPosition;
    /** The current search query, wherever it is being typed. */
    searchQuery: string;
    /**
     * Where that query comes from: the chat editor for a typed `@`, or the
     * menu's own search field when opened from the "+" button.
     */
    querySource: AddSourcesQuerySource;
    /** The menu's own search field reporting what was typed into it. */
    onQueryChange: (query: string) => void;
    /** Open from the "+" button, anchored at the given position. */
    onOpen: (position: MenuPosition) => void;
    /** Close without touching the typed text (Escape, click outside). */
    onDismiss: (reason: SearchMenuCloseReason) => void;
    /** Close because something was picked — the typed `@query` is consumed. */
    onCommit: () => void;
    /** Clear the typed query but leave the menu open (entering a submenu). */
    onResetQuery: () => void;
    menuPortalContainer?: HTMLElement | null;
    disabled?: boolean;
    verticalPosition?: 'above' | 'below';
}

const AddSourcesMenu = forwardRef<AddSourcesMenuHandle, AddSourcesMenuProps>(function AddSourcesMenu({
    isMenuOpen,
    menuPosition,
    searchQuery,
    querySource,
    onQueryChange,
    onOpen,
    onDismiss,
    onCommit,
    onResetQuery,
    menuPortalContainer,
    disabled = false,
    verticalPosition = 'above',
}, ref) {
    const [isLoading, setIsLoading] = useState(false);
    const [searchResults, setSearchResults] = useState<ItemSearchResult[]>([]);
    const [menuMode, setMenuMode] = useState<MenuMode>('sources');
    const [activeZoteroLibraryId, setActiveZoteroLibraryId] = useState<number | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const selectedZoteroItems = useAtomValue(selectedZoteroItemsAtom);
    const currentMessageFilters = useAtomValue(currentMessageFiltersAtom);
    const setCurrentMessageFilters = useSetAtom(currentMessageFiltersAtom);
    const { libraryIds: currentLibraryIds, collectionIds: currentCollectionIds, tagSelections: currentTagSelections } = currentMessageFilters;
    const addItemToCurrentMessageItems = useSetAtom(addItemToCurrentMessageItemsAtom);
    const attachExternalFiles = useAttachExternalFiles();
    const currentMessageItems = useAtomValue(currentMessageItemsAtom);
    const removeItemFromMessage = useSetAtom(removeItemFromMessageAtom);

    // Identifies the search whose results may still be applied. A counter, not
    // a timestamp: keystrokes land well within the same millisecond, and two
    // searches sharing an id would both consider themselves current.
    const searchSequenceRef = useRef(0);
    const currentSearchRef = useRef<number>(0);

    useEffect(() => {
        if (!isMenuOpen) return;
        setActiveZoteroLibraryId(getActiveZoteroLibraryId());
    }, [isMenuOpen, menuMode]);

    // Reset the menu's own state; the typed query lives in the editor and is
    // handled by the caller (left alone on dismiss, consumed on commit).
    const resetMenuState = useCallback(() => {
        currentSearchRef.current = 0;
        setSearchResults([]);
        setMenuMode('sources');
    }, []);

    const handleDismiss = useCallback((reason: SearchMenuCloseReason) => {
        resetMenuState();
        onDismiss(reason);
    }, [onDismiss, resetMenuState]);

    const handleCommit = useCallback(() => {
        resetMenuState();
        onCommit();
    }, [onCommit, resetMenuState]);

    useImperativeHandle(ref, () => ({
        goBack: () => {
            if (menuMode === 'sources') return false;
            setMenuMode('sources');
            return true;
        },
    }), [menuMode]);

    // Improved search function with debouncing and cancellation
    const handleSearch = useCallback(async (query: string, limit: number = 10) => {
        if (!query.trim()) return [];
        
        const searchId = ++searchSequenceRef.current;
        currentSearchRef.current = searchId;
        
        try {
            setIsLoading(true);

            // Query formatting
            query = query.replace(/ (?:&|and) /g, " ");
            query = query.replace(/,/, ' ');
            query = query.replace(/&/, ' ');
            query = query.replace(/ ?(\d{1,4})$/, ' $1');
            query = query.trim();
            
            // Search Zotero items
            const { libraryIds, tagSelections } = store.get(currentMessageFiltersAtom);
            const searchLibraryIds = libraryIds.length > 0
                ? libraryIds
                : tagSelections.length > 0
                    ? Array.from(new Set(tagSelections.map((tag: ZoteroTag) => tag.libraryId)))
                    : searchableLibraryIds;
            const searchTags = tagSelections.length > 0 ? tagSelections : undefined;
            logger(`AddSourcesMenu.handleSearch: Searching for '${query}' in libraries: ${searchLibraryIds.join(', ')}${searchTags ? `, tags: ${searchTags.map((tag: ZoteroTag) => `${tag.tag} (lib ${tag.libraryId})`).join('; ')}` : ''}`)
            const resultsItems = await searchTitleCreatorYear(query, searchLibraryIds, undefined, searchTags);

            // Ensure item data is loaded
            await loadFullItemData(resultsItems);
            
            // Check if this search was cancelled
            if (searchId !== currentSearchRef.current) {
                return [];
            }
            
            // Score and sort results
            const scoredResults = resultsItems
                .map(item => ({
                    item,
                    score: scoreSearchResult(item, query)
                }))
                .filter(result => result.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, limit)
                .map(result => result.item);
            
            // Final check if search was cancelled
            if (searchId !== currentSearchRef.current) {
                return [];
            }
            
            const results = scoredResults.map(itemSearchResultFromZoteroItem).filter(Boolean) as ItemSearchResult[];
            
            // Update the search results only if this is still the current search
            if (searchId === currentSearchRef.current) {
                setSearchResults(results);
            }
        } catch (error) {
            console.error('Error searching Zotero items:', error);
            return [];
        } finally {
            // Only update loading state if this is still the current search
            if (searchId === currentSearchRef.current) {
                setIsLoading(false);
            }
        }
    }, [scoreSearchResult, searchableLibraryIds]);

    const handleNavigateToLibraries = useCallback(() => {
        onResetQuery();
        setMenuMode('libraries');
    }, [onResetQuery]);

    const handleNavigateToCollections = useCallback((libraryId: number) => {
        setActiveZoteroLibraryId(libraryId);
        onResetQuery();
        setMenuMode('collections');
    }, [onResetQuery]);

    const handleNavigateToTags = useCallback((libraryId: number) => {
        setActiveZoteroLibraryId(libraryId);
        onResetQuery();
        setMenuMode('tags');
    }, [onResetQuery]);

    const handleNavigateToNotes = useCallback(() => {
        onResetQuery();
        setMenuMode('notes');
    }, [onResetQuery]);

    // Open a native file picker and attach the chosen files as external files
    // (copied into the Beaver-managed folder, sent as metadata-only attachments).
    const handleSelectFiles = useCallback(() => {
        handleCommit();
        (async () => {
            const { FilePicker } = ChromeUtils.importESModule(
                'chrome://zotero/content/modules/filePicker.mjs'
            ) as { FilePicker: any };
            const fp = new FilePicker();
            fp.init(Zotero.getMainWindow(), 'Select Files', fp.modeOpenMultiple);
            fp.appendFilter('Supported files (PDF, EPUB, text, images)', EXTERNAL_FILE_PICKER_EXTENSIONS.join('; '));
            const rv = await fp.show();
            if (rv !== fp.returnOK) return;
            const paths: string[] = fp.files || [];
            await attachExternalFiles(paths);
        })().catch((error) => {
            logger(`AddSourcesMenu.handleSelectFiles: ${error}`, 1);
        });
    }, [handleCommit, attachExternalFiles]);

    // Handler functions for menu item callbacks
    const handleAddSourceItem = useCallback((item: Zotero.Item) => {
        updateRecentItems([{
            zotero_key: item.key,
            library_id: item.libraryID,
            library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
        }]);
        addItemToCurrentMessageItems(item);
        handleCommit();
    }, [addItemToCurrentMessageItems, handleCommit]);

    const handleRemoveSourceItem = useCallback((item: Zotero.Item) => {
        removeItemFromMessage(item);
        handleCommit();
    }, [removeItemFromMessage, handleCommit]);

    const handleSelectLibrary = useCallback((libraryId: number) => {
        setCurrentMessageFilters((prev) => {
            const isSelected = prev.libraryIds.includes(libraryId);
            return {
                ...prev,
                libraryIds: isSelected ? prev.libraryIds.filter((id) => id !== libraryId) : [libraryId],
                collectionIds: [],
                tagSelections: []
            };
        });
        handleCommit();
    }, [setCurrentMessageFilters, handleCommit]);

    const handleSelectCollection = useCallback((collectionId: number) => {
        setCurrentMessageFilters((prev) => {
            const exists = prev.collectionIds.includes(collectionId);
            return {
                ...prev,
                libraryIds: [],
                collectionIds: exists
                    ? prev.collectionIds.filter((id) => id !== collectionId)
                    : [...prev.collectionIds, collectionId],
                tagSelections: []
            };
        });
        handleCommit();
    }, [setCurrentMessageFilters, handleCommit]);

    const handleSelectTag = useCallback((tag: ZoteroTag) => {
        setCurrentMessageFilters((prev) => {
            const exists = prev.tagSelections.some((selected) => selected.id === tag.id);
            return {
                ...prev,
                libraryIds: [],
                collectionIds: [],
                tagSelections: exists
                    ? prev.tagSelections.filter((selected) => selected.id !== tag.id)
                    : [...prev.tagSelections, tag]
            };
        });
        handleCommit();
    }, [setCurrentMessageFilters, handleCommit]);

    // These contexts stay identity-stable across keystrokes: menu hooks feed
    // them to their fetch effects, so churning them would re-read tags,
    // collections and libraries on every character typed. The search query
    // reaches the rows as a separate argument to the item factories.
    const sourceMenuItemContext = useMemo<SourceMenuItemContext>(() => ({
        currentMessageItems,
        onAdd: handleAddSourceItem,
        onRemove: handleRemoveSourceItem
    }), [currentMessageItems, handleAddSourceItem, handleRemoveSourceItem]);

    const libraryMenuItemContext = useMemo<LibraryMenuItemContext>(() => ({
        currentLibraryIds,
        onSelect: handleSelectLibrary
    }), [currentLibraryIds, handleSelectLibrary]);

    const collectionMenuItemContext = useMemo<CollectionMenuItemContext>(() => ({
        currentCollectionIds,
        onSelect: handleSelectCollection
    }), [currentCollectionIds, handleSelectCollection]);

    const tagMenuItemContext = useMemo<TagMenuItemContext>(() => ({
        currentTags: currentTagSelections,
        onSelect: handleSelectTag
    }), [currentTagSelections, handleSelectTag]);

    // The query lives in the chat editor, so nothing calls back into this
    // component when it changes — run the item search from the query itself.
    // Previous results are left in place until the new ones land, so the list
    // does not blink through "No results found" on every keystroke.
    useEffect(() => {
        if (!isMenuOpen || menuMode !== 'sources') return;
        if (!searchQuery.trim()) {
            currentSearchRef.current = 0;
            setSearchResults([]);
            setIsLoading(false);
            return;
        }
        handleSearch(searchQuery);
    }, [isMenuOpen, menuMode, searchQuery, handleSearch]);

    const sourcesMenu = useSourcesMenu({
        isActive: isMenuOpen && menuMode === 'sources',
        searchQuery,
        searchResults,
        selectedZoteroItems,
        proposedItemsLimit: PROPOSED_ITEMS_LIMIT,
        sourceMenuItemContext,
        searchableLibraryIds,
        activeZoteroLibraryId,
        onNavigateToLibraries: handleNavigateToLibraries,
        onNavigateToCollections: handleNavigateToCollections,
        onNavigateToTags: handleNavigateToTags,
        onNavigateToNotes: handleNavigateToNotes,
        onSelectFiles: handleSelectFiles,
        getRecentItems,
        recentItemsLimit: RECENT_ITEMS_LIMIT,
        verticalPosition
    });

    const librariesMenu = useLibrariesMenu({
        isActive: isMenuOpen && menuMode === 'libraries',
        searchQuery,
        searchableLibraryIds,
        libraryMenuItemContext,
        verticalPosition
    });

    const collectionsMenu = useCollectionsMenu({
        isActive: isMenuOpen && menuMode === 'collections',
        searchQuery,
        searchableLibraryIds,
        collectionMenuItemContext,
        verticalPosition
    });

    const tagsMenu = useTagsMenu({
        isActive: isMenuOpen && menuMode === 'tags',
        searchQuery,
        searchableLibraryIds,
        tagMenuItemContext,
        verticalPosition
    });

    const notesMenu = useNotesMenu({
        isActive: isMenuOpen && menuMode === 'notes',
        searchQuery,
        searchableLibraryIds,
        sourceMenuItemContext,
        verticalPosition
    });

    const menuItems = menuMode === 'sources'
        ? sourcesMenu.menuItems
        : menuMode === 'libraries'
            ? librariesMenu.menuItems
            : menuMode === 'collections'
                ? collectionsMenu.menuItems
                : menuMode === 'tags'
                    ? tagsMenu.menuItems
                    : notesMenu.menuItems;

    const handleButtonClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        
        // Get button position
        if (buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            const y = verticalPosition === 'above' ? rect.top - 5 : rect.bottom;
            setMenuMode('sources');
            onOpen({ x: rect.left, y });

            // Remove focus from the button after opening the menu
            buttonRef.current.blur();
            
            // Force any active tooltip to close — Tooltip listens on the window,
            // and our e.stopPropagation() above prevents the real click from reaching it.
            const mainWindow = Zotero.getMainWindow();
            mainWindow.dispatchEvent(new MouseEvent('click'));
        }
    };

    const noResultsText = menuMode === 'sources'
        ? "No results found"
        : menuMode === 'libraries'
            ? "No libraries found"
            : menuMode === 'collections'
                ? "No collections found"
                : menuMode === 'tags'
                    ? "No tags found"
                    : "No notes found";

    // The chat editor is the search box for a typed `@` — the caret stays there
    // and whatever follows the `@` is the query. A menu opened from the "+"
    // button has no such query to read, so it renders (and focuses) a search
    // field of its own and leaves the composer alone.
    const ownsSearchField = querySource === 'menu';

    const placeholderText = menuMode === 'sources'
        ? "Search by author, year and title"
        : menuMode === 'libraries'
            ? "Search libraries"
            : menuMode === 'collections'
                ? "Search collections"
                : menuMode === 'tags'
                    ? "Search tags"
                    : "Search notes";

    // Backspace on an empty search field steps back out of a submenu, and
    // closes the menu at the top level. (The editor-driven menu gets the same
    // behavior from `useAddSourcesMenu`, via the menu handle.)
    const handleEmptyBackspace = useCallback(() => {
        if (menuMode !== 'sources') {
            setMenuMode('sources');
            return;
        }
        handleDismiss('keyboard');
    }, [handleDismiss, menuMode]);

    return (
        <>
            <Tooltip content="Add Sources" showArrow singleLine>
                <button
                    // The control row lives inside the composer's <form>, so a
                    // button with no type would default to submit and send the
                    // message on the way to opening the menu.
                    type="button"
                    className="variant-ghost composer-add-sources"
                    ref={buttonRef}
                    onClick={handleButtonClick}
                    aria-label="Add Sources"
                    aria-haspopup="menu"
                    aria-expanded={isMenuOpen}
                    disabled={disabled}
                >
                    <Icon icon={PlusSignIcon} size={18} className="scale-12" />
                </button>
            </Tooltip>
            <SearchMenu
                menuItems={menuItems}
                isOpen={isMenuOpen}
                onClose={handleDismiss}
                position={menuPosition}
                useFixedPosition={true}
                verticalPosition={verticalPosition}
                width="250px"
                maxHeight="300px"
                // The query drives an effect above, so the menu's own field
                // needs no separate search callback.
                onSearch={() => {}}
                noResultsText={noResultsText}
                placeholder={ownsSearchField ? placeholderText : ''}
                closeOnSelect={false}
                searchQuery={searchQuery}
                setSearchQuery={onQueryChange}
                showSearchInput={ownsSearchField}
                onEmptyBackspace={ownsSearchField ? handleEmptyBackspace : undefined}
                // Tab keeps its normal focus-navigation meaning where there is
                // a real input to move out of.
                selectOnTab={!ownsSearchField}
                portalContainer={menuPortalContainer}
            />
        </>
    );
});

export default AddSourcesMenu;
