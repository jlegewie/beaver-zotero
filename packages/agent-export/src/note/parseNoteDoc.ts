/**
 * Parse a Zotero note into the format-neutral document model.
 *
 * The input is the note as Zotero's note editor reads it: the host parses the
 * note HTML with the editor's ProseMirror schema and passes the document's
 * JSON (`doc.toJSON()`), so legacy markup, tables, math and annotations come
 * out exactly as the user sees them in Zotero. This module only maps that
 * structure; it never touches a DOM or ProseMirror itself.
 *
 * What the export shows is what the note shows:
 * - citations (`span.citation`) keep their stored items, locators (page
 *   labels), locator types, prefixes and suffixes; citations separated only
 *   by whitespace form one cluster, as word processors cite;
 * - annotation highlights and underlines are their text, as the editor shows
 *   them (the citation after them is the visible one);
 * - links keep their target, except `file://` links (local paths) and links
 *   into Beaver itself, which become their text;
 * - the first heading becomes the document title, and the remaining headings
 *   move up so the highest is level 1; empty paragraphs are dropped.
 */

import type {
    MdBlock,
    MdBlockLayout,
    MdInline,
    MdListItem,
    MdTable,
    MdTableCell,
    MdTableRow,
} from '../mdast';
import type { CitationCluster, CitationOccurrence, ExportDoc, NoteCitationItem, NoteImageSource } from '../types';
import { opaqueColor } from './colors';

/** A ProseMirror mark as JSON. */
export interface PmMark {
    type: string;
    attrs?: Record<string, unknown>;
}

/** A ProseMirror node as JSON (`Node.toJSON()`). */
export interface PmNode {
    type: string;
    attrs?: Record<string, unknown>;
    content?: PmNode[];
    marks?: PmMark[];
    text?: string;
}

export interface ParseNoteDocOptions {
    /**
     * Keep text colors, background colors and table cell backgrounds
     * (default true). Without them, colored text is plain text.
     */
    colors?: boolean;
    /** Use the first block as the document title when it is a heading (default true). */
    liftTitle?: boolean;
}

/** An inline leaf with the marks that apply to it. */
interface Item {
    node: MdInline;
    marks: PmMark[];
    /** A note citation's items, before the citation is numbered. */
    occurrences?: CitationOccurrence[];
}

/** Mark nesting order, outermost first. */
const MARK_ORDER = ['link', 'textColor', 'backgroundColor', 'strong', 'em', 'underline', 'strike', 'subsup'];

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

function stringAttr(attrs: Record<string, unknown> | undefined, name: string): string | null {
    const value = attrs?.[name];
    return typeof value === 'string' && value ? value : null;
}

function numberAttr(attrs: Record<string, unknown> | undefined, name: string): number | null {
    const value = attrs?.[name];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function sameMark(a: PmMark, b: PmMark): boolean {
    return a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});
}

/** Plain text of inline content (titles, emptiness checks). */
function inlineText(nodes: MdInline[]): string {
    let text = '';
    for (const node of nodes) {
        if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'inlineMath') text += node.value;
        else if (node.type === 'break') text += ' ';
        else if ('children' in node) text += inlineText(node.children);
    }
    return text;
}

/** Text of a ProseMirror node's content (code blocks, math). */
function pmText(node: PmNode): string {
    if (typeof node.text === 'string') return node.text;
    return (node.content ?? []).map(child => (child.type === 'hardBreak' ? '\n' : pmText(child))).join('');
}

/** The note editor's citation items, as export citation items. */
function citationItems(citation: unknown): NoteCitationItem[] {
    const raw = (citation as { citationItems?: unknown } | null)?.citationItems;
    if (!Array.isArray(raw)) return [];
    const items: NoteCitationItem[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const value = entry as Record<string, unknown>;
        const uris = Array.isArray(value.uris) ? value.uris.filter((uri): uri is string => typeof uri === 'string' && !!uri) : [];
        const itemData = value.itemData && typeof value.itemData === 'object' ? value.itemData as Record<string, unknown> : undefined;
        if (uris.length === 0 && !itemData) continue;
        const text = (key: string) => {
            const field = value[key];
            if (typeof field === 'number') return String(field);
            return typeof field === 'string' && field.trim() ? field.trim() : undefined;
        };
        const locator = text('locator');
        const label = text('label');
        const prefix = text('prefix');
        const suffix = text('suffix');
        items.push({
            uris,
            ...(itemData ? { itemData } : {}),
            ...(locator ? { locator } : {}),
            ...(locator && label ? { label } : {}),
            ...(prefix ? { prefix } : {}),
            ...(suffix ? { suffix } : {}),
            ...(value['suppress-author'] === true || value.suppressAuthor === true ? { suppressAuthor: true } : {}),
        });
    }
    return items;
}

/**
 * Previews the host recorded for a citation (`properties.beaverPreview*`):
 * one per item when the note shows the items separately, else the whole
 * citation, which belongs to a single item or to the citation as a group.
 */
function citationPreviews(citation: unknown, count: number): { items: Array<string | undefined>; group?: string } {
    const properties = (citation as { properties?: Record<string, unknown> } | null)?.properties;
    const items = properties?.beaverPreviewItems;
    if (Array.isArray(items) && items.length === count) {
        // Each piece is shown inside the citation's parentheses.
        return { items: items.map(item => (typeof item === 'string' && item.trim() ? `(${item.trim()})` : undefined)) };
    }
    const whole = typeof properties?.beaverPreview === 'string' ? properties.beaverPreview.trim() : '';
    if (count === 1) return { items: [whole || undefined] };
    return { items: Array.from({ length: count }, () => undefined), ...(whole ? { group: whole } : {}) };
}

/** Same item, same locator, same notes: written twice, it is one citation. */
function sameCitationItem(a: NoteCitationItem, b: NoteCitationItem): boolean {
    return a.uris.length > 0
        && a.uris.some(uri => b.uris.includes(uri))
        && a.locator === b.locator
        && a.label === b.label
        && a.prefix === b.prefix
        && a.suffix === b.suffix
        && !!a.suppressAuthor === !!b.suppressAuthor;
}

function layout(attrs: Record<string, unknown> | undefined): MdBlockLayout {
    const out: MdBlockLayout = {};
    const align = stringAttr(attrs, 'align');
    if (align === 'center' || align === 'right' || align === 'justify') out.align = align;
    const indent = numberAttr(attrs, 'indent');
    if (indent) out.indent = Math.min(Math.round(indent), 12);
    const dir = stringAttr(attrs, 'dir');
    if (dir === 'rtl') out.dir = 'rtl';
    return out;
}

class NoteDocBuilder {
    readonly clusters: CitationCluster[] = [];
    readonly images: Record<string, NoteImageSource> = {};
    private imageCount = 0;

    constructor(private readonly options: Required<ParseNoteDocOptions>) {}

    // -- Inline content ------------------------------------------------------

    /** Leaves of inline content with their marks, annotation spans flattened. */
    private items(nodes: PmNode[], inherited: PmMark[] = []): Item[] {
        const out: Item[] = [];
        for (const node of nodes) {
            const marks = [...inherited, ...(node.marks ?? [])];
            switch (node.type) {
                case 'text': {
                    const value = node.text ?? '';
                    if (!value) break;
                    // Code takes no other marks in the note editor.
                    if (marks.some(mark => mark.type === 'code')) {
                        out.push({ node: { type: 'inlineCode', value }, marks: marks.filter(mark => mark.type === 'link') });
                    } else {
                        out.push({ node: { type: 'text', value }, marks });
                    }
                    break;
                }
                case 'hardBreak':
                    out.push({ node: { type: 'break' }, marks: [] });
                    break;
                case 'math_inline': {
                    const value = pmText(node).trim();
                    if (value) out.push({ node: { type: 'inlineMath', value }, marks: [] });
                    break;
                }
                case 'image': {
                    const image = this.image(node);
                    if (image) out.push({ node: image, marks: [] });
                    break;
                }
                case 'citation': {
                    const items = citationItems(node.attrs?.citation);
                    if (items.length === 0) break;
                    const previews = citationPreviews(node.attrs?.citation, items.length);
                    out.push({
                        node: { type: 'citation', clusterIndex: -1 },
                        marks: [],
                        occurrences: items.map((note, index): CitationOccurrence => ({
                            ref: null,
                            requestedKey: '',
                            rawTag: '',
                            note,
                            ...(previews.items[index] ? { previewText: previews.items[index] } : {}),
                            ...(previews.group ? { groupPreview: previews.group } : {}),
                        })),
                    });
                    break;
                }
                // Annotation spans show their text; the citation after them is
                // the one the note shows.
                case 'highlight':
                case 'underline_annotation':
                    out.push(...this.items(node.content ?? [], marks));
                    break;
                default:
                    // Unknown inline content: keep its text.
                    if (node.content) out.push(...this.items(node.content, marks));
                    else if (node.text) out.push({ node: { type: 'text', value: node.text }, marks });
            }
        }
        return out;
    }

    /**
     * Number the citations in document order. A citation separated from the
     * previous one only by whitespace joins its cluster (the whitespace goes).
     */
    private clusterCitations(items: Item[]): Item[] {
        const out: Item[] = [];
        let open: CitationCluster | null = null;
        let pending: Item[] = [];
        for (const item of items) {
            const occurrences = item.occurrences;
            if (occurrences) {
                if (open) {
                    for (const occurrence of occurrences) {
                        const existing = open.items.find(other => other.note && occurrence.note && sameCitationItem(other.note, occurrence.note));
                        if (!existing) open.items.push(occurrence);
                        // The citation written once keeps the metadata either copy stored.
                        else if (existing.note && !existing.note.itemData && occurrence.note?.itemData) existing.note.itemData = occurrence.note.itemData;
                    }
                    pending = [];
                    continue;
                }
                const cluster: CitationCluster = { index: this.clusters.length, items: occurrences };
                this.clusters.push(cluster);
                out.push({ node: { type: 'citation', clusterIndex: cluster.index }, marks: [] });
                open = cluster;
                pending = [];
                continue;
            }
            if (open && item.node.type === 'text' && !item.node.value.trim()) {
                pending.push(item);
                continue;
            }
            out.push(...pending, item);
            pending = [];
            open = null;
        }
        out.push(...pending);
        return out;
    }

    /** The mdast node a mark wraps its content in, or null to drop the mark. */
    private wrap(mark: PmMark, children: MdInline[]): MdInline[] {
        switch (mark.type) {
            case 'strong':
                return [{ type: 'strong', children }];
            case 'em':
                return [{ type: 'emphasis', children }];
            case 'strike':
                return [{ type: 'delete', children }];
            case 'underline': {
                const color = this.options.colors ? opaqueColor(stringAttr(mark.attrs, 'color')) : null;
                return [{ type: 'underline', ...(color ? { color } : {}), children }];
            }
            case 'subsup':
                return [{ type: mark.attrs?.type === 'sup' ? 'superscript' : 'subscript', children }];
            case 'textColor': {
                const color = this.options.colors ? opaqueColor(stringAttr(mark.attrs, 'color')) : null;
                // Black text is the default; marking it would only add noise.
                return color && color !== '#000000' ? [{ type: 'styled', color, children }] : children;
            }
            case 'backgroundColor': {
                const background = this.options.colors ? opaqueColor(stringAttr(mark.attrs, 'color')) : null;
                return background && background !== '#ffffff' ? [{ type: 'styled', background, children }] : children;
            }
            case 'link': {
                const href = stringAttr(mark.attrs, 'href')?.trim() ?? '';
                const scheme = SCHEME_PATTERN.exec(href)?.[1]?.toLowerCase();
                // Local files are paths on this computer; Beaver links only work in Beaver.
                if (!href || scheme === 'file' || /^zotero:\/\/beaver\//i.test(href)) return children;
                const title = stringAttr(mark.attrs, 'title');
                return [{ type: 'link', url: href, ...(title ? { title } : {}), children }];
            }
            default:
                return children;
        }
    }

    /** Nest marks around leaves, adjacent leaves sharing a mark under one node. */
    private nest(items: Item[]): MdInline[] {
        const out: MdInline[] = [];
        let index = 0;
        while (index < items.length) {
            const item = items[index];
            const outer = MARK_ORDER
                .map(type => item.marks.find(mark => mark.type === type))
                .find((mark): mark is PmMark => !!mark);
            if (!outer) {
                out.push(item.node);
                index += 1;
                continue;
            }
            let end = index + 1;
            while (end < items.length && items[end].marks.some(mark => sameMark(mark, outer))) end += 1;
            const group = items.slice(index, end).map(member => ({
                ...member,
                marks: member.marks.filter(mark => !sameMark(mark, outer)),
            }));
            out.push(...this.wrap(outer, this.nest(group)));
            index = end;
        }
        return mergeText(out);
    }

    inlines(nodes: PmNode[]): MdInline[] {
        return this.nest(this.clusterCitations(this.items(nodes)));
    }

    private image(node: PmNode): MdInline | null {
        const key = stringAttr(node.attrs, 'attachmentKey');
        const src = stringAttr(node.attrs, 'src');
        let source: NoteImageSource | null = null;
        if (key) source = { kind: 'attachment', key };
        else if (src && /^data:image\//i.test(src)) source = { kind: 'data', src };
        else if (src && /^https?:/i.test(src)) source = { kind: 'remote', url: src };
        if (!source) return null;
        const assetId = `image-${++this.imageCount}`;
        this.images[assetId] = source;
        const alt = stringAttr(node.attrs, 'alt') ?? stringAttr(node.attrs, 'title');
        return {
            type: 'image',
            url: source.kind === 'remote' ? source.url : '',
            alt: alt ?? null,
            assetId,
            width: numberAttr(node.attrs, 'width'),
            height: numberAttr(node.attrs, 'height'),
        };
    }

    // -- Blocks --------------------------------------------------------------

    blocks(nodes: PmNode[]): MdBlock[] {
        const out: MdBlock[] = [];
        for (const node of nodes) {
            switch (node.type) {
                case 'paragraph': {
                    const children = this.inlines(node.content ?? []);
                    if (isEmpty(children)) break;
                    out.push({ type: 'paragraph', ...layout(node.attrs), children: trimBreaks(children) });
                    break;
                }
                case 'heading': {
                    const children = this.inlines(node.content ?? []);
                    if (isEmpty(children)) break;
                    const level = numberAttr(node.attrs, 'level') ?? 1;
                    out.push({ type: 'heading', depth: Math.min(Math.max(Math.round(level), 1), 6), ...layout(node.attrs), children: trimBreaks(children) });
                    break;
                }
                case 'math_display': {
                    const value = pmText(node).trim();
                    if (value) out.push({ type: 'math', value });
                    break;
                }
                case 'codeBlock':
                    out.push({ type: 'code', lang: null, value: pmText(node) });
                    break;
                case 'blockquote': {
                    const children = this.blocks(node.content ?? []);
                    if (children.length > 0) out.push({ type: 'blockquote', children });
                    break;
                }
                case 'horizontalRule':
                    out.push({ type: 'thematicBreak' });
                    break;
                case 'bulletList':
                case 'orderedList': {
                    const ordered = node.type === 'orderedList';
                    const start = ordered ? numberAttr(node.attrs, 'order') ?? 1 : null;
                    const children = (node.content ?? [])
                        .map((item): MdListItem => ({ type: 'listItem', children: this.blocks(item.content ?? []) }));
                    if (children.length > 0) out.push({ type: 'list', ordered, start, children });
                    break;
                }
                case 'table': {
                    const table = this.table(node);
                    if (table) out.push(table);
                    break;
                }
                default:
                    // Unknown blocks: keep what they contain.
                    if (node.content) out.push(...this.blocks(node.content));
            }
        }
        return out;
    }

    private table(node: PmNode): MdTable | null {
        const rows: MdTableRow[] = [];
        const widths: Array<number | null> = [];
        let headerRow = true;
        (node.content ?? []).forEach((row, rowIndex) => {
            const cells: MdTableCell[] = [];
            let column = 0;
            for (const cell of row.content ?? []) {
                const colspan = numberAttr(cell.attrs, 'colspan') ?? 1;
                const rowspan = numberAttr(cell.attrs, 'rowspan') ?? 1;
                const background = this.options.colors ? opaqueColor(stringAttr(cell.attrs, 'background')) : null;
                const header = cell.type === 'table_header';
                if (rowIndex === 0 && !header) headerRow = false;
                const colwidth = cell.attrs?.colwidth;
                if (rowIndex === 0 && Array.isArray(colwidth)) {
                    colwidth.forEach((width, offset) => {
                        if (typeof width === 'number' && width > 0) widths[column + offset] = width;
                    });
                }
                column += colspan;
                cells.push({
                    type: 'tableCell',
                    children: [],
                    blocks: this.blocks(cell.content ?? []),
                    ...(header ? { header: true } : {}),
                    ...(colspan > 1 ? { colspan } : {}),
                    ...(rowspan > 1 ? { rowspan } : {}),
                    ...(background && background !== '#ffffff' ? { background } : {}),
                });
            }
            rows.push({ type: 'tableRow', children: cells });
        });
        if (rows.length === 0 || rows.every(row => row.children.length === 0)) return null;
        return {
            type: 'table',
            headerRow: headerRow && rows[0].children.length > 0,
            ...(widths.some(width => width) ? { colwidths: Array.from({ length: widths.length }, (_, index) => widths[index] ?? null) } : {}),
            children: rows,
        };
    }
}

/** Adjacent text nodes as one. */
function mergeText(nodes: MdInline[]): MdInline[] {
    const out: MdInline[] = [];
    for (const node of nodes) {
        const last = out[out.length - 1];
        if (node.type === 'text' && last?.type === 'text') out[out.length - 1] = { type: 'text', value: last.value + node.value };
        else out.push(node);
    }
    return out;
}

function isEmpty(nodes: MdInline[]): boolean {
    return nodes.every(node => (node.type === 'text' && !node.value.trim()) || node.type === 'break'
        || (('children' in node) && node.type !== 'link' && isEmpty(node.children)));
}

/** Without line breaks at the edges (a paragraph cannot start or end with one). */
function trimBreaks(nodes: MdInline[]): MdInline[] {
    const out = [...nodes];
    while (out[0]?.type === 'break') out.shift();
    while (out[out.length - 1]?.type === 'break') out.pop();
    return out;
}

/** Whether inline content holds something a plain-text title would lose. */
function containsNonText(node: MdInline): boolean {
    if (node.type === 'citation' || node.type === 'image' || node.type === 'inlineMath' || node.type === 'inlineCode') return true;
    return 'children' in node && node.children.some(containsNonText);
}

/** Shallowest heading level in blocks, or null without headings. */
function minHeadingDepth(blocks: MdBlock[]): number | null {
    let min: number | null = null;
    const visit = (nodes: MdBlock[]) => {
        for (const node of nodes) {
            if (node.type === 'heading') min = min === null ? node.depth : Math.min(min, node.depth);
            else if (node.type === 'blockquote') visit(node.children);
            else if (node.type === 'list') node.children.forEach(item => visit(item.children));
        }
    };
    visit(blocks);
    return min;
}

/** Headings shifted up by `by` levels. */
function shiftHeadings(blocks: MdBlock[], by: number): MdBlock[] {
    if (by <= 0) return blocks;
    return blocks.map((node): MdBlock => {
        if (node.type === 'heading') return { ...node, depth: Math.max(1, node.depth - by) };
        if (node.type === 'blockquote') return { ...node, children: shiftHeadings(node.children, by) };
        if (node.type === 'list') return { ...node, children: node.children.map(item => ({ ...item, children: shiftHeadings(item.children, by) })) };
        return node;
    });
}

/**
 * The document model of a Zotero note (the editor's ProseMirror document as
 * JSON). `doc.title` is the note's first heading when it opens with one, and
 * empty otherwise (the body then starts with the note's first line).
 */
export function parseNoteDoc(json: PmNode, options: ParseNoteDocOptions = {}): ExportDoc {
    const builder = new NoteDocBuilder({ colors: options.colors ?? true, liftTitle: options.liftTitle ?? true });
    let blocks = builder.blocks(json.content ?? []);
    let title = '';
    if ((options.liftTitle ?? true) && blocks[0]?.type === 'heading') {
        title = inlineText(blocks[0].children).replace(/\s+/g, ' ').trim();
        // A heading with more than text (a citation, an image, math) stays in
        // the body, where that content is kept.
        if (title && !blocks[0].children.some(containsNonText)) {
            blocks = blocks.slice(1);
        } else {
            title = '';
        }
    }
    const minDepth = minHeadingDepth(blocks);
    if (minDepth !== null) blocks = shiftHeadings(blocks, minDepth - 1);
    return {
        title,
        sections: blocks.length > 0 ? [{ kind: 'markdown', children: blocks, scope: 0 }] : [],
        clusters: builder.clusters,
        images: builder.images,
    };
}
