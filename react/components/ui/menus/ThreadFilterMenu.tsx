import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { FilterIcon, ArrowDownIcon, Icon } from '../../icons/icons';
import SearchMenu, { MenuPosition, SearchMenuItem } from './SearchMenu';
import { ChipButton } from '../../agentRuns/requestChips/ChipButton';
import { createThreadFilterMenuItem, ThreadFilterMenuItemContext } from './utils/menuItemFactories';
import { ThreadItemFilter } from '../../../atoms/ui';
import { isLibraryTabAtom, selectedZoteroTabIdAtom } from '../../../atoms/ui';
import { selectedZoteroItemsAtom } from '../../../atoms/zoteroContext';
import { searchableLibraryIdsAtom } from '../../../atoms/profile';
import { getCurrentContextItemForFilter } from '../../../utils/zoteroTabContext';
import { getActiveZoteroLibraryId, getRecentAsync, loadFullItemData } from '../../../../src/utils/zoteroUtils';
import { UNRESOLVED_LIBRARY_ID } from '../../../../src/utils/libraryIdentity';
import { searchTitleCreatorYear, scoreSearchResult } from '../../../utils/search';
import { getPref } from '../../../../src/utils/prefs';
import { logger } from '../../../../src/utils/logger';
import Tooltip from '../Tooltip';

const RECENT_ITEMS_LIMIT = 5;
const RECENTLY_MODIFIED_LIMIT = 15;

interface RecentItemRef {
    zotero_key: string;
    library_id: number;
}

/**
 * Reads the "recentItems" preference (shared with `AddSourcesMenu`'s recent
 * source list) and resolves each entry to a live Zotero item. Entries with
 * an unresolved portable library ref (library_id 0) are skipped since
 * looking them up throws synchronously.
 */
const getRecentItemsFromPref = async (searchableLibraryIds: number[]): Promise<Zotero.Item[]> => {
    const recentItemsPref = getPref('recentItems');
    if (!recentItemsPref) return [];

    const parsed = JSON.parse(recentItemsPref as string);
    if (!Array.isArray(parsed)) return [];

    const items = await Promise.all(
        parsed
            .filter((entry): entry is RecentItemRef =>
                typeof entry === 'object' &&
                entry !== null &&
                'zotero_key' in entry &&
                'library_id' in entry &&
                entry.library_id !== UNRESOLVED_LIBRARY_ID &&
                searchableLibraryIds.includes(entry.library_id)
            )
            .map((entry) => Zotero.Items.getByLibraryAndKeyAsync(entry.library_id, entry.zotero_key))
    );
    return items.filter((item): item is Zotero.Item => Boolean(item));
};

export interface ThreadFilterMenuProps {
    activeFilter: ThreadItemFilter | null;
    onSelect: (item: Zotero.Item) => void;
    menuPortalContainer?: HTMLElement | null;
}

/**
 * Trigger button + single-select item picker for filtering the thread list
 * to chats related to a Zotero item. The default (no-query) view offers the
 * current reader/note/library selection as the first row, followed by
 * recently used items; typing searches by title, creator, and year.
 */
const ThreadFilterMenu: React.FC<ThreadFilterMenuProps> = ({ activeFilter, onSelect, menuPortalContainer }) => {
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<Zotero.Item[]>([]);
    const [contextItem, setContextItem] = useState<Zotero.Item | null>(null);
    const [recentItems, setRecentItems] = useState<Zotero.Item[]>([]);

    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);
    const selectedTabId = useAtomValue(selectedZoteroTabIdAtom);
    const selectedZoteroItems = useAtomValue(selectedZoteroItemsAtom);

    // Guards against a stale search response overwriting a newer one.
    const currentSearchRef = useRef<string>('');

    // Builds the default (no-query) rows whenever the menu opens: the
    // current reader/note/library selection, followed by recently used
    // items. Both sources are filtered to searchable libraries only.
    useEffect(() => {
        if (!isMenuOpen) {
            setContextItem(null);
            setRecentItems([]);
            return;
        }

        let isCancelled = false;

        const buildDefaultItems = async () => {
            const rawContextItem = getCurrentContextItemForFilter(isLibraryTab, selectedTabId, selectedZoteroItems);
            const resolvedContextItem = rawContextItem && searchableLibraryIds.includes(rawContextItem.libraryID)
                ? rawContextItem
                : null;

            const recentFromPref = await getRecentItemsFromPref(searchableLibraryIds);

            // Prefer the active library for "recently modified" items; fall
            // back to the user library only if it's searchable, otherwise
            // skip this source entirely (no library to hard-code safely).
            const activeLibraryId = getActiveZoteroLibraryId();
            const recentLibraryId = activeLibraryId !== null && searchableLibraryIds.includes(activeLibraryId)
                ? activeLibraryId
                : searchableLibraryIds.includes(Zotero.Libraries.userLibraryID)
                    ? Zotero.Libraries.userLibraryID
                    : null;
            const recentlyModifiedRaw = recentLibraryId !== null
                ? (await getRecentAsync(recentLibraryId, { limit: RECENTLY_MODIFIED_LIMIT })) as Zotero.Item[]
                : [];
            // Annotations and other child items resolve to their parent
            // regular item before the type filter below.
            const recentlyModified = recentlyModifiedRaw
                .map((item) => item.parentItem ?? item)
                .filter((item): item is Zotero.Item => Boolean(item))
                .filter((item) => item.isRegularItem() || item.isAttachment() || item.isNote());

            const combinedRecent = [...recentFromPref, ...recentlyModified]
                .filter((item) => searchableLibraryIds.includes(item.libraryID))
                .filter((item, index, self) => index === self.findIndex((candidate) => candidate.id === item.id))
                .filter((item) => !resolvedContextItem || item.id !== resolvedContextItem.id)
                .slice(0, RECENT_ITEMS_LIMIT);

            const itemsToLoad = resolvedContextItem ? [resolvedContextItem, ...combinedRecent] : combinedRecent;
            await loadFullItemData(itemsToLoad);

            if (isCancelled) return;
            setContextItem(resolvedContextItem);
            setRecentItems(combinedRecent);
        };

        buildDefaultItems().catch((error) => {
            logger(`ThreadFilterMenu.buildDefaultItems: ${error}`, 1);
        });

        return () => {
            isCancelled = true;
        };
    }, [isMenuOpen, searchableLibraryIds, isLibraryTab, selectedTabId, selectedZoteroItems]);

    const defaultMenuItems = useMemo<SearchMenuItem[]>(() => {
        const ctx: ThreadFilterMenuItemContext = { activeFilter, onSelect };
        const rows: SearchMenuItem[] = [];
        if (contextItem) {
            rows.push(createThreadFilterMenuItem(contextItem, ctx));
        }
        if (recentItems.length > 0) {
            rows.push({ label: 'Recent Items', isGroupHeader: true, onClick: () => {} });
            rows.push(...recentItems.map((item) => createThreadFilterMenuItem(item, ctx)));
        }
        return rows;
    }, [contextItem, recentItems, activeFilter, onSelect]);

    const handleSearch = useCallback(async (query: string, limit: number = 10) => {
        if (!query.trim()) return;

        const searchId = Date.now().toString();
        currentSearchRef.current = searchId;

        // An empty searchable-library list means every library is excluded.
        // An empty `libraryIds` array passed to `searchTitleCreatorYear`
        // adds no library restriction and would search every library
        // instead, so this returns no results without calling the search.
        if (searchableLibraryIds.length === 0) {
            setSearchResults([]);
            return;
        }

        try {
            let normalizedQuery = query.replace(/ (?:&|and) /g, ' ');
            normalizedQuery = normalizedQuery.replace(/,/, ' ');
            normalizedQuery = normalizedQuery.replace(/&/, ' ');
            normalizedQuery = normalizedQuery.replace(/ ?(\d{1,4})$/, ' $1');
            normalizedQuery = normalizedQuery.trim();

            const resultsItems = await searchTitleCreatorYear(normalizedQuery, searchableLibraryIds);
            await loadFullItemData(resultsItems);

            if (searchId !== currentSearchRef.current) return;

            // The filter search intentionally targets regular items only —
            // attachments and notes remain reachable as filter targets
            // through the current-context row and recent items above.
            const regularItems = resultsItems.filter((item) => item.isRegularItem());

            const scoredResults = regularItems
                .map((item) => ({ item, score: scoreSearchResult(item, normalizedQuery) }))
                .filter((result) => result.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, limit)
                .map((result) => result.item);

            if (searchId !== currentSearchRef.current) return;

            setSearchResults(scoredResults);
        } catch (error) {
            logger(`ThreadFilterMenu.handleSearch: ${error}`, 1);
        }
    }, [searchableLibraryIds]);

    const searchResultMenuItems = useMemo<SearchMenuItem[]>(() => {
        const ctx: ThreadFilterMenuItemContext = { activeFilter, onSelect };
        return searchResults.map((item) => createThreadFilterMenuItem(item, ctx));
    }, [searchResults, activeFilter, onSelect]);

    const menuItems = searchQuery.trim() ? searchResultMenuItems : defaultMenuItems;

    const handleButtonClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setMenuPosition({ x: rect.left, y: rect.bottom });
        setIsMenuOpen(true);
    }, []);

    const handleMenuClose = useCallback(() => {
        setIsMenuOpen(false);
        setSearchQuery('');
        setSearchResults([]);
    }, []);

    return (
        <>
            <Tooltip content="Filter chats by item" disabled={isMenuOpen}>
                <ChipButton
                    onClick={handleButtonClick}
                    aria-label="Filter chats by item"
                    aria-haspopup="menu"
                    aria-expanded={isMenuOpen}
                >
                    <Icon icon={FilterIcon} className="scale-12" />
                    <span>Filter</span>
                    <Icon icon={ArrowDownIcon} className="scale-11" />
                </ChipButton>
            </Tooltip>
            <SearchMenu
                menuItems={menuItems}
                isOpen={isMenuOpen}
                onClose={handleMenuClose}
                position={menuPosition}
                useFixedPosition
                verticalPosition="below"
                width="250px"
                maxHeight="300px"
                onSearch={handleSearch}
                noResultsText="No results found"
                placeholder="Search by author, year and title"
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                onEmptyBackspace={handleMenuClose}
                portalContainer={menuPortalContainer}
            />
        </>
    );
};

export default ThreadFilterMenu;
