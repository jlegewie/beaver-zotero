/**
 * The markdown grammar exports parse with (remark + GFM + math, as the chat
 * renders), and helpers that need the parsed structure before the real parse.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { MdPosition } from '../mdast';

export const markdownProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze();

/** Source ranges of code (blocks of every form and inline spans), sorted. */
export function codeRanges(markdown: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    const visit = (node: { type: string; position?: MdPosition; children?: unknown[] }) => {
        if (node.type === 'code' || node.type === 'inlineCode') {
            const start = node.position?.start.offset;
            const end = node.position?.end.offset;
            if (start != null && end != null) ranges.push([start, end]);
            return;
        }
        for (const child of node.children ?? []) visit(child as typeof node);
    };
    visit(markdownProcessor.parse(markdown) as unknown as { type: string; children: unknown[] });
    return ranges.sort((a, b) => a[0] - b[0]);
}
