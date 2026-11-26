/**
 * Text direction for rendered markdown that contains right-to-left text
 * (Arabic, Persian, Urdu, Hebrew, ...), on screen and in Zotero notes.
 *
 * Each block gets an explicit `dir` from the majority of its own letters, so a
 * Persian paragraph that opens with an English name still reads right to left,
 * and an English paragraph quoting one Arabic word stays left to right. List
 * items take their list's direction: an item with its own direction would put
 * its marker on the side its list leaves no room for. Code and math are always
 * laid out left to right inside right-to-left text.
 *
 * By default a tree without right-to-left letters is returned untouched, so
 * markdown in left-to-right scripts renders exactly as it would without these
 * plugins. With `all`, every block is directed: in a right-to-left interface an
 * English reply then still reads left to right.
 */

import { classNames, hastTextContent, type HastNode } from './hast';

type Direction = 'ltr' | 'rtl';

/** Letter counts of a subtree, plus the direction of its first letter. */
interface LetterCounts {
    rtl: number;
    ltr: number;
    first: Direction | null;
}

/** Scripts written right to left. Matches their digits and marks too. */
const RTL_SCRIPT =
    /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;
const LETTER = /\p{L}/u;

/** Blocks that take the direction of their own letters. */
const DIRECTED_BLOCKS = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'ul', 'ol', 'table', 'th', 'td',
]);

/**
 * The directed blocks whose `dir` Zotero's note schema stores (paragraph,
 * heading, list). It drops `dir` on blockquotes and tables.
 */
const NOTE_DIRECTED_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol']);

/** Elements that cannot sit inside a paragraph. */
const NON_PHRASING = new Set([
    'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
    'pre', 'blockquote', 'table', 'hr', 'section',
]);

export interface TextDirectionOptions {
    /** Direct every block, not only those of trees with right-to-left letters. */
    all?: boolean;
    /**
     * Note only: the section headings Beaver writes into a saved chat ("User",
     * "Beaver"). They are interface text, not content, so they keep the
     * reader's direction.
     */
    labels?: readonly string[];
}

/** Where the directions are written, and what that markup can keep. */
interface DirectionTarget {
    /**
     * Write `dir` on a directed block below `parent`, and return the direction
     * written, or null when the target keeps none on it.
     */
    place(node: HastNode, direction: Direction, parent: HastNode): Direction | null;
    /** Whether code or math (`isOpaque`) can be marked left to right. */
    marksOpaque(node: HastNode): boolean;
    /** The surrounding direction may be right to left even without `all`. */
    alwaysBothWays: boolean;
}

const screenTarget: DirectionTarget = {
    place(node, direction) {
        setDirection(node, direction);
        return direction;
    },
    marksOpaque: (node) => node.tagName !== 'citation',
    alwaysBothWays: false,
};

/**
 * A Zotero note keeps `dir` on paragraphs, headings, lists and code blocks.
 * A note opens in its reader's interface direction, which can differ from the
 * writer's, so a directed note directs its left-to-right blocks too.
 */
function noteTarget(labels: ReadonlySet<string>): DirectionTarget {
    return {
        place(node, direction, parent) {
            const tag = node.tagName ?? '';
            // The note editor saves a list item's only paragraph as the item's
            // inline content, dropping its `dir`: such an item keeps its list's.
            if (tag === 'p' && parent.tagName === 'li' && isOnlyElementChild(node, parent)) return null;
            if (/^h[1-6]$/.test(tag) && labels.has(hastTextContent(node).trim())) return null;
            if (NOTE_DIRECTED_BLOCKS.has(tag)) {
                setDirection(node, direction);
                return direction;
            }
            // A cell stores its content as paragraphs, so the direction goes on a
            // paragraph around inline content (what the note editor saves anyway).
            if ((tag === 'td' || tag === 'th') && isInlineContent(node)) {
                node.children = [{ type: 'element', tagName: 'p', properties: { dir: direction }, children: node.children }];
                return direction;
            }
            return null;
        },
        // Inline code and math have no `dir` in a note, and neither has display math.
        marksOpaque: (node) => node.tagName === 'pre' && !classNames(node).includes('math'),
        alwaysBothWays: true,
    };
}

/**
 * Rehype transformer that sets `dir` on blocks of a tree containing
 * right-to-left letters (or of every tree, with `all`), for the chat.
 *
 * Wire it after the math plugin (it recognizes KaTeX output) and before the
 * find highlighter.
 */
export function rehypeTextDirection(options: TextDirectionOptions = {}): (tree: HastNode) => void {
    return (tree: HastNode) => directTree(tree, options.all === true, screenTarget);
}

/**
 * Rehype transformer for markdown written into a Zotero note: the same rule,
 * written only where the note schema keeps a direction.
 *
 * Wire it after `rehypeZoteroMath` (it recognizes Zotero's math markup) and
 * before `rehypeZoteroNoteFootnotes`, so the endnotes heading Beaver adds
 * keeps the reader's interface direction.
 */
export function rehypeNoteTextDirection(options: TextDirectionOptions = {}): (tree: HastNode) => void {
    const target = noteTarget(new Set(options.labels ?? []));
    return (tree: HastNode) => directTree(tree, options.all === true, target);
}

function directTree(tree: HastNode, all: boolean, target: DirectionTarget): void {
    if (!all && !containsRtlScript(tree)) return;
    const counts = new Map<HastNode, LetterCounts>();
    const treeCounts = countLetters(tree, counts);
    if (!all && treeCounts.rtl === 0) return;
    // With `all`, a reply without letters (commands, numbers) reads left to
    // right rather than taking the interface's direction.
    const fallback = majorityDirection(treeCounts) ?? (all ? 'ltr' : null);
    applyDirections(tree, null, fallback, counts, all || target.alwaysBothWays, target);
}

/**
 * Code, math and citations: content whose letters say nothing about the
 * direction of the prose around it.
 */
function isOpaque(node: HastNode): boolean {
    if (node.type !== 'element') return false;
    const tag = node.tagName;
    if (tag === 'code' || tag === 'pre' || tag === 'math' || tag === 'citation') return true;
    // KaTeX output on screen, Zotero's `.math` in a note.
    return classNames(node).some((name) => name === 'katex' || name === 'katex-display' || name === 'math');
}

function isOnlyElementChild(node: HastNode, parent: HastNode): boolean {
    const elements = (parent.children ?? []).filter((child) => child.type === 'element');
    return elements.length === 1 && elements[0] === node;
}

/** Whether an element holds only text and inline elements (and something). */
function isInlineContent(node: HastNode): boolean {
    const children = node.children ?? [];
    return children.length > 0
        && children.every((child) => child.type !== 'element' || !NON_PHRASING.has(child.tagName ?? ''));
}

/** Cheap pre-check: any right-to-left script character outside opaque content. */
function containsRtlScript(node: HastNode): boolean {
    if (node.type === 'text') return typeof node.value === 'string' && RTL_SCRIPT.test(node.value);
    if (isOpaque(node)) return false;
    return node.children?.some(containsRtlScript) ?? false;
}

/** Count the letters below `node`, recording the counts of directed blocks. */
function countLetters(node: HastNode, out: Map<HastNode, LetterCounts>): LetterCounts {
    if (node.type === 'text' && typeof node.value === 'string') return countTextLetters(node.value);
    const counts: LetterCounts = { rtl: 0, ltr: 0, first: null };
    if (isOpaque(node)) return counts;
    for (const child of node.children ?? []) {
        const childCounts = countLetters(child, out);
        counts.rtl += childCounts.rtl;
        counts.ltr += childCounts.ltr;
        counts.first ??= childCounts.first;
    }
    if (node.type === 'element' && DIRECTED_BLOCKS.has(node.tagName ?? '')) out.set(node, counts);
    return counts;
}

function countTextLetters(text: string): LetterCounts {
    const counts: LetterCounts = { rtl: 0, ltr: 0, first: null };
    for (const char of text) {
        if (!LETTER.test(char)) continue;
        const direction: Direction = RTL_SCRIPT.test(char) ? 'rtl' : 'ltr';
        counts[direction]++;
        counts.first ??= direction;
    }
    return counts;
}

/**
 * The direction of a plain text by the same majority rule, for text a note
 * gets outside the Markdown render. Null for text without letters.
 */
export function plainTextDirection(text: string): Direction | null {
    return majorityDirection(countTextLetters(text));
}

/** The direction most of a block's letters are written in; ties go to the first letter. */
function majorityDirection(counts: LetterCounts): Direction | null {
    if (counts.rtl > counts.ltr) return 'rtl';
    if (counts.ltr > counts.rtl) return 'ltr';
    return counts.first;
}

/**
 * Set `dir` on directed blocks, and keep code and math left to right in RTL
 * text.
 *
 * @param inherited The direction set on the nearest ancestor, or null below
 *     none (the surrounding direction applies).
 * @param fallback The whole tree's direction, for a block without letters (a
 *     formula on its own, a row of numbers) that no ancestor directs.
 * @param bothWays The surrounding direction may itself be right to left
 *     (every tree is directed, or a note is): code and math then get a
 *     direction below no directed ancestor too.
 */
function applyDirections(
    node: HastNode,
    inherited: Direction | null,
    fallback: Direction | null,
    counts: Map<HastNode, LetterCounts>,
    bothWays: boolean,
    target: DirectionTarget,
): void {
    for (const child of node.children ?? []) {
        if (child.type !== 'element') continue;
        const existing = child.properties?.dir;
        if (existing === 'ltr' || existing === 'rtl') {
            applyDirections(child, existing, fallback, counts, bothWays, target);
            continue;
        }
        if (isOpaque(child)) {
            const mayBeRtl = inherited === 'rtl' || (bothWays && inherited === null);
            if (mayBeRtl && target.marksOpaque(child)) setDirection(child, 'ltr');
            continue;
        }
        const blockCounts = counts.get(child);
        const direction = blockCounts
            ? majorityDirection(blockCounts) ?? (inherited ? null : fallback)
            : null;
        const written = direction ? target.place(child, direction, node) : null;
        applyDirections(child, written ?? inherited, fallback, counts, bothWays, target);
    }
}

function setDirection(node: HastNode, direction: Direction): void {
    node.properties = { ...node.properties, dir: direction };
}
