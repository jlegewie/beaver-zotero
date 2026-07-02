import React from 'react';
import { TagListView, TagRowView } from '../../../types/toolResultViews';

const plural = (n: number, noun: string) => `${n} ${noun}${n !== 1 ? 's' : ''}`;

/** Total number of objects (across all types) carrying the tag. */
const tagTotal = (tag: TagRowView): number =>
    (tag.item_count ?? 0) + (tag.attachment_count ?? 0) + (tag.note_count ?? 0) + (tag.annotation_count ?? 0);

/** Human-readable breakdown, e.g. "5 items, 2 attachments, 1 annotation". */
const tagTooltip = (tag: TagRowView): string => {
    const parts: string[] = [];
    if (tag.item_count) parts.push(plural(tag.item_count, 'item'));
    if (tag.attachment_count) parts.push(plural(tag.attachment_count, 'attachment'));
    if (tag.note_count) parts.push(plural(tag.note_count, 'note'));
    if (tag.annotation_count) parts.push(plural(tag.annotation_count, 'annotation'));
    // Fall back to the total when every category is zero (keeps "0 items").
    return parts.length > 0 ? parts.join(', ') : plural(tagTotal(tag), 'item');
};

/**
 * Shared renderer for the {@link TagListView} view model (list_tags).
 *
 * Renders non-interactive tag chips with a total tagged-object count. The
 * tooltip breaks the total down by object type (items, attachments, notes,
 * annotations) when that detail is available.
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
                        title={tagTooltip(tag)}
                    >
                        <span className="text-sm font-color-primary truncate min-w-0">
                            {tag.name}
                            <span className="text-xs font-color-tertiary ml-1">
                                ({tagTotal(tag)})
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
