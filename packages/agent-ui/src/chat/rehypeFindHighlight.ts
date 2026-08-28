import { FIND_HIT_ATTR, FIND_HIT_CLASS, findMatchRanges } from './findContext';

/**
 * The hast shapes this transformer touches. `@types/hast` is deliberately not
 * available here — the package pins its ambient types to react + react-dom — so
 * the handful of fields used are declared locally. One permissive interface
 * covers roots (`type: 'root'`), elements (`type: 'element'`) and text nodes
 * (`type: 'text'`).
 */
interface HastNode {
    type: string;
    tagName?: string;
    value?: string;
    properties?: Record<string, unknown>;
    children?: HastNode[];
}

/** Class-name substrings whose subtrees must never be marked. */
const SKIPPED_CLASS_PARTS = ['katex', 'math'];

/**
 * Rehype transformer factory that wraps find matches in the rendered markdown
 * in the same `<mark>` the plain-text helper produces.
 *
 * Wire it after sanitization and after the math plugin: it inserts markup the
 * sanitize schema does not have to allow, and it can only recognize KaTeX
 * output once KaTeX has produced it.
 *
 * @param query The active find query. Empty means no-op.
 */
export function rehypeFindHighlight(query: string): (tree: HastNode) => void {
    if (!query) return () => {};
    return (tree: HastNode) => {
        highlightChildren(tree, query);
    };
}

/**
 * Subtrees that must be left alone.
 *
 * Splitting a text node inside KaTeX output breaks its layout and corrupts the
 * MathML annotation it carries for copy/paste; `<citation>` is replaced
 * wholesale by a React component, which would drop injected markup anyway.
 */
function isSkipped(node: HastNode): boolean {
    if (node.type !== 'element') return false;
    if (node.tagName === 'citation') return true;
    return classNames(node).some((name) =>
        SKIPPED_CLASS_PARTS.some((part) => name.includes(part))
    );
}

/** Element class names, whether hast stored them as an array or a string. */
function classNames(node: HastNode): string[] {
    const className = node.properties?.className;
    if (Array.isArray(className)) return className.map((name) => String(name));
    if (typeof className === 'string') return className.split(/\s+/);
    return [];
}

/** Recursively split the text nodes below `parent` on find matches. */
function highlightChildren(parent: HastNode, query: string): void {
    const children = parent.children;
    if (!children || children.length === 0) return;

    const next: HastNode[] = [];
    let replaced = false;

    for (const child of children) {
        if (child.type === 'text' && typeof child.value === 'string') {
            const pieces = splitTextNode(child.value, query);
            if (pieces) {
                next.push(...pieces);
                replaced = true;
            } else {
                next.push(child);
            }
            continue;
        }
        if (!isSkipped(child)) highlightChildren(child, query);
        next.push(child);
    }

    if (replaced) parent.children = next;
}

/**
 * Split one text value into text nodes and `<mark>` elements, or return `null`
 * when it holds no match and the original node can be kept as is.
 */
function splitTextNode(value: string, query: string): HastNode[] | null {
    const ranges = findMatchRanges(value, query);
    if (ranges.length === 0) return null;

    const nodes: HastNode[] = [];
    let cursor = 0;
    for (const { start, end } of ranges) {
        if (start > cursor) {
            nodes.push({ type: 'text', value: value.slice(cursor, start) });
        }
        nodes.push({
            type: 'element',
            tagName: 'mark',
            properties: { className: [FIND_HIT_CLASS], [FIND_HIT_ATTR]: '' },
            children: [{ type: 'text', value: value.slice(start, end) }],
        });
        cursor = end;
    }
    if (cursor < value.length) {
        nodes.push({ type: 'text', value: value.slice(cursor) });
    }
    return nodes;
}
