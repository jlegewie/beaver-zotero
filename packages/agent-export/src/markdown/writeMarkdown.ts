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

import { itemLinkExportHref, parseItemLinkHref } from '@beaver/agent-core/identity/itemLinks';
import type { MdBlock, MdFootnoteDefinition, MdInline, MdRoot, MdTable } from '../mdast';
import { assignNotePlacements, sectionFootnoteDefinitions, type NotePlacement } from '../citations/noteIndices';
import { parseCslHtml, type StyledSegment } from '../citations/inlineHtml';
import { stringifyMarkdown } from '../parse/markdown';
import type { ExportDoc, FormattedCitations, FormattedCluster, MarkdownExportOptions } from '../types';

export interface WriteMarkdownInput {
    doc: ExportDoc;
    citations: FormattedCitations;
    options: MarkdownExportOptions;
}

export interface WriteMarkdownResult {
    markdown: string;
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

function isWebLink(url: string): boolean {
    return /^(https?:|mailto:)/i.test(url.trim());
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
                    out.push({ type: node.type, children: this.inlines(node.children, definitions) });
                    lastText = 'x';
                    break;
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
                    lastText = 'x';
                    break;
                case 'image':
                    if (isWebLink(node.url)) {
                        out.push({ type: 'image', url: node.url.trim(), alt: node.alt ?? '' });
                        lastText = 'x';
                    } else if (node.alt) {
                        out.push({ type: 'emphasis', children: [{ type: 'text', value: node.alt }] });
                        lastText = node.alt;
                    }
                    break;
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

    private link(
        url: string,
        title: string | null | undefined,
        children: MdInline[],
        definitions: Map<string, MdFootnoteDefinition>,
    ): MdInline[] {
        let target: string | null = null;
        if (parseItemLinkHref(url)) {
            target = this.input.options.linkItems ? itemLinkExportHref(url) : null;
        } else if (isWebLink(url)) {
            target = url.trim();
        }
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

    private table(node: MdTable, definitions: Map<string, MdFootnoteDefinition>): MdTable {
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
        return {
            markdown,
            stats: { citations: this.citationCount, footnotes: this.noteCount, equations: this.equations },
        };
    }
}

/** Write the document as Markdown. */
export function writeMarkdown(input: WriteMarkdownInput): WriteMarkdownResult {
    const writer = new MarkdownWriter(input);
    return writer.result(writer.build());
}
