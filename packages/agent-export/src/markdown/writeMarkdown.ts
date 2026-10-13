/**
 * Write an export document as Markdown (GitHub-flavored, with `$` math).
 *
 * The document model is already markdown, so the writer rebuilds a markdown
 * tree and serializes it with remark: citations become the text the citation
 * processor produced (its italics and bold as markdown emphasis), item links
 * become plain text or `zotero://` links, and every footnote is renumbered
 * into one document-wide sequence. With a note style each citation becomes a
 * footnote (`[^n]`) holding the note text. The bibliography follows the body.
 *
 * Serializing through remark escapes text wherever markdown would otherwise
 * read it as markup (`*`, `$`, `[`, …), so text written by the model or taken
 * from item metadata comes out as the same text.
 */

import type { MdBlock, MdFootnoteDefinition, MdImage, MdInline, MdRoot, MdTable, MdTableCell } from '../mdast';
import { exportLinkTarget, isWebLink } from '../links';
import { base64 } from '../note/base64';
import { hasSpans, isNoteTable, tableGrid } from '../note/tableGrid';
import { trailingText } from '../note/inlineText';
import { imageFallback } from '../note/images';
import { assignNotePlacements, sectionFootnoteDefinitions, type NotePlacement } from '../citations/noteIndices';
import { parseCslHtml, type StyledSegment } from '../citations/inlineHtml';
import { stringifyMarkdown } from '../parse/markdown';
import type { ExportDoc, ExportImage, ExportWarning, FormattedCitations, FormattedCluster, MarkdownExportOptions } from '../types';

export interface WriteMarkdownInput {
    doc: ExportDoc;
    citations: FormattedCitations;
    options: MarkdownExportOptions;
    /**
     * Images of the document by asset id (Zotero notes): linked by their
     * `path` next to the document, or embedded as data URIs without one.
     */
    images?: Record<string, ExportImage>;
}

export interface WriteMarkdownResult {
    markdown: string;
    warnings: ExportWarning[];
    stats: { citations: number; footnotes: number; equations: number };
}

/** Typographic double quotes for a plain label (`"query"` → “query”). */
function curlyQuotes(text: string): string {
    return text.replace(/"([^"]*)"/g, '“$1”');
}

/** Visible text of an inline HTML node; `<br>` stays a line break. */
function inlineHtml(html: string): MdInline | null {
    if (/^<br\s*\/?>$/i.test(html.trim())) return { type: 'break' };
    const text = html.replace(/<[^>]*>/g, '');
    return text ? { type: 'text', value: text } : null;
}

function escapeHtmlText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Markdown for styled citation-processor output. Whitespace at the edges of a
 * styled run moves outside its emphasis (`* 2004*` is not emphasis).
 * Super- and subscripts, which markdown lacks, are inline HTML.
 */
export function segmentsToInlines(segments: StyledSegment[], options: { links: boolean }): MdInline[] {
    const out: MdInline[] = [];
    for (const segment of segments) {
        if (segment.lineBreak) out.push({ type: 'break' });
        const text = segment.text.replace(/\t/g, ' ');
        const [, leading, core, trailing] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? ['', '', text, ''];
        if (leading) out.push({ type: 'text', value: leading });
        if (core) {
            let node: MdInline;
            if (segment.superscript || segment.subscript) {
                const tag = segment.superscript ? 'sup' : 'sub';
                node = { type: 'html', value: `<${tag}>${escapeHtmlText(core)}</${tag}>` };
            } else {
                node = { type: 'text', value: core };
            }
            if (segment.italic) node = { type: 'emphasis', children: [node] };
            if (segment.bold) node = { type: 'strong', children: [node] };
            if (segment.link && options.links && isWebLink(segment.link)) {
                node = { type: 'link', url: segment.link.trim(), children: [node] };
            }
            out.push(node);
        }
        if (trailing) out.push({ type: 'text', value: trailing });
    }
    return out;
}

/**
 * Marked inline content with the spaces at its edges moved outside the mark:
 * `wrap` builds the marked node(s) from the inner content.
 */
function outsideEdgeSpace(children: MdInline[], wrap: (children: MdInline[]) => MdInline | MdInline[]): MdInline[] {
    const inner = [...children];
    let leading = '';
    let trailing = '';
    const first = inner[0];
    if (first?.type === 'text') {
        leading = /^\s*/.exec(first.value)![0];
        const value = first.value.slice(leading.length);
        if (value) inner[0] = { ...first, value };
        else inner.shift();
    }
    const last = inner[inner.length - 1];
    if (last?.type === 'text') {
        trailing = /\s*$/.exec(last.value)![0];
        const value = last.value.slice(0, last.value.length - trailing.length);
        if (value) inner[inner.length - 1] = { ...last, value };
        else inner.pop();
    }
    if (inner.length === 0) return children;
    const wrapped = wrap(inner);
    return [
        ...(leading ? [{ type: 'text' as const, value: leading }] : []),
        ...(Array.isArray(wrapped) ? wrapped : [wrapped]),
        ...(trailing ? [{ type: 'text' as const, value: trailing }] : []),
    ];
}

/** Line breaks as `<br>`, the only line break a GFM table cell keeps. */
function breaksAsHtml(nodes: MdInline[]): MdInline[] {
    return nodes.map((node): MdInline => {
        if (node.type === 'break') return { type: 'html', value: '<br>' };
        if ('children' in node) return { ...node, children: breaksAsHtml(node.children) } as MdInline;
        return node;
    });
}

/** Inline nodes of a bibliography entry or note, without layout whitespace at its edges. */
function trimInlines(nodes: MdInline[]): MdInline[] {
    const out = [...nodes];
    const isBlank = (node: MdInline | undefined) => node?.type === 'text' && !node.value.trim();
    while (isBlank(out[0])) out.shift();
    while (isBlank(out[out.length - 1])) out.pop();
    const first = out[0];
    if (first?.type === 'text') out[0] = { ...first, value: first.value.trimStart() };
    const last = out[out.length - 1];
    if (last?.type === 'text') out[out.length - 1] = { ...last, value: last.value.trimEnd() };
    return out;
}

class MarkdownWriter {
    /** Footnote contents by number. */
    private readonly notes = new Map<number, MdBlock[]>();
    private noteCount = 0;
    private readonly writtenNotes = new Map<MdFootnoteDefinition, number>();
    private citationCount = 0;
    private equations = 0;
    private readonly placements: Map<number, NotePlacement>;
    private readonly isNoteStyle: boolean;
    /** True while writing a footnote's content, so citations in it stay inline. */
    private insideNote = false;
    /** Depth of open links; links cannot nest. */
    private linkDepth = 0;
    /** Tables whose spans or block content Markdown could not keep. */
    private simplifiedTables = 0;

    constructor(private readonly input: WriteMarkdownInput) {
        this.isNoteStyle = input.citations.styleClass === 'note';
        this.placements = this.isNoteStyle
            ? assignNotePlacements(input.doc, index => (this.cluster(index)?.items.length ?? 0) > 0)
            : new Map();
    }

    private cluster(index: number): FormattedCluster | undefined {
        return this.input.citations.clusters[index];
    }

    // -- Inline content ------------------------------------------------------

    private inlines(nodes: MdInline[], definitions: Map<string, MdFootnoteDefinition>): MdInline[] {
        const out: MdInline[] = [];
        let lastText = '';
        nodes.forEach((node, index) => {
            const next = nodes[index + 1];
            switch (node.type) {
                case 'text': {
                    let value = node.value;
                    // A note mark follows the word directly.
                    if (next?.type === 'citation' && this.createsNote(next.clusterIndex)) value = value.replace(/\s+$/, '');
                    if (value) {
                        out.push({ type: 'text', value });
                        lastText = value;
                    }
                    break;
                }
                case 'emphasis':
                case 'strong':
                case 'delete':
                    // Markdown marks cannot start or end with a space (`~~struck ~~` is not struck).
                    out.push(...outsideEdgeSpace(this.inlines(node.children, definitions), children => ({ type: node.type, children })));
                    lastText = trailingText(node.children);
                    break;
                // Markdown has no underline or colors: their text stays.
                case 'underline':
                case 'styled':
                    out.push(...this.inlines(node.children, definitions));
                    lastText = trailingText(node.children);
                    break;
                // Sub- and superscripts carry meaning (H₂O, 10⁵): inline HTML.
                case 'subscript':
                case 'superscript': {
                    const tag = node.type === 'subscript' ? 'sub' : 'sup';
                    out.push(...outsideEdgeSpace(this.inlines(node.children, definitions), children => [
                        { type: 'html', value: `<${tag}>` }, ...children, { type: 'html', value: `</${tag}>` },
                    ]));
                    lastText = trailingText(node.children);
                    break;
                }
                case 'inlineCode':
                    out.push({ type: 'inlineCode', value: node.value });
                    lastText = node.value;
                    break;
                case 'break':
                    out.push({ type: 'break' });
                    lastText = ' ';
                    break;
                case 'html': {
                    const converted = inlineHtml(node.value);
                    if (converted) {
                        out.push(converted);
                        lastText = converted.type === 'text' ? converted.value : ' ';
                    }
                    break;
                }
                case 'link':
                    out.push(...this.link(node.url, node.title, node.children, definitions));
                    lastText = trailingText(node.children);
                    break;
                case 'image': {
                    const image = this.image(node);
                    if (image) {
                        out.push(image);
                        lastText = 'x';
                    }
                    break;
                }
                case 'inlineMath':
                    this.equations += 1;
                    out.push({ type: 'inlineMath', value: node.value });
                    lastText = 'x';
                    break;
                case 'footnoteReference': {
                    const reference = this.markdownFootnote(node.identifier, definitions);
                    if (reference) out.push(reference);
                    lastText = 'x';
                    break;
                }
                case 'citation': {
                    const needsSpace = !this.createsNote(node.clusterIndex) && /[^\s([{—-]$/.test(lastText);
                    const nodes = this.citation(node.clusterIndex);
                    if (nodes.length > 0) {
                        if (needsSpace) out.push({ type: 'text', value: ' ' });
                        out.push(...nodes);
                        lastText = 'x';
                    }
                    break;
                }
                default:
                    break;
            }
        });
        return out;
    }

    /**
     * An image: a note image by its file next to the document (or as a data
     * URI when the host gave no file), a web image by its address, otherwise
     * its alt text or a placeholder.
     */
    private image(node: MdImage): MdInline | null {
        const asset = node.assetId ? this.input.images?.[node.assetId] : undefined;
        if (asset) {
            const url = asset.path ?? `data:${asset.mime};base64,${base64(asset.data)}`;
            return { type: 'image', url, alt: node.alt ?? '' };
        }
        if (isWebLink(node.url)) return { type: 'image', url: node.url.trim(), alt: node.alt ?? '' };
        const fallback = imageFallback(node, this.input.doc);
        return fallback ? { type: 'emphasis', children: [{ type: 'text', value: fallback.text }] } : null;
    }

    private link(
        url: string,
        title: string | null | undefined,
        children: MdInline[],
        definitions: Map<string, MdFootnoteDefinition>,
    ): MdInline[] {
        const target = exportLinkTarget(url, this.input.options.linkItems);
        if (!target || this.linkDepth > 0) return this.inlines(children, definitions);
        this.linkDepth += 1;
        const content = this.inlines(children, definitions);
        this.linkDepth -= 1;
        // A footnote mark inside link text would not read as one; it follows the link.
        const marks = content.filter(node => node.type === 'footnoteReference');
        const text = content.filter(node => node.type !== 'footnoteReference');
        return [{ type: 'link', url: target, ...(title ? { title } : {}), children: text }, ...marks];
    }

    private markdownFootnote(identifier: string, definitions: Map<string, MdFootnoteDefinition>): MdInline | null {
        if (this.insideNote) return null;
        const definition = definitions.get(identifier);
        if (!definition) return null;
        // A repeated reference points at the note already written.
        const existing = this.writtenNotes.get(definition);
        if (existing !== undefined) return { type: 'footnoteReference', identifier: String(existing) };
        const id = ++this.noteCount;
        this.writtenNotes.set(definition, id);
        this.insideNote = true;
        const linkDepth = this.linkDepth;
        this.linkDepth = 0;
        this.notes.set(id, this.blocks(definition.children, definitions));
        this.linkDepth = linkDepth;
        this.insideNote = false;
        return { type: 'footnoteReference', identifier: String(id) };
    }

    // -- Citations -----------------------------------------------------------

    private createsNote(clusterIndex: number): boolean {
        return this.isNoteStyle && !this.insideNote && !!this.placements.get(clusterIndex)?.ownFootnote;
    }

    /** The citation's text: the processor's formatting, then any citations kept as plain text. */
    private citationInlines(cluster: FormattedCluster, inLink: boolean): MdInline[] {
        const out: MdInline[] = [];
        if (cluster.items.length > 0) {
            this.citationCount += 1;
            out.push(...trimInlines(segmentsToInlines(parseCslHtml(cluster.html), { links: !inLink })));
        }
        // Spacing before the cluster itself comes from the surrounding text.
        for (const text of cluster.fallbackTexts) {
            out.push({ type: 'text', value: `${out.length > 0 ? ' ' : ''}${text}` });
        }
        return out;
    }

    private citation(clusterIndex: number): MdInline[] {
        const cluster = this.cluster(clusterIndex);
        if (!cluster) return [];
        if (!this.createsNote(clusterIndex)) return this.citationInlines(cluster, this.linkDepth > 0);
        const id = ++this.noteCount;
        this.notes.set(id, [{ type: 'paragraph', children: this.citationInlines(cluster, false) }]);
        return [{ type: 'footnoteReference', identifier: String(id) }];
    }

    // -- Blocks --------------------------------------------------------------

    private blocks(nodes: MdBlock[], definitions: Map<string, MdFootnoteDefinition>): MdBlock[] {
        const out: MdBlock[] = [];
        for (const node of nodes) {
            switch (node.type) {
                case 'paragraph': {
                    const children = this.inlines(node.children, definitions);
                    if (children.length > 0) out.push({ type: 'paragraph', children });
                    break;
                }
                case 'heading':
                    out.push({ type: 'heading', depth: Math.min(Math.max(node.depth, 1), 6), children: this.inlines(node.children, definitions) });
                    break;
                case 'thematicBreak':
                    out.push({ type: 'thematicBreak' });
                    break;
                case 'blockquote':
                    out.push({ type: 'blockquote', children: this.blocks(node.children, definitions) });
                    break;
                case 'list':
                    out.push({
                        ...node,
                        children: node.children.map(item => ({ ...item, children: this.blocks(item.children, definitions) })),
                    });
                    break;
                case 'code':
                    out.push({ type: 'code', lang: node.lang ?? null, value: node.value });
                    break;
                case 'math':
                    this.equations += 1;
                    out.push({ type: 'math', value: node.value.trim() });
                    break;
                case 'table':
                    // Notes hold text, not tables (the note numbering skips them too).
                    if (!this.insideNote) out.push(this.table(node, definitions));
                    break;
                default:
                    // Raw HTML blocks were turned into paragraphs by the parser;
                    // footnote definitions are written where they are referenced.
                    break;
            }
        }
        return out;
    }

    /**
     * A Zotero note's table in GFM, which has a header row, inline cells and no
     * spans: a table without header cells uses its first row as the header,
     * blocks in a cell are joined with line breaks (list items as bullets),
     * and a spanning cell's content goes to its first position.
     */
    private noteTable(node: MdTable, definitions: Map<string, MdFootnoteDefinition>): MdTable {
        const grid = tableGrid(node);
        const flattened = node.children.some(row => row.children.some(cell => (cell.blocks?.length ?? 0) > 1
            || cell.blocks?.some(block => block.type !== 'paragraph')));
        if (flattened || hasSpans(node)) this.simplifiedTables += 1;
        return {
            type: 'table',
            align: Array.from({ length: grid.columns }, () => null),
            children: grid.rows.map(row => ({
                type: 'tableRow',
                children: row.map(slot => ({
                    type: 'tableCell',
                    children: slot?.origin ? this.cellInlines(slot.cell, definitions) : [],
                })),
            })),
        };
    }

    /** A note table cell's blocks as one line of inline content. */
    private cellInlines(cell: MdTableCell, definitions: Map<string, MdFootnoteDefinition>): MdInline[] {
        const out: MdInline[] = [];
        const lineBreak = () => {
            if (out.length > 0) out.push({ type: 'html', value: '<br>' });
        };
        const visit = (blocks: MdBlock[], bullet: string) => {
            for (const block of blocks) {
                switch (block.type) {
                    case 'paragraph':
                    case 'heading': {
                        lineBreak();
                        if (bullet) out.push({ type: 'text', value: bullet });
                        const content = this.inlines(block.children, definitions);
                        out.push(...(block.type === 'heading' || cell.header ? [{ type: 'strong' as const, children: content }] : content));
                        bullet = '';
                        break;
                    }
                    case 'list':
                        block.children.forEach((item, index) => visit(item.children, block.ordered ? `${(block.start ?? 1) + index}. ` : '• '));
                        break;
                    case 'blockquote':
                        visit(block.children, bullet);
                        break;
                    case 'code':
                        block.value.split('\n').forEach(line => {
                            lineBreak();
                            out.push({ type: 'inlineCode', value: line });
                        });
                        break;
                    case 'math':
                        lineBreak();
                        this.equations += 1;
                        out.push({ type: 'inlineMath', value: block.value.trim() });
                        break;
                    case 'table':
                        for (const row of block.children) {
                            lineBreak();
                            row.children.forEach((inner, index) => {
                                if (index > 0) out.push({ type: 'text', value: ' | ' });
                                out.push(...this.cellInlines(inner, definitions));
                            });
                        }
                        break;
                    default:
                        break;
                }
            }
        };
        visit(cell.blocks ?? [{ type: 'paragraph', children: cell.children }], '');
        // GFM writes a line break in a table cell as a space.
        return breaksAsHtml(out);
    }

    private table(node: MdTable, definitions: Map<string, MdFootnoteDefinition>): MdTable {
        if (isNoteTable(node)) return this.noteTable(node, definitions);
        const columns = Math.max(...node.children.map(row => row.children.length), 1);
        return {
            type: 'table',
            align: Array.from({ length: columns }, (_, index) => node.align?.[index] ?? null),
            children: node.children.map(row => ({
                type: 'tableRow',
                children: Array.from({ length: columns }, (_, index) => ({
                    type: 'tableCell',
                    children: row.children[index] ? this.inlines(row.children[index].children, definitions) : [],
                })),
            })),
        };
    }

    // -- Document ------------------------------------------------------------

    private sections(): MdBlock[] {
        const { doc, options } = this.input;
        const out: MdBlock[] = [];
        if (!options.frontMatter && doc.title.trim()) {
            out.push({ type: 'heading', depth: 1, children: [{ type: 'text', value: doc.title.trim() }] });
        }
        for (const section of doc.sections) {
            const definitions = sectionFootnoteDefinitions(doc, section);
            if (section.kind === 'user') {
                // `> **User:** …`: the quote marks the prompt; the reply follows unquoted.
                const children = this.blocks(section.children, definitions);
                const label: MdInline[] = [{ type: 'strong', children: [{ type: 'text', value: 'User:' }] }, { type: 'text', value: ' ' }];
                const [first, ...rest] = children;
                out.push({
                    type: 'blockquote',
                    children: first?.type === 'paragraph'
                        ? [{ ...first, children: [...label, ...first.children] }, ...rest]
                        : [{ type: 'paragraph', children: label.slice(0, 1) }, ...children],
                });
                continue;
            }
            if (section.kind === 'activity') {
                for (const call of section.calls ?? []) {
                    out.push({ type: 'paragraph', children: [{ type: 'emphasis', children: [{ type: 'text', value: curlyQuotes(call) }] }] });
                }
                continue;
            }
            if (section.kind === 'note' && section.title) {
                out.push({ type: 'heading', depth: 1, children: [{ type: 'text', value: section.title }] });
            }
            out.push(...this.blocks(section.children, definitions));
        }
        return out;
    }

    private footnoteDefinitions(): MdBlock[] {
        return [...this.notes.entries()]
            .sort(([a], [b]) => a - b)
            .map(([id, children]): MdFootnoteDefinition => ({ type: 'footnoteDefinition', identifier: String(id), children }));
    }

    private bibliography(): MdBlock[] {
        const bibliography = this.input.citations.bibliography;
        if (!bibliography || bibliography.entries.length === 0) return [];
        return [
            { type: 'heading', depth: 1, children: [{ type: 'text', value: this.input.options.bibliographyTitle }] },
            ...bibliography.entries.map((entry): MdBlock => ({
                type: 'paragraph',
                children: trimInlines(segmentsToInlines(parseCslHtml(entry), { links: true })),
            })),
        ];
    }

    private frontMatter(): string {
        const fields = this.input.options.frontMatter;
        if (!fields) return '';
        const title = this.input.doc.title.trim();
        const lines = Object.entries({ ...(title ? { title } : {}), ...fields })
            .filter(([, value]) => value)
            // A JSON string is a valid YAML double-quoted scalar.
            .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
        return lines.length > 0 ? `---\n${lines.join('\n')}\n---\n\n` : '';
    }

    build(): string {
        const body = this.sections();
        // Notes are complete once the body is written.
        const root: MdRoot = { type: 'root', children: [...body, ...this.footnoteDefinitions(), ...this.bibliography()] };
        return this.frontMatter() + stringifyMarkdown(root);
    }

    result(markdown: string): WriteMarkdownResult {
        const warnings: ExportWarning[] = [];
        if (this.simplifiedTables > 0) {
            warnings.push({
                code: 'formatting_simplified',
                message: `${this.simplifiedTables} table${this.simplifiedTables === 1 ? '' : 's'} had merged cells or lists that Markdown tables cannot show; ${this.simplifiedTables === 1 ? 'it was' : 'they were'} simplified.`,
                count: this.simplifiedTables,
            });
        }
        return {
            markdown,
            warnings,
            stats: { citations: this.citationCount, footnotes: this.noteCount, equations: this.equations },
        };
    }
}

/** Write the document as Markdown. */
export function writeMarkdown(input: WriteMarkdownInput): WriteMarkdownResult {
    const writer = new MarkdownWriter(input);
    return writer.result(writer.build());
}
