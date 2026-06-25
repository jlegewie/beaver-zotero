import React from 'react';
import { TagListView } from '../../../types/toolResultViews';

/**
 * Shared renderer for the {@link TagListView} view model (list_tags).
 *
 * Renders non-interactive tag chips with item counts.
 */
export const TagListResultView: React.FC<{ view: TagListView }> = ({ view }) => {
    const tags = view.tags;

    if (tags.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No tags found
            </div>
        );
    }

    return (
        <div className="display-flex flex-col min-w-0">
            <div className="display-flex flex-row flex-wrap gap-1 p-15 min-w-0">
                {tags.map((tag) => (
                    <div
                        key={tag.name}
                        className="display-flex flex-row items-center min-w-0 px-2 py-05 rounded-md whitespace-nowrap bg-quaternary"
                        title={`${tag.item_count} item${tag.item_count !== 1 ? 's' : ''}`}
                    >
                        <span className="text-sm font-color-primary truncate min-w-0">
                            {tag.name}
                            <span className="text-xs font-color-tertiary ml-1">
                                ({tag.item_count})
                            </span>
                        </span>
                    </div>
                ))}
            </div>
            {view.total_count > tags.length && (
                <div className="px-15 py-2 text-xs font-color-tertiary border-t border-primary">
                    Showing {tags.length} of {view.total_count} tags
                </div>
            )}
        </div>
    );
};

export default TagListResultView;
