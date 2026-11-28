import React from 'react';
import { ActionCategory, KnownActionCategory } from '@beaver/agent-core/types/actions';
import { BookSearchIcon, HighlighterIcon, LayersIcon, QuillWriteIcon, ZapIcon } from './icons';

type IconComponent = React.ComponentType<React.SVGProps<SVGSVGElement>>;

const CATEGORY_ICON_ENTRIES = {
    research: BookSearchIcon,
    write: QuillWriteIcon,
    organize: LayersIcon,
    annotate: HighlighterIcon,
} satisfies Record<KnownActionCategory, IconComponent>;

/** Map so Object.prototype names (`constructor`, …) don't inherit a function. */
const CATEGORY_ICONS = new Map<string, IconComponent>(Object.entries(CATEGORY_ICON_ENTRIES));

/**
 * The icon for an action's category — the same one the homepage category
 * buttons use. Zap for no category or one this build doesn't know.
 */
export const categoryIcon = (category: ActionCategory | undefined): IconComponent =>
    (category && CATEGORY_ICONS.get(category)) || ZapIcon;
