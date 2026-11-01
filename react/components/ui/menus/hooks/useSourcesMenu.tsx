import { ItemSearchResult } from '@beaver/agent-core/transport/clients/searchService';
import { SearchMenuItem } from '@beaver/agent-ui/primitives/SearchMenu';
import React, { useEffect, useState } from 'react';
import { UNRESOLVED_LIBRARY_ID } from '../../../../../src/utils/libraryIdentity';
import { getRecentAsync, loadFullItemData } from '../../../../../src/utils/zoteroUtils';
import { getActiveZoteroLibraryId } from '../../../../utils/zoteroTargetContext';
import { ArrowRightIcon, CSSIcon, FileLinkIcon, Icon } from '../../../icons/icons';
import { SourceMenuItemContext, createSourceMenuItem } from '../utils/menuItemFactories';

interface UseSourcesMenuOptions {
    isActive: boolean;
    /** Query typed after the `@` in the chat editor; drives `searchResults`. */
    searchQuery: string;
    searchResults: ItemSearchResult[];
    /** What is currently selected in Zotero's items tree. */
    selectedZoteroItems: Zotero.Item[];
    /** How many item rows the menu offers before anything is typed. */
    proposedItemsLimit: number;
    sourceMenuItemContext: SourceMenuItemContext;
    searchableLibraryIds: number[];
    activeZoteroLibraryId: number | null;
    onNavigateToLibraries: () => void;
    onNavigateToCollections: (libraryId: number) => void;
    onNavigateToTags: (libraryId: number) => void;
    onNavigateToNotes: () => void;
    /** Open a file picker to attach external files (files from disk). */
    onSelectFiles: () => void;
    getRecentItems: () => Promise<Zotero.Item[]>;
    /** How many recently-modified items to read before filtering them down. */
    recentItemsLimit: number;
    verticalPosition?: 'above' | 'below';
    /** Which action rows the target offers; every row when absent. */
    entries?: SourcesMenuEntries;
}

/**
 * The action rows a picker target offers. The composer offers all of them; a
 * target that only takes items, collections and tags (the table card) hides
 * the rest and names the scope rows for what a pick does.
 */
export interface SourcesMenuEntries {
    libraries: boolean;
    notes: boolean;
    files: boolean;
    /** How collection and tag rows are labelled: "Filter by Collections" or "Add Collection". */
    scopeVerb: 'filter' | 'add';
}

interface UseSourcesMenuResult {
    menuItems: SearchMenuItem[];
}

const divider = (): SearchMenuItem => ({ label: '', isDivider: true, onClick: () => {} });
const header = (label: string): SearchMenuItem => ({ label, isGroupHeader: true, onClick: () => {} });

export const useSourcesMenu = ({
    isActive,
    searchQuery,
    searchResults,
    selectedZoteroItems,
    proposedItemsLimit,
    sourceMenuItemContext,
    searchableLibraryIds,
    activeZoteroLibraryId,
    onNavigateToLibraries,
    onNavigateToCollections,
    onNavigateToTags,
    onNavigateToNotes,
    onSelectFiles,
    getRecentItems,
    recentItemsLimit,
    verticalPosition = 'above',
    entries,
}: UseSourcesMenuOptions): UseSourcesMenuResult => {
    const collectionsLabel = entries?.scopeVerb === 'add' ? 'Add Collection' : 'Filter by Collections';
    const tagsLabel = entries?.scopeVerb === 'add' ? 'Add Tag' : 'Filter by Tags';
    const [menuItems, setMenuItems] = useState<SearchMenuItem[]>([]);

    const getEffectiveLibraryId = (libraryId: number | null): number | null => {
        if (libraryId && searchableLibraryIds.includes(libraryId)) {
            return libraryId;
        }
        if (searchableLibraryIds.includes(1)) {
            return 1;
        }
        return null;
    };

    useEffect(() => {
        if (!isActive) {
            setMenuItems([]);
            return;
        }

        let isCancelled = false;

        // Never surface items from excluded libraries — a Zotero selection or a
        // stored recent can predate an exclusion.
        const searchableOnly = (items: (Zotero.Item | null | undefined)[]) =>
            items.filter((item): item is Zotero.Item =>
                Boolean(item) && searchableLibraryIds.includes(item!.libraryID));

        // Already-attached items are excluded: the input-area chips are the
        // "what's attached" affordance, so the menu lists only addable items.
        const notAlreadyAttached = (item: Zotero.Item) =>
            !sourceMenuItemContext.isAttached(item);
        // The target may take only some kinds of item (the table card takes papers).
        const addable = (item: Zotero.Item) =>
            sourceMenuItemContext.canAdd?.(item) ?? true;
        // The target may offer another item in a candidate's place (the table
        // card offers a child attachment as its paper); rows are merged after.
        const asOffered = (items: Zotero.Item[]): Zotero.Item[] => {
            const map = sourceMenuItemContext.asSourceItem;
            if (!map) return items;
            const offered: Zotero.Item[] = [];
            for (const item of items) {
                const mapped = map(item);
                if (mapped && !offered.some((other) => other.id === mapped.id)) offered.push(mapped);
            }
            return offered;
        };

        // A group of item rows, optionally headed. 'above' menus display the
        // array reversed, so the header follows its rows there to land above
        // them on screen.
        const itemSection = (title: string | null, rows: SearchMenuItem[]): SearchMenuItem[] => {
            if (rows.length === 0) return [];
            if (!title) return rows;
            return verticalPosition === 'above' ? [...rows, header(title)] : [header(title), ...rows];
        };

        /** The rows for a typed query: matching items, nothing else. */
        const buildSearchSections = async (): Promise<SearchMenuItem[]> => {
            const items: SearchMenuItem[] = [];
            const seen = new Set<number>();
            for (const result of searchResults) {
                // A portable library ref that couldn't be resolved on this device
                // carries library_id 0, which throws synchronously if looked up.
                if (result.library_id === UNRESOLVED_LIBRARY_ID) {
                    continue;
                }
                const found = await Zotero.Items.getByLibraryAndKeyAsync(result.library_id, result.zotero_key);
                const item = found ? asOffered([found])[0] : null;
                if (!item || !addable(item) || seen.has(item.id)) {
                    continue;
                }
                seen.add(item.id);
                items.push(await createSourceMenuItem(item, sourceMenuItemContext, searchQuery));
            }
            return itemSection('Search Results', items);
        };

        /**
         * The rows shown before anything is typed: the action rows, plus one
         * section of items.
         *
         * A Zotero selection is what the user is most likely to attach, so it
         * takes the item section over the recently-used items; with nothing
         * selected the menu falls back to recents, as before.
         */
        const buildDefaultSections = async (): Promise<SearchMenuItem[]> => {
            const selectedItems = asOffered(searchableOnly(selectedZoteroItems)
                .filter((item) => item.isRegularItem() || item.isAttachment() || item.isNote()))
                .filter(addable)
                .filter(notAlreadyAttached)
                .slice(0, proposedItemsLimit);
            const hasSelection = selectedItems.length > 0;

            const recentItems = hasSelection ? [] : searchableOnly(await getRecentItems());
            // Don't read the personal library's recently-modified items when the
            // user excluded it from Beaver.
            const recentlyModifiedItems = !hasSelection && searchableLibraryIds.includes(1)
                ? searchableOnly(await getRecentAsync(1, { limit: recentItemsLimit * 3 }) as Zotero.Item[])
                : [];

            await loadFullItemData([...selectedItems, ...recentItems, ...recentlyModifiedItems]);

            const activeLibraryIdRaw = activeZoteroLibraryId ?? getActiveZoteroLibraryId();
            const effectiveLibraryId = getEffectiveLibraryId(activeLibraryIdRaw);
            let collectionIds: number[] = [];

            let hasTagsInLibrary = false;

            if (effectiveLibraryId) {
                try {
                    collectionIds = await Zotero.Collections.getAllIDs(effectiveLibraryId);
                } catch {
                    collectionIds = [];
                }
                try {
                    const tags = await Zotero.Tags.getAll(effectiveLibraryId);
                    hasTagsInLibrary = Array.isArray(tags) && tags.length > 0;
                } catch {
                    hasTagsInLibrary = false;
                }
            }

            const canSelectCollections = Boolean(
                effectiveLibraryId &&
                collectionIds.some((id) => {
                    try {
                        const collection = Zotero.Collections.get(id);
                        return collection && !collection.deleted;
                    } catch {
                        return false;
                    }
                })
            );
            const canSelectTags = Boolean(
                effectiveLibraryId &&
                hasTagsInLibrary
            );

            // Action rows are self-describing ("Filter by …" / "Add …"), so
            // the group carries no header; a divider separates it from the
            // item rows. Listed nearest-the-input first, like everything
            // below — see the return.
            const filterItems: SearchMenuItem[] = [];

            if (searchableLibraryIds.length > 1 && entries?.libraries !== false) {
                filterItems.push({
                    label: '"Filter by Library"',
                    onClick: async () => {
                        onNavigateToLibraries();
                    },
                    customContent: (
                        <div className={'display-flex flex-row flex-1 items-start font-color-secondary'}>
                            <div className="display-flex flex-row gap-2">
                                <CSSIcon name="library" className="icon-16 font-color-secondary scale-90" />
                                <div>Filter by Library</div>
                            </div>
                            <div className="flex-1" />
                            <Icon icon={ArrowRightIcon} className="scale-12 mt-020" />
                        </div>
                    )
                });
            }

            filterItems.push({
                label: `"${collectionsLabel}"`,
                onClick: async () => {
                    const latestLibraryIdRaw = getActiveZoteroLibraryId();
                    const latestEffectiveLibraryId = getEffectiveLibraryId(latestLibraryIdRaw);
                    if (!latestEffectiveLibraryId) {
                        return;
                    }
                    onNavigateToCollections(latestEffectiveLibraryId);
                },
                disabled: !canSelectCollections,
                customContent: (
                    <div className={'display-flex flex-row flex-1 items-start font-color-secondary'}>
                        <div className="display-flex flex-col gap-05 min-w-0">
                            <div className="display-flex flex-row gap-2">
                                <CSSIcon name="collection" className="icon-16 font-color-secondary scale-90" />
                                <div>{collectionsLabel}</div>
                            </div>
                        </div>
                        <div className="flex-1" />
                        <Icon icon={ArrowRightIcon} className="scale-12 mt-020" />
                    </div>
                )
            });

            filterItems.push({
                label: `"${tagsLabel}"`,
                onClick: async () => {
                    const latestLibraryIdRaw = getActiveZoteroLibraryId();
                    const latestEffectiveLibraryId = getEffectiveLibraryId(latestLibraryIdRaw);
                    if (!latestEffectiveLibraryId) {
                        return;
                    }
                    onNavigateToTags(latestEffectiveLibraryId);
                },
                disabled: !canSelectTags,
                customContent: (
                    <div className={'display-flex flex-row flex-1 items-start font-color-secondary'}>
                        <div className="display-flex flex-col gap-05 min-w-0">
                            <div className="display-flex flex-row gap-2">
                                <CSSIcon
                                    name="tag"
                                    className="icon-16 font-color-secondary scale-90 icon-tag"
                                />
                                <div>{tagsLabel}</div>
                            </div>
                        </div>
                        <div className="flex-1" />
                        <Icon icon={ArrowRightIcon} className="scale-12 mt-020" />
                    </div>
                )
            });

            if (entries?.notes !== false) filterItems.push({
                label: '"Add Note"',
                onClick: async () => {
                    onNavigateToNotes();
                },
                customContent: (
                    <div className={'display-flex flex-row flex-1 items-start font-color-secondary'}>
                        <div className="display-flex flex-row gap-2">
                            <CSSIcon name="note" className="icon-16 font-color-secondary scale-90" />
                            <div>Add Note</div>
                        </div>
                        <div className="flex-1" />
                        <Icon icon={ArrowRightIcon} className="scale-12 mt-020" />
                    </div>
                )
            });

            if (entries?.files !== false) filterItems.push({
                label: '"Add File"',
                onClick: async () => {
                    onSelectFiles();
                },
                customContent: (
                    <div className={'display-flex flex-row flex-1 items-start font-color-secondary'}>
                        <div className="display-flex flex-row gap-2">
                            {/* <CSSIcon name="attachment-file" className="icon-16 font-color-secondary scale-90" /> */}
                            <Icon icon={FileLinkIcon} className="font-color-secondary mt-015 ml-05 scale-11" />
                            <div>Add External File…</div>
                        </div>
                        <div className="flex-1" />
                    </div>
                )
            });

            let itemRows: SearchMenuItem[];
            if (hasSelection) {
                itemRows = itemSection('Selected in Zotero', await Promise.all(
                    selectedItems.map((item) => createSourceMenuItem(item, sourceMenuItemContext))
                ));
            } else {
                const recentCandidates = asOffered([...recentItems, ...recentlyModifiedItems
                    .map((item) => (item.parentItem ? item.parentItem : item))
                    .filter((item): item is Zotero.Item => Boolean(item))
                    .filter((item) => item.isRegularItem() || item.isAttachment() || item.isNote())])
                    .filter((item, index, self) => index === self.findIndex((candidate) => candidate.id === item.id))
                    .filter(addable)
                    .filter(notAlreadyAttached)
                    .slice(0, proposedItemsLimit);

                await loadFullItemData(recentCandidates);

                // Unheaded: recents are the menu's resting state, so a header
                // would label the obvious. A Zotero selection does get one,
                // since it explains why those particular items are offered.
                itemRows = itemSection(null, await Promise.all(
                    recentCandidates.map((item) => createSourceMenuItem(item, sourceMenuItemContext))
                ));
            }

            const groupDivider = filterItems.length > 0 && itemRows.length > 0 ? [divider()] : [];

            // Ordered by distance from the chat input, nearest first: the
            // proposed items, then the action rows out to "Add External File".
            // That reads the same whichever way the menu opens, and needs no
            // per-layout special case — a menu that opens above the input
            // displays this array reversed, which walks it back out from the
            // input in the same order.
            return [...itemRows, ...groupDivider, ...filterItems];
        };

        const build = async () => {
            const sections = searchQuery.trim()
                ? await buildSearchSections()
                : await buildDefaultSections();
            if (!isCancelled) setMenuItems(sections);
        };

        build();

        return () => {
            isCancelled = true;
        };
    }, [
        isActive,
        searchQuery,
        searchResults,
        selectedZoteroItems,
        proposedItemsLimit,
        sourceMenuItemContext,
        searchableLibraryIds,
        activeZoteroLibraryId,
        onNavigateToLibraries,
        onNavigateToCollections,
        onNavigateToTags,
        onNavigateToNotes,
        onSelectFiles,
        getRecentItems,
        recentItemsLimit,
        verticalPosition,
        entries,
        collectionsLabel,
        tagsLabel,
    ]);

    return { menuItems };
};
