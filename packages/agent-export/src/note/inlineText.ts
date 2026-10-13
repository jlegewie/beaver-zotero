/** Text at the end of inline content, for writers that space a following citation by it. */

import type { MdInline } from '../mdast';

/**
 * The last visible text of inline content, or `x` when it ends in something
 * other than text (a citation, an image, math). A writer adds a space before
 * a citation only after text that does not already end in one.
 */
export function trailingText(nodes: MdInline[]): string {
    for (let index = nodes.length - 1; index >= 0; index--) {
        const node = nodes[index];
        if (node.type === 'text') {
            if (node.value) return node.value;
            continue;
        }
        if (node.type === 'break') return ' ';
        if ('children' in node) return trailingText(node.children);
        return 'x';
    }
    return 'x';
}
