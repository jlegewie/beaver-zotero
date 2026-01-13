import { useEffect, useState } from 'react';
import { SearchMenuItem } from '../SearchMenu';
import { TagMenuItemContext, createTagMenuItem } from '../utils/menuItemFactories';
import { getActiveZoteroLibraryId } from '../../../../../src/utils/zoteroUtils';
import { ZoteroTag } from '../../../../types/zotero';

interface UseTagsMenuOptions {
    isActive: boolean;
    searchQuery: string;
    searchableLibraryIds: number[];
    tagMenuItemContext: TagMenuItemContext;
}

interface UseTagsMenuResult {
    menuItems: SearchMenuItem[];
}

export const useTagsMenu = ({
    isActive,
    searchQuery,
    searchableLibraryIds,
    tagMenuItemContext
}: UseTagsMenuOptions): UseTagsMenuResult => {
    const [menuItems, setMenuItems] = useState<SearchMenuItem[]>([]);
    const [tags, setTags] = useState<ZoteroTag[]>([]);
    const [activeLibraryId, setActiveLibraryId] = useState<number | null>(null);

    useEffect(() => {
        if (!isActive) {
            setTags([]);
            setMenuItems([]);
            setActiveLibraryId(null);
            return;
        }

        let isCancelled = false;

        const fetchTags = async () => {
            const libraryId = getActiveZoteroLibraryId();
            setActiveLibraryId(libraryId);

            if (!libraryId || !searchableLibraryIds.includes(libraryId)) {
                if (!isCancelled) {
                    setTags([]);
                }
                return;
            }

            try {
                // Use Zotero.Tags.getAll to fetch tags (types: [0] excludes automatic tags)
                // const tagData = await Zotero.Tags.getAll(libraryId, [0]);
                const tagData = await Zotero.Tags.getAll(libraryId);

                // Map tag data to ZoteroTag format, filtering out invalid tags
                const availableTags = tagData
                    .map((tagJson) => {
                        const tagID = Zotero.Tags.getID(tagJson.tag);
                        if (tagID === false) {
                            return null;
                        }
                        
                        // Fetch color for this tag
                        const colorData = Zotero.Tags.getColor(libraryId, tagJson.tag);
                        const color = colorData && typeof colorData === 'object' && 'color' in colorData 
                            ? colorData.color 
                            : undefined;
                        
                        return {
                            id: tagID,
                            tag: tagJson.tag,
                            libraryId: libraryId,
                            type: tagJson.type ?? 0,
                            color: color
                        } as ZoteroTag;
                    })
                    .filter((tag): tag is ZoteroTag => tag !== null)
                    .sort((a, b) => {
                        // First priority: selected tags
                        const aIsSelected = tagMenuItemContext.currentTags.some((selected) => selected.id === a.id);
                        const bIsSelected = tagMenuItemContext.currentTags.some((selected) => selected.id === b.id);
                        if (aIsSelected !== bIsSelected) {
                            return aIsSelected ? -1 : 1;
                        }
                        
                        // Second priority: tags with color
                        const aHasColor = a.color !== undefined;
                        const bHasColor = b.color !== undefined;
                        if (aHasColor !== bHasColor) {
                            return aHasColor ? -1 : 1;
                        }
                        
                        // Third priority: tags with type == 0
                        const aTypeZero = a.type === 0;
                        const bTypeZero = b.type === 0;
                        if (aTypeZero !== bTypeZero) {
                            return aTypeZero ? -1 : 1;
                        }
                        
                        // Fourth priority: sort by name
                        return a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' });
                    })
                    .reverse();

                if (!isCancelled) {
                    setTags(availableTags);
                }
            } catch (error) {
                console.error('Error fetching tags:', error);
                if (!isCancelled) {
                    setTags([]);
                }
            }
        };

        fetchTags();

        return () => {
            isCancelled = true;
        };
    }, [isActive, searchableLibraryIds, tagMenuItemContext]);

    useEffect(() => {
        if (!isActive) {
            return;
        }

        const lowerCaseQuery = searchQuery.toLowerCase();
        const filteredTags = tags.filter((tag) =>
            tag.tag.toLowerCase().includes(lowerCaseQuery)
        );
        const items = filteredTags.map((tag) =>
            createTagMenuItem(tag, tagMenuItemContext)
        );

        let headerLabel = 'Select Tags';
        if (activeLibraryId) {
            const library = Zotero.Libraries.get(activeLibraryId);
            headerLabel = library ? `Tags in ${library.name}` : headerLabel;
        }

        const header: SearchMenuItem = { label: headerLabel, isGroupHeader: true, onClick: () => {} };
        setMenuItems([...items.reverse(), header]);
    }, [isActive, searchQuery, tags, tagMenuItemContext, activeLibraryId]);

    return { menuItems };
};

