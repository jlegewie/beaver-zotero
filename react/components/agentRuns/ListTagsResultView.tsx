import React, { useState } from 'react';
import { TagInfo } from '../../agents/toolResultTypes';

interface ListTagsResultViewProps {
    tags: TagInfo[];
    totalCount: number;
    libraryId?: number | null;
}

/**
 * Renders the result of a list_tags tool.
 * Shows tags as chips with item counts.
 * Clicking a tag triggers a Zotero search for items with that tag.
 */
export const ListTagsResultView: React.FC<ListTagsResultViewProps> = ({
    tags,
    totalCount,
    libraryId
}) => {
    const [hoveredTag, setHoveredTag] = useState<string | null>(null);

    if (tags.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No tags found
            </div>
        );
    }

    const handleTagClick = async (tagName: string) => {
        // Get the active Zotero pane and trigger a tag search
        const zoteroPane = Zotero.getActiveZoteroPane();
        if (!zoteroPane) return;

        try {
            // Switch to library if specified
            if (libraryId != null && zoteroPane.collectionsView) {
                await zoteroPane.collectionsView.selectLibrary(libraryId);
            }
            
            // Set the tag filter in Zotero's search
            if (zoteroPane.tagSelector) {
                // Clear existing tag selection and select this tag
                zoteroPane.tagSelector.clearTagSelection();
                zoteroPane.tagSelector.handleTagClick(tagName);
            }
        } catch (error) {
            // Silently fail - tag selection is a convenience feature
        }
    };

    return (
        <div className="display-flex flex-col">
            <div className="display-flex flex-row flex-wrap gap-1 p-15">
                {tags.map((tag) => {
                    const isHovered = hoveredTag === tag.name;
                    
                    return (
                        <div
                            key={tag.name}
                            className={`display-flex flex-row items-center gap-1 px-2 py-05 rounded cursor-pointer transition-colors duration-150 ${
                                isHovered ? 'bg-tertiary' : 'bg-secondary'
                            }`}
                            title={`${tag.item_count} item${tag.item_count !== 1 ? 's' : ''} - Click to filter by tag`}
                            onClick={() => handleTagClick(tag.name)}
                            onMouseEnter={() => setHoveredTag(tag.name)}
                            onMouseLeave={() => setHoveredTag(null)}
                        >
                            {tag.color && (
                                <span
                                    className="w-2 h-2 rounded-full flex-shrink-0"
                                    style={{ backgroundColor: tag.color }}
                                />
                            )}
                            <span className="text-sm font-color-primary">
                                {tag.name}
                            </span>
                            <span className="text-xs font-color-tertiary">
                                ({tag.item_count})
                            </span>
                        </div>
                    );
                })}
            </div>
            {totalCount > tags.length && (
                <div className="px-15 py-2 text-xs font-color-tertiary border-t border-primary">
                    Showing {tags.length} of {totalCount} tags
                </div>
            )}
        </div>
    );
};

export default ListTagsResultView;
