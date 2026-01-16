import React from 'react';
import { TagInfo } from '../../agents/toolResultTypes';

interface ListTagsResultViewProps {
    tags: TagInfo[];
    totalCount: number;
    libraryName?: string | null;
}

/**
 * Renders the result of a list_tags tool.
 * Shows tags as chips with item counts.
 */
export const ListTagsResultView: React.FC<ListTagsResultViewProps> = ({
    tags,
    totalCount,
    libraryName
}) => {
    if (tags.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No tags found
            </div>
        );
    }

    return (
        <div className="display-flex flex-col">
            {libraryName && (
                <div className="px-15 py-1 text-xs font-color-tertiary border-b border-primary">
                    {libraryName}
                </div>
            )}
            <div className="display-flex flex-row flex-wrap gap-1 p-15">
                {tags.map((tag) => (
                    <div
                        key={tag.name}
                        className="display-flex flex-row items-center gap-1 px-2 py-05 rounded bg-secondary"
                        title={`${tag.item_count} item${tag.item_count !== 1 ? 's' : ''}`}
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
                ))}
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
