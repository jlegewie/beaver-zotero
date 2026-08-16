import { getPref } from '../utils/prefs';

export const BEAVER_ANNOTATION_AUTHOR = 'Beaver';
export const BEAVER_CITATION_ANNOTATION_AUTHOR = 'Beaver Citation';
export const BEAVER_VISUALIZER_ANNOTATION_AUTHOR = 'Beaver Visualizer';

export const DEFAULT_BEAVER_ANNOTATION_COLOR = '#ffd400';

export const ZOTERO_ANNOTATION_PALETTE_COLORS: Record<string, string> = {
    yellow: '#ffd400',
    red: '#ff6666',
    green: '#5fb236',
    blue: '#2ea8e5',
    purple: '#a28ae5',
    magenta: '#e56eee',
    orange: '#f19837',
    gray: '#aaaaaa',
};

export const ANNOTATION_TYPE_DB_IDS: Record<string, number> = {
    highlight: 1,
    note: 2,
    image: 3,
    ink: 4,
    underline: 5,
    text: 6,
};

/**
 * Maps annotation color names to hex values. The eight standard names map to
 * Zotero's native annotation palette (the same values used by Zotero's reader
 * and color filter) so Beaver-created highlights and notes are visually and
 * functionally identical to user-created ones — e.g. selecting "blue" in the
 * reader and asking Beaver for a "blue" highlight produce the same color, and
 * both show up under the same swatch in the annotation color filter.
 *
 * The backend only ever emits these eight names; the remaining entries are
 * tolerated fallbacks for names without a Zotero palette equivalent.
 */
export const BEAVER_ANNOTATION_COLORS: Record<string, string> = {
    ...ZOTERO_ANNOTATION_PALETTE_COLORS,
    // Non-palette names retained for forward compatibility; not emitted by the backend.
    pink: '#ff66c4',
    brown: '#e6a86e',
    cyan: '#7fdbff',
    lime: '#b4ff69',
    mint: '#b2f7d3',
    coral: '#ff9999',
    navy: '#6495ed',
    olive: '#e6e68a',
    teal: '#7fffd4',
};

/**
 * Resolve a Beaver annotation color name to its hex value, falling back to the
 * default highlight color for missing or unknown names.
 */
export function resolveBeaverAnnotationColor(color?: string | null): string {
    if (!color) return DEFAULT_BEAVER_ANNOTATION_COLOR;
    return BEAVER_ANNOTATION_COLORS[color] ?? DEFAULT_BEAVER_ANNOTATION_COLOR;
}

const BEAVER_ANNOTATION_AUTHORS = new Set([
    BEAVER_ANNOTATION_AUTHOR,
    BEAVER_CITATION_ANNOTATION_AUTHOR,
    BEAVER_VISUALIZER_ANNOTATION_AUTHOR,
]);

/**
 * Author name stored on annotations Beaver creates. Empty string means no
 * attribution. Not a reliable authorship signal — see beaverAnnotationRegistry.
 */
export function getBeaverAnnotationAuthorName(): string {
    const configured = getPref('annotationAuthorName');
    return typeof configured === 'string' ? configured.trim() : BEAVER_ANNOTATION_AUTHOR;
}

/**
 * Whether an annotation's author marks it as Beaver's (agent, citation
 * preview, visualizer, etc.).
 *
 * Matches the built-in names (kept on older annotations) plus the configured
 * name, unless that name is empty or the user's own Zotero display name — then
 * matching it would misclassify the user's annotations.
 */
export function isBeaverAuthoredAnnotation(authorName: string | undefined | null): boolean {
    if (!authorName) return false;
    if (BEAVER_ANNOTATION_AUTHORS.has(authorName)) return true;
    const configured = getBeaverAnnotationAuthorName();
    if (!configured || configured !== authorName) return false;
    return configured !== (Zotero.Users.getCurrentName() || '');
}
