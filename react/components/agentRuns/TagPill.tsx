import React from 'react';
import { Icon, TagIcon } from '../icons/icons';

/**
 * Shared tag pill used by agent-run previews (manage_tags, organize_items,
 * annotation tagging). Renders a tag name with a leading tag icon.
 */
export const TagPill: React.FC<{ name: string; strike?: boolean }> = ({ name, strike }) => (
    <span
        className="inline-flex items-center gap-1 text-xs px-2 py-05 rounded-md bg-quaternary font-color-secondary border-quinary"
        style={strike ? { textDecoration: 'line-through' } : undefined}
    >
        <span className="display-flex">
            <Icon icon={TagIcon} />
        </span>
        {name}
    </span>
);

export default TagPill;
