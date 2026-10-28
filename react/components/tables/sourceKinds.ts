import type React from 'react';
import { BookCopyIcon, FilterIcon, FolderIcon, TagIcon } from '../icons/icons';

type IconComponent = React.ComponentType<React.SVGProps<SVGSVGElement>>;

/**
 * The icon for a source entry: `items`, or a library entry's scope kind
 * (`collection`, `tag`, `saved_search`). Source kinds share one Beaver icon
 * family, including kinds Zotero has no icon for.
 */
export function sourceKindIcon(type: string, kind?: string | null): IconComponent {
    if (type === 'items') return BookCopyIcon;
    return kind === 'collection' ? FolderIcon : kind === 'tag' ? TagIcon : FilterIcon;
}
