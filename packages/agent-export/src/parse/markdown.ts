/**
 * The markdown grammar exports parse with (remark + GFM + math, as the chat
 * renders), its serializer for Markdown export, and helpers that need the
 * parsed structure before the real parse.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { MdPosition, MdRoot } from '../mdast';

export const markdownProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze();

/** Serializes with the same extensions, in one consistent markup style. */
const markdownSerializer = unified()
    .use(remarkStringify, {
        bullet: '-',
        emphasis: '*',
        strong: '*',
        fence: '`',
        fences: true,
        rule: '-',
        listItemIndent: 'one',
    })
    .use(remarkGfm)
    .use(remarkMath)
    .freeze();

/** Markdown text of a tree. */
export function stringifyMarkdown(root: MdRoot): string {
    return markdownSerializer.stringify(root as unknown as Parameters<typeof markdownSerializer.stringify>[0]);
}

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
