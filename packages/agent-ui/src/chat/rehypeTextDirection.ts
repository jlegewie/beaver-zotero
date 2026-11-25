/**
 * Text direction for rendered markdown that contains right-to-left text
 * (Arabic, Persian, Urdu, Hebrew, ...).
 *
 * Each block gets an explicit `dir` from the majority of its own letters, so a
 * Persian paragraph that opens with an English name still reads right to left,
 * and an English paragraph quoting one Arabic word stays left to right. List
 * items take their list's direction: an item with its own direction would put
 * its marker on the side its list leaves no room for. Code and math are always
 * laid out left to right inside right-to-left text.
 *
 * A tree without right-to-left letters is returned untouched, so markdown in
 * left-to-right scripts renders exactly as it would without this plugin.
 */

import { classNames, type HastNode } from './hast';

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
 * Rehype transformer that sets `dir` on blocks of a tree containing
 * right-to-left letters.
 *
 * Wire it after the math plugin (it recognizes KaTeX output) and before the
 * find highlighter.
 */
export function rehypeTextDirection(): (tree: HastNode) => void {
    return (tree: HastNode) => {
        if (!containsRtlScript(tree)) return;
        const counts = new Map<HastNode, LetterCounts>();
        const treeCounts = countLetters(tree, counts);
        if (treeCounts.rtl === 0) return;
        applyDirections(tree, null, majorityDirection(treeCounts), counts);
    };
}

/**
 * Code, math and citations: content whose letters say nothing about the
 * direction of the prose around it.
 */
function isOpaque(node: HastNode): boolean {
    if (node.type !== 'element') return false;
    const tag = node.tagName;
    if (tag === 'code' || tag === 'pre' || tag === 'math' || tag === 'citation') return true;
    return classNames(node).some((name) => name === 'katex' || name === 'katex-display');
}

/** Cheap pre-check: any right-to-left script character outside opaque content. */
function containsRtlScript(node: HastNode): boolean {
    if (node.type === 'text') return typeof node.value === 'string' && RTL_SCRIPT.test(node.value);
    if (isOpaque(node)) return false;
    return node.children?.some(containsRtlScript) ?? false;
}

/** Count the letters below `node`, recording the counts of directed blocks. */
function countLetters(node: HastNode, out: Map<HastNode, LetterCounts>): LetterCounts {
    const counts: LetterCounts = { rtl: 0, ltr: 0, first: null };
    if (node.type === 'text' && typeof node.value === 'string') {
        for (const char of node.value) {
            if (!LETTER.test(char)) continue;
            const direction: Direction = RTL_SCRIPT.test(char) ? 'rtl' : 'ltr';
            counts[direction]++;
            counts.first ??= direction;
        }
        return counts;
    }
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
 *     none (the surrounding UI's direction applies).
 * @param fallback The whole tree's direction, for a block without letters (a
 *     formula on its own, a row of numbers) that no ancestor directs.
 */
function applyDirections(
    node: HastNode,
    inherited: Direction | null,
    fallback: Direction | null,
    counts: Map<HastNode, LetterCounts>,
): void {
    for (const child of node.children ?? []) {
        if (child.type !== 'element') continue;
        const existing = child.properties?.dir;
        if (existing === 'ltr' || existing === 'rtl') {
            applyDirections(child, existing, fallback, counts);
            continue;
        }
        if (isOpaque(child)) {
            if (inherited === 'rtl' && child.tagName !== 'citation') setDirection(child, 'ltr');
            continue;
        }
        const blockCounts = counts.get(child);
        const direction = blockCounts
            ? majorityDirection(blockCounts) ?? (inherited ? null : fallback)
            : null;
        if (direction) setDirection(child, direction);
        applyDirections(child, direction ?? inherited, fallback, counts);
    }
}

function setDirection(node: HastNode, direction: Direction): void {
    node.properties = { ...node.properties, dir: direction };
}
