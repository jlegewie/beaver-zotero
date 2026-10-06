/**
 * Parse an export source into the format-neutral document model.
 *
 * Markdown is parsed with remark (GFM + math), the same grammar the chat
 * renders with. Citation tags are swapped for private-use placeholder tokens
 * before parsing, so a tag survives anywhere text can appear (emphasis, list
 * items, table cells) without depending on how CommonMark classifies inline
 * HTML, and are turned into `citation` nodes afterwards.
 */

import {
    CITATION_TAG_PATTERN,
    normalizeCitationTag,
    parseRawCitationAttributes,
    requestedCitationKey,
    unwrapBacktickedCitations,
} from '@beaver/agent-core/citations/citationGrammar';
import type { CitationCluster, CitationOccurrence, ExportDoc, ExportSection, ExportSource, ExportSourceBlock } from '../types';
import type { MdBlock, MdDefinition, MdInline, MdInlineMath, MdParagraph, MdRoot } from '../mdast';
import { codeRanges, markdownProcessor as processor } from './markdown';
import { decodeHtmlEntities } from '../citations/inlineHtml';

const PLACEHOLDER_OPEN = '';
const PLACEHOLDER_CLOSE = '';
const PLACEHOLDER_PATTERN = /(\d+)/g;
const PLACEHOLDER_TEST = new RegExp(PLACEHOLDER_PATTERN.source);

/** Marks a `<br>` in `htmlText` output, so source line breaks can still collapse to spaces. */
const HTML_LINE_BREAK = '\uE002';

/**
 * Visible text of raw HTML, decoded: block ends separate paragraphs with a
 * blank line, `<br>` becomes `HTML_LINE_BREAK`, tags and comments are dropped.
 */
function htmlText(html: string): string {
    return decodeHtmlEntities(html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<br\s*\/?>/gi, HTML_LINE_BREAK)
        .replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr|section|article|ul|ol|table)>/gi, '\n\n')
        .replace(/<[^>]*>/g, ''));
}

/** LaTeX delimiters → remark-math's dollar delimiters. */
function convertMathDelimiters(text: string): string {
    return text
        .replace(/(?<!\\)\\\(((?:\\.|[^\\])*?)\\\)/g, (_, math: string) => `$${math}$`)
        .replace(/(?<!\\)\\\[((?:\\.|[^\\])*?)\\\]/g, (_, math: string) => `$$${math}$$`);
}

/** Text outside code: `transform` applied between code ranges. */
function outsideCode(text: string, transform: (segment: string, offset: number) => string): string {
    let out = '';
    let cursor = 0;
    for (const [start, end] of codeRanges(text)) {
        if (start < cursor) continue;
        out += transform(text.slice(cursor, start), cursor) + text.slice(start, end);
        cursor = end;
    }
    return out + transform(text.slice(cursor), cursor);
}

/** A line start holding only container markup: block quotes, list markers, a footnote label. */
const CONTAINER_ONLY = /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])|\[\^[^\]\s]+\]:))*[ \t]*$/;

/**
 * Display math whose delimiters are attached to its content
 * (`$$\begin{aligned}` … `\end{aligned}$$`) where `$$` opens a block: there
 * the opening line reads as a fence whose first line is metadata, and the
 * fence never closes, swallowing the rest of the document. The delimiters move
 * onto lines of their own, continuing the containers the fence opened in
 * (quote markers kept, list markers and footnote labels as indentation).
 * Anything else is left as written: fences already on their own lines, and
 * `$$…$$` inside a paragraph or table cell, which the parser reads as inline
 * math (see `splitDisplayMath`).
 */
function separateAttachedFences(text: string): string {
    return outsideCode(text, (segment, offset) => segment.replace(/\$\$([^$]+)\$\$/g, (match, math: string, index: number) => {
        if (!math.includes('\n')) return match;
        const position = offset + index;
        const before = text.slice(text.lastIndexOf('\n', position - 1) + 1, position);
        if (!CONTAINER_ONLY.test(before)) return match;
        const lastLine = math.slice(math.lastIndexOf('\n') + 1);
        const attachedStart = !/^[ \t]*\n/.test(math);
        const attachedEnd = !CONTAINER_ONLY.test(lastLine);
        if (!attachedStart && !attachedEnd) return match;
        const continuation = before.replace(/[^\s>]/g, ' ');
        const end = position + match.length;
        const restOfLine = text.slice(end, text.indexOf('\n', end) === -1 ? text.length : text.indexOf('\n', end));
        return '$$'
            + (attachedStart ? `\n${continuation}${math.replace(/^[ \t]+/, '')}` : math)
            + (attachedEnd ? `\n${continuation}` : '')
            + '$$'
            + (restOfLine.trim() ? `\n${continuation}` : '');
    }));
}

/** Normalize model output the way the chat renderer does before parsing, leaving code untouched. */
export function normalizeMarkdown(markdown: string): string {
    const text = unwrapBacktickedCitations(markdown);
    if (!/\\[([]|\$\$/.test(text)) return text;
    return separateAttachedFences(outsideCode(text, segment => convertMathDelimiters(segment)));
}

function parseOccurrence(rawTag: string, attributes: string): CitationOccurrence {
    const normalized = normalizeCitationTag(parseRawCitationAttributes(attributes));
    if (normalized.ok) {
        return { ref: normalized.ref, requestedKey: requestedCitationKey(normalized.ref), rawTag };
    }
    return {
        ref: null,
        requestedKey: normalized.requestedKey ?? '',
        ...(normalized.rawIdentity ? { invalidKey: `invalid:${normalized.rawIdentity}` } : {}),
        rawTag,
    };
}

/** Link definitions (`[label]: url`) anywhere in the tree, by identifier. */
function collectDefinitions(blocks: MdBlock[], into = new Map<string, MdDefinition>()): Map<string, MdDefinition> {
    for (const block of blocks) {
        if (block.type === 'definition') {
            if (!into.has(block.identifier)) into.set(block.identifier, block);
        } else if (block.type === 'blockquote' || block.type === 'footnoteDefinition') {
            collectDefinitions(block.children, into);
        } else if (block.type === 'list') {
            for (const item of block.children) collectDefinitions(item.children, into);
        }
    }
    return into;
}

class DocumentBuilder {
    readonly clusters: CitationCluster[] = [];
    private occurrences: CitationOccurrence[] = [];
    /** Link definitions of the markdown being parsed. */
    private definitions = new Map<string, MdDefinition>();

    /** Replace citation tags with placeholder tokens, remembering each tag. */
    tokenize(markdown: string): string {
        const pattern = new RegExp(CITATION_TAG_PATTERN.source, CITATION_TAG_PATTERN.flags);
        return markdown.replace(pattern, (rawTag: string, attributes: string | undefined) => {
            this.occurrences.push(parseOccurrence(rawTag, attributes ?? ''));
            return `${PLACEHOLDER_OPEN}${this.occurrences.length - 1}${PLACEHOLDER_CLOSE}`;
        });
    }

    /** Put the original tags back into literal text (code, math, raw HTML). */
    restore(value: string): string {
        return value.replace(PLACEHOLDER_PATTERN, (_, index: string) => this.occurrences[Number(index)]?.rawTag ?? '');
    }

    /** Split a text value into text and citation nodes, merging adjacent tags into one cluster. */
    splitText(value: string): MdInline[] {
        const nodes: MdInline[] = [];
        let cursor = 0;
        let openCluster: CitationCluster | null = null;
        for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
            const start = match.index ?? 0;
            const between = value.slice(cursor, start);
            const occurrence = this.occurrences[Number(match[1])];
            cursor = start + match[0].length;
            if (!occurrence) continue;
            if (openCluster && between.trim() === '') {
                if (!openCluster.items.some(item => item.requestedKey && item.requestedKey === occurrence.requestedKey)) {
                    openCluster.items.push(occurrence);
                }
                continue;
            }
            if (between) nodes.push({ type: 'text', value: between });
            openCluster = { index: this.clusters.length, items: [occurrence] };
            this.clusters.push(openCluster);
            nodes.push({ type: 'citation', clusterIndex: openCluster.index });
        }
        const rest = value.slice(cursor);
        if (rest) nodes.push({ type: 'text', value: rest });
        return nodes;
    }

    /** Inline nodes for text from `htmlText`: whitespace collapsed, `<br>` as breaks. */
    htmlInlines(text: string): MdInline[] {
        const lines = text.split(HTML_LINE_BREAK).map(line => line.replace(/[ \t\r\n]+/g, ' '));
        while (lines.length > 0 && !lines[0].trim()) lines.shift();
        while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
        const out: MdInline[] = [];
        lines.forEach((line, index) => {
            if (index > 0) out.push({ type: 'break' });
            const trimmed = index === 0 ? line.trimStart() : line;
            out.push(...this.splitText(index === lines.length - 1 ? trimmed.trimEnd() : trimmed));
        });
        return out;
    }

    inlines(children: MdInline[]): MdInline[] {
        const out: MdInline[] = [];
        for (const child of children) {
            switch (child.type) {
                case 'text':
                    out.push(...this.splitText(child.value));
                    break;
                case 'emphasis':
                case 'strong':
                case 'delete':
                case 'link':
                    out.push({ ...child, children: this.inlines(child.children) });
                    break;
                case 'inlineCode':
                case 'inlineMath':
                    out.push({ ...child, value: this.restore(child.value) });
                    break;
                case 'html':
                    // Citations inside raw HTML render in the chat (rehype-raw), so they are kept.
                    if (PLACEHOLDER_TEST.test(child.value)) out.push(...this.htmlInlines(htmlText(child.value)));
                    else out.push(child);
                    break;
                case 'linkReference': {
                    // A reference without a definition is plain text.
                    const definition = this.definitions.get(child.identifier);
                    const children = this.inlines(child.children);
                    if (definition) out.push({ type: 'link', url: definition.url, title: definition.title, children });
                    else out.push(...children);
                    break;
                }
                case 'imageReference': {
                    const definition = this.definitions.get(child.identifier);
                    out.push({ type: 'image', url: definition?.url ?? '', alt: child.alt });
                    break;
                }
                default:
                    out.push(child);
            }
        }
        return out;
    }

    blocks(children: MdBlock[], source: string): MdBlock[] {
        const out: MdBlock[] = [];
        for (const child of children) {
            switch (child.type) {
                case 'paragraph':
                    for (const part of splitDisplayMath(child, source)) {
                        out.push(typeof part === 'string'
                            ? { type: 'math', value: this.restore(part) }
                            : { ...child, children: this.inlines(part) });
                    }
                    break;
                case 'heading':
                    out.push({ ...child, children: this.inlines(child.children) });
                    break;
                case 'blockquote':
                case 'footnoteDefinition':
                    out.push({ ...child, children: this.blocks(child.children, source) });
                    break;
                case 'list':
                    out.push({
                        ...child,
                        children: child.children.map(item => ({ ...item, children: this.blocks(item.children, source) })),
                    });
                    break;
                case 'table':
                    out.push({
                        ...child,
                        children: child.children.map(row => ({
                            ...row,
                            children: row.children.map(cell => ({ ...cell, children: this.inlines(cell.children) })),
                        })),
                    });
                    break;
                case 'code':
                case 'math':
                    out.push({ ...child, value: this.restore(child.value) });
                    break;
                case 'html':
                    // Raw HTML blocks become plain paragraphs: decoded text, paragraph
                    // and line breaks kept, citations kept as citations.
                    for (const paragraph of htmlText(child.value).split(/\n[ \t\r]*\n/)) {
                        const children = this.htmlInlines(paragraph);
                        if (children.length > 0) out.push({ type: 'paragraph', children });
                    }
                    break;
                case 'definition':
                    // Consumed by the references that use it.
                    break;
                default:
                    out.push(child);
            }
        }
        return out;
    }

    parse(markdown: string): MdBlock[] {
        const source = this.tokenize(normalizeMarkdown(markdown));
        const root = processor.parse(source) as unknown as MdRoot;
        this.definitions = collectDefinitions(root.children);
        return this.blocks(root.children, source);
    }
}

/**
 * A paragraph split at its `$$…$$` math, which the chat shows as display math
 * even inside a sentence: runs of inline content, and the math (a string)
 * between them. Done on the parsed tree, so the parts stay in whatever list,
 * quote or footnote held the paragraph; table cells hold no paragraphs and
 * keep such math inline.
 */
function splitDisplayMath(paragraph: MdParagraph, source: string): Array<MdInline[] | string> {
    const isDisplay = (node: MdInline) => {
        const offset = node.position?.start.offset;
        return node.type === 'inlineMath' && offset != null && source.slice(offset, offset + 2) === '$$';
    };
    if (!paragraph.children.some(isDisplay)) return [paragraph.children];
    const parts: Array<MdInline[] | string> = [];
    let run: MdInline[] = [];
    const flush = () => {
        // Whitespace and line breaks around the math belonged to the sentence's flow.
        while (run.length > 0 && run[0].type === 'break') run.shift();
        while (run.length > 0 && run[run.length - 1].type === 'break') run.pop();
        if (run[0]?.type === 'text') run[0] = { ...run[0], value: run[0].value.replace(/^\s+/, '') };
        const last = run[run.length - 1];
        if (last?.type === 'text') run[run.length - 1] = { ...last, value: last.value.replace(/\s+$/, '') };
        if (run.some(node => node.type !== 'text' || node.value.trim())) parts.push(run);
        run = [];
    };
    for (const node of paragraph.children) {
        if (isDisplay(node)) {
            flush();
            parts.push((node as MdInlineMath).value);
        } else {
            run.push(node);
        }
    }
    flush();
    return parts;
}

/** Marks where an activity block sits inside a response's markdown. */
const ACTIVITY_MARKER = '\uE003';
const ACTIVITY_MARKER_PATTERN = new RegExp(`^${ACTIVITY_MARKER}(\\d+)${ACTIVITY_MARKER}$`);
/** A marker inside other content, with the blank line the join put before it. */
const EMBEDDED_MARKER_PATTERN = new RegExp(`(?:\\n\\n)?${ACTIVITY_MARKER}\\d+${ACTIVITY_MARKER}`, 'g');

/** Remove activity markers that markup swallowed (an unclosed code fence or math block). */
function stripActivityMarkers<T extends MdBlock | MdInline>(node: T): T {
    const strip = (value: string) => value.replace(EMBEDDED_MARKER_PATTERN, '');
    const anyNode = node as unknown as { value?: unknown; children?: Array<MdBlock | MdInline> };
    const copy = { ...anyNode } as typeof anyNode;
    if (typeof copy.value === 'string') copy.value = strip(copy.value);
    if (Array.isArray(copy.children)) copy.children = copy.children.map(stripActivityMarkers);
    return copy as unknown as T;
}

/**
 * Parse a response's text and the activity between it as one markdown
 * document — so a reference before a tool call finds its definition after it,
 * as it would in the chat — then split it back into sections at the activity
 * markers.
 */
function parseResponseGroup(
    builder: DocumentBuilder,
    group: Array<Extract<ExportSourceBlock, { type: 'markdown' | 'activity' }>>,
    scope: number,
): ExportSection[] {
    const parts = group.map((block, index) => (block.type === 'activity' ? `${ACTIVITY_MARKER}${index}${ACTIVITY_MARKER}` : block.markdown));
    const sections: ExportSection[] = [];
    let current: MdBlock[] = [];
    const placed = new Set<number>();
    const flush = () => {
        if (current.length > 0) sections.push({ kind: 'markdown', children: current.map(stripActivityMarkers), scope });
        current = [];
    };
    for (const node of builder.parse(parts.join('\n\n'))) {
        const marker = node.type === 'paragraph' && node.children.length === 1 && node.children[0].type === 'text'
            ? ACTIVITY_MARKER_PATTERN.exec(node.children[0].value.trim())
            : null;
        const block = marker ? group[Number(marker[1])] : undefined;
        if (block?.type === 'activity') {
            flush();
            sections.push({ kind: 'activity', children: [], calls: block.calls, scope });
            placed.add(Number(marker![1]));
        } else {
            current.push(node);
        }
    }
    flush();
    // A marker swallowed by surrounding markup (an unclosed code fence) was
    // removed from that content above; its activity follows the content.
    group.forEach((block, index) => {
        if (block.type === 'activity' && !placed.has(index)) sections.push({ kind: 'activity', children: [], calls: block.calls, scope });
    });
    return sections;
}

/**
 * Paragraphs of plain text, read literally as the chat shows a prompt: blank
 * lines separate paragraphs, other line breaks are kept, and leading
 * indentation survives as non-breaking spaces. Nothing is parsed as markdown,
 * math or citations.
 */
export function plainTextBlocks(text: string): MdBlock[] {
    return text
        .replace(/\r\n?/g, '\n')
        .split(/\n[ \t]*\n/)
        .filter(paragraph => paragraph.trim())
        .map((paragraph): MdBlock => ({
            type: 'paragraph',
            children: paragraph.replace(/^\n+|\n+$/g, '').split('\n').flatMap((line, index): MdInline[] => {
                const indent = /^[ \t]*/.exec(line)![0];
                const value = '\u00a0'.repeat(indent.replace(/\t/g, '    ').length) + line.slice(indent.length);
                return [
                    ...(index > 0 ? [{ type: 'break' } as const] : []),
                    ...(value ? [{ type: 'text', value } as const] : []),
                ];
            }),
        }));
}

/** Parse a source into the document model. */
export function parseExportSource(source: Pick<ExportSource, 'title' | 'blocks'>): ExportDoc {
    const builder = new DocumentBuilder();
    const sections: ExportSection[] = [];
    let scope = 0;
    let group: Array<Extract<ExportSourceBlock, { type: 'markdown' | 'activity' }>> = [];
    const flushGroup = () => {
        if (group.length > 0) sections.push(...parseResponseGroup(builder, group, scope++));
        group = [];
    };
    for (const block of source.blocks) {
        if (block.type === 'markdown' || block.type === 'activity') {
            group.push(block);
            continue;
        }
        flushGroup();
        sections.push(block.type === 'note'
            ? { kind: 'note', title: block.title, children: builder.parse(block.markdown), scope: scope++ }
            : { kind: 'user', children: plainTextBlocks(block.text), scope: scope++ });
    }
    flushGroup();
    return { title: source.title, sections, clusters: builder.clusters };
}
