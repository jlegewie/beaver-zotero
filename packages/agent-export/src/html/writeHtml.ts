/**
 * Write an export document as a self-contained HTML page for printing (PDF).
 *
 * Markdown structure maps to semantic HTML styled by the theme's print
 * stylesheet (`theme.ts`). Equations are KaTeX MathML, which Gecko renders
 * natively, so no KaTeX CSS or fonts are needed. Citations carry the text the
 * citation processor produced; with a note style each citation becomes a
 * numbered note, collected with the markdown footnotes into an endnotes
 * section before the bibliography (print has no CSS footnotes).
 *
 * The page loads nothing: no scripts, no remote resources (images are written
 * as their alt text), and a content security policy that forbids both.
 */

import katex from 'katex';
import { itemLinkExportHref, parseItemLinkHref } from '@beaver/agent-core/identity/itemLinks';
import type { MdBlock, MdFootnoteDefinition, MdInline, MdTable } from '../mdast';
import { assignNotePlacements, sectionFootnoteDefinitions, type NotePlacement } from '../citations/noteIndices';
import { decodeHtmlEntities } from '../citations/inlineHtml';
import { paperSize } from '../page';
import type { ExportDoc, ExportWarning, FormattedCitations, FormattedCluster, HtmlExportOptions } from '../types';
import { escapeHtml, isWebLink, sanitizeCslHtml } from './escape';
import { HTML_THEME, stylesheet, type HtmlTheme } from './theme';

export interface WriteHtmlInput {
    doc: ExportDoc;
    citations: FormattedCitations;
    options: HtmlExportOptions;
    /** Formatting; defaults to `HTML_THEME`. */
    theme?: HtmlTheme;
}

/** Page setup the printer applies (paper size and page numbers are not CSS). */
export interface HtmlPageSetup {
    size: 'letter' | 'a4';
    /** Inches on every side (also set by the stylesheet's `@page` rule). */
    margin: number;
    pageNumbers: boolean;
}

export interface WriteHtmlResult {
    html: string;
    page: HtmlPageSetup;
    warnings: ExportWarning[];
    stats: { citations: number; notes: number; equations: number; equationsAsText: number };
}

/**
 * Nothing may load: the document is static and self-contained. Inline styles
 * are its only resource.
 */
const CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'";

/** Typographic double quotes for a plain label (`"query"` → “query”). */
function curlyQuotes(text: string): string {
    return text.replace(/"([^"]*)"/g, '“$1”');
}

/** Visible text of an inline HTML node, escaped; `<br>` stays a line break. */
function inlineHtml(html: string): string {
    if (/^<br\s*\/?>$/i.test(html.trim())) return '<br>';
    return escapeHtml(decodeHtmlEntities(html.replace(/<[^>]*>/g, '')));
}

const noteRef = (id: number) => `<sup class="note-ref">${id}</sup>`;

/** A written block; headings are kept on the page of the text that follows them. */
interface BlockPart {
    html: string;
    kind: 'heading' | 'text' | 'other';
}

/**
 * Join written blocks, wrapping each run of headings with the paragraph or
 * equation after it so a page never ends with a heading (Gecko's print layout
 * does not honor `break-after: avoid`).
 */
function joinBlocks(parts: BlockPart[]): string {
    let out = '';
    for (let index = 0; index < parts.length; index++) {
        if (parts[index].kind !== 'heading') {
            out += parts[index].html;
            continue;
        }
        let end = index;
        while (parts[end + 1]?.kind === 'heading') end += 1;
        if (parts[end + 1]?.kind === 'text') end += 1;
        const run = parts.slice(index, end + 1).map(part => part.html).join('');
        out += end > index ? `<div class="keep">\n${run}</div>\n` : run;
        index = end;
    }
    return out;
}

class HtmlWriter {
    /** Endnote contents by note number. */
    private readonly notes = new Map<number, string>();
    private noteCount = 0;
    private readonly writtenNotes = new Map<MdFootnoteDefinition, number>();
    private equations = 0;
    private equationsAsText = 0;
    private citationCount = 0;
    private readonly placements: Map<number, NotePlacement>;
    private readonly isNoteStyle: boolean;
    private readonly theme: HtmlTheme;
    /** True while writing a note's content, so citations in it stay inline. */
    private insideNote = false;
    /** Depth of open links; anchors cannot nest. */
    private linkDepth = 0;

    constructor(private readonly input: WriteHtmlInput) {
        this.theme = input.theme ?? HTML_THEME;
        this.isNoteStyle = input.citations.styleClass === 'note';
        this.placements = this.isNoteStyle
            ? assignNotePlacements(input.doc, index => (this.cluster(index)?.items.length ?? 0) > 0)
            : new Map();
    }

    private cluster(index: number): FormattedCluster | undefined {
        return this.input.citations.clusters[index];
    }

    // -- Inline content ------------------------------------------------------

    private inlines(nodes: MdInline[], definitions: Map<string, MdFootnoteDefinition>): string {
        let out = '';
        let lastText = '';
        nodes.forEach((node, index) => {
            const next = nodes[index + 1];
            switch (node.type) {
                case 'text': {
                    let value = node.value.replace(/\s*\n\s*/g, ' ');
                    // A note mark follows the word directly.
                    if (next?.type === 'citation' && this.createsNote(next.clusterIndex)) value = value.replace(/\s+$/, '');
                    out += escapeHtml(value);
                    if (value) lastText = value;
                    break;
                }
                case 'emphasis':
                    out += `<em>${this.inlines(node.children, definitions)}</em>`;
                    lastText = 'x';
                    break;
                case 'strong':
                    out += `<strong>${this.inlines(node.children, definitions)}</strong>`;
                    lastText = 'x';
                    break;
                case 'delete':
                    out += `<del>${this.inlines(node.children, definitions)}</del>`;
                    lastText = 'x';
                    break;
                case 'inlineCode':
                    out += `<code>${escapeHtml(node.value)}</code>`;
                    lastText = node.value;
                    break;
                case 'break':
                    out += '<br>';
                    lastText = ' ';
                    break;
                case 'html': {
                    const html = inlineHtml(node.value);
                    out += html;
                    if (html) lastText = html === '<br>' ? ' ' : html;
                    break;
                }
                case 'link':
                    out += this.link(node.url, node.children, definitions);
                    lastText = 'x';
                    break;
                case 'image':
                    if (node.alt) {
                        out += `<em>${escapeHtml(node.alt)}</em>`;
                        lastText = node.alt;
                    }
                    break;
                case 'inlineMath':
                    out += this.math(node.value, false);
                    lastText = 'x';
                    break;
                case 'footnoteReference':
                    out += this.markdownFootnote(node.identifier, definitions);
                    lastText = 'x';
                    break;
                case 'citation': {
                    const needsSpace = !this.createsNote(node.clusterIndex) && /[^\s([{—-]$/.test(lastText);
                    const html = this.citation(node.clusterIndex);
                    if (html) {
                        out += (needsSpace ? ' ' : '') + html;
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

    private link(url: string, children: MdInline[], definitions: Map<string, MdFootnoteDefinition>): string {
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
        return `<a href="${escapeHtml(target)}">${content}</a>`;
    }

    /** KaTeX MathML, or the LaTeX source as code when KaTeX cannot parse it. */
    private math(latex: string, display: boolean): string {
        const source = latex.trim();
        this.equations += 1;
        let html: string;
        try {
            html = katex.renderToString(source, {
                output: 'mathml',
                displayMode: display,
                throwOnError: true,
                strict: 'ignore',
                trust: false,
            });
        } catch {
            this.equationsAsText += 1;
            html = `<code class="math-source">${escapeHtml(source)}</code>`;
        }
        return display ? `<div class="math-display">${html}</div>` : html;
    }

    private markdownFootnote(identifier: string, definitions: Map<string, MdFootnoteDefinition>): string {
        if (this.insideNote) return '';
        const definition = definitions.get(identifier);
        if (!definition) return '';
        // A repeated reference points at the note already written.
        const existing = this.writtenNotes.get(definition);
        if (existing !== undefined) return noteRef(existing);
        const id = ++this.noteCount;
        this.writtenNotes.set(definition, id);
        this.insideNote = true;
        const linkDepth = this.linkDepth;
        this.linkDepth = 0;
        this.notes.set(id, this.blocks(definition.children, definitions));
        this.linkDepth = linkDepth;
        this.insideNote = false;
        return noteRef(id);
    }

    // -- Citations -----------------------------------------------------------

    private createsNote(clusterIndex: number): boolean {
        return this.isNoteStyle && !this.insideNote && !!this.placements.get(clusterIndex)?.ownFootnote;
    }

    /** The citation's text: the processor's formatting, then any citations kept as plain text. */
    private citationHtml(cluster: FormattedCluster, inLink: boolean): string {
        let out = '';
        if (cluster.items.length > 0) {
            this.citationCount += 1;
            out += `<span class="citation">${sanitizeCslHtml(cluster.html, { links: !inLink })}</span>`;
        }
        // Spacing before the cluster itself comes from the surrounding text.
        for (const text of cluster.fallbackTexts) {
            out += escapeHtml(`${out ? ' ' : ''}${text}`);
        }
        return out;
    }

    private citation(clusterIndex: number): string {
        const cluster = this.cluster(clusterIndex);
        if (!cluster) return '';
        if (!this.createsNote(clusterIndex)) return this.citationHtml(cluster, this.linkDepth > 0);
        const id = ++this.noteCount;
        this.notes.set(id, `<p>${this.citationHtml(cluster, false)}</p>`);
        return noteRef(id);
    }

    // -- Blocks --------------------------------------------------------------

    private blocks(nodes: MdBlock[], definitions: Map<string, MdFootnoteDefinition>): string {
        return joinBlocks(this.blockParts(nodes, definitions));
    }

    private blockParts(nodes: MdBlock[], definitions: Map<string, MdFootnoteDefinition>): BlockPart[] {
        const out: BlockPart[] = [];
        const other = (html: string) => out.push({ html, kind: 'other' });
        for (const node of nodes) {
            switch (node.type) {
                case 'paragraph':
                    out.push({ html: `<p>${this.inlines(node.children, definitions)}</p>\n`, kind: 'text' });
                    break;
                case 'heading': {
                    const level = Math.min(Math.max(node.depth, 1), 6);
                    out.push({ html: `<h${level}>${this.inlines(node.children, definitions)}</h${level}>\n`, kind: 'heading' });
                    break;
                }
                case 'thematicBreak':
                    other('<hr>\n');
                    break;
                case 'blockquote':
                    other(`<blockquote>\n${this.blocks(node.children, definitions)}</blockquote>\n`);
                    break;
                case 'list':
                    other(this.list(node.ordered ?? false, node.start ?? 1, node.children, definitions));
                    break;
                case 'code':
                    other(`<pre><code>${escapeHtml(node.value)}</code></pre>\n`);
                    break;
                case 'math':
                    out.push({ html: `${this.math(node.value, true)}\n`, kind: 'text' });
                    break;
                case 'table':
                    // Notes hold text, not tables (the note numbering skips them too).
                    if (!this.insideNote) other(this.table(node, definitions));
                    break;
                case 'html':
                    // The parser turns raw HTML blocks into paragraphs.
                    break;
                case 'footnoteDefinition':
                    // Written where it is referenced.
                    break;
                default:
                    break;
            }
        }
        return out;
    }

    private list(
        ordered: boolean,
        start: number,
        items: Array<{ checked?: boolean | null; children: MdBlock[] }>,
        definitions: Map<string, MdFootnoteDefinition>,
    ): string {
        const tag = ordered ? 'ol' : 'ul';
        const startAttribute = ordered && Number.isInteger(start) && start !== 1 ? ` start="${start}"` : '';
        let out = `<${tag}${startAttribute}>\n`;
        for (const item of items) {
            const task = item.checked != null;
            const checkbox = task ? (item.checked ? '☒ ' : '☐ ') : '';
            const [first, ...rest] = item.children;
            let content: string;
            if (first?.type === 'paragraph') {
                content = `<p>${checkbox}${this.inlines(first.children, definitions)}</p>\n${this.blocks(rest, definitions)}`;
            } else {
                content = `${checkbox ? `<p>${checkbox}</p>\n` : ''}${this.blocks(item.children, definitions)}`;
            }
            out += `<li${task ? ' class="task"' : ''}>${content}</li>\n`;
        }
        return `${out}</${tag}>\n`;
    }

    private table(node: MdTable, definitions: Map<string, MdFootnoteDefinition>): string {
        const columns = Math.max(...node.children.map(row => row.children.length), 1);
        const alignment = (index: number) => {
            const align = node.align?.[index];
            return align === 'center' || align === 'right' ? ` style="text-align:${align}"` : '';
        };
        const row = (cells: MdTable['children'][number]['children'], cellTag: 'th' | 'td') =>
            `<tr>${Array.from({ length: columns }, (_, index) => {
                const cell = cells[index];
                return `<${cellTag}${alignment(index)}>${cell ? this.inlines(cell.children, definitions) : ''}</${cellTag}>`;
            }).join('')}</tr>`;
        const [header, ...body] = node.children;
        if (!header) return '';
        return `<table>\n<thead>${row(header.children, 'th')}</thead>\n`
            + (body.length > 0 ? `<tbody>\n${body.map(bodyRow => row(bodyRow.children, 'td')).join('\n')}\n</tbody>\n` : '')
            + '</table>\n';
    }

    // -- Document ------------------------------------------------------------

    private sections(): string {
        const { doc } = this.input;
        let out = '';
        if (doc.title.trim()) out += `<h1 class="doc-title">${escapeHtml(doc.title.trim())}</h1>\n`;
        for (const section of doc.sections) {
            const definitions = sectionFootnoteDefinitions(doc, section);
            if (section.kind === 'user') {
                out += '<p class="prompt-label">User</p>\n';
                out += `<div class="prompt">\n${this.blocks(section.children, definitions)}</div>\n`;
                continue;
            }
            if (section.kind === 'activity') {
                const calls = section.calls ?? [];
                if (calls.length > 0) {
                    out += `<div class="activity">\n${calls.map(call => `<p>${escapeHtml(curlyQuotes(call))}</p>`).join('\n')}\n</div>\n`;
                }
                continue;
            }
            const parts = this.blockParts(section.children, definitions);
            if (section.kind === 'note' && section.title) {
                parts.unshift({ html: `<h1>${escapeHtml(section.title)}</h1>\n`, kind: 'heading' });
            }
            out += joinBlocks(parts);
        }
        return out;
    }

    private endnotes(): string {
        if (this.notes.size === 0) return '';
        const [first, ...rest] = [...this.notes.entries()]
            .sort(([a], [b]) => a - b)
            .map(([id, html]) => `<li value="${id}">${html}</li>`);
        // The heading stays on the page of the first note.
        return `<div class="notes">\n<div class="keep">\n<h1>${escapeHtml(this.input.options.notesTitle)}</h1>\n<ol>\n${first}\n</ol>\n</div>\n`
            + (rest.length > 0 ? `<ol>\n${rest.join('\n')}\n</ol>\n` : '')
            + '</div>\n';
    }

    private bibliography(): string {
        const bibliography = this.input.citations.bibliography;
        if (!bibliography || bibliography.entries.length === 0) return '';
        const entries = bibliography.entries.map(entry => {
            const html = sanitizeCslHtml(entry.trim());
            return html.startsWith('<div class="csl-entry') ? html : `<div class="csl-entry">${html}</div>`;
        });
        const [first, ...rest] = entries;
        // The heading stays on the page of the first entry.
        return `<div class="bibliography">\n<div class="csl-bib-body">\n`
            + `<div class="keep">\n<h1>${escapeHtml(this.input.options.bibliographyTitle)}</h1>\n${first}\n</div>\n`
            + (rest.length > 0 ? `${rest.join('\n')}\n` : '')
            + '</div>\n</div>\n';
    }

    build(): string {
        const { doc, citations } = this.input;
        const body = this.sections();
        // Notes are complete once the body is written.
        const back = this.endnotes() + this.bibliography();
        return [
            '<!DOCTYPE html>',
            `<html lang="${escapeHtml(citations.locale || 'en')}">`,
            '<head>',
            '<meta charset="utf-8">',
            `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
            `<title>${escapeHtml(doc.title.trim() || 'Beaver export')}</title>`,
            `<style>\n${stylesheet(this.theme, citations.bibliography?.layout ?? null)}\n</style>`,
            '</head>',
            '<body>',
            body + back,
            '</body>',
            '</html>',
            '',
        ].join('\n');
    }

    result(html: string): WriteHtmlResult {
        const warnings: ExportWarning[] = [];
        if (this.equationsAsText > 0) {
            warnings.push({
                code: 'math_as_text',
                message: `${this.equationsAsText} equation${this.equationsAsText === 1 ? '' : 's'} exported as LaTeX text.`,
                count: this.equationsAsText,
            });
        }
        return {
            html,
            page: {
                size: paperSize(this.input.citations.locale, this.theme.page.size),
                margin: this.theme.page.margin,
                pageNumbers: this.theme.page.pageNumbers,
            },
            warnings,
            stats: {
                citations: this.citationCount,
                notes: this.noteCount,
                equations: this.equations,
                equationsAsText: this.equationsAsText,
            },
        };
    }
}

/** Write the document as a self-contained HTML page. */
export function writeHtml(input: WriteHtmlInput): WriteHtmlResult {
    const writer = new HtmlWriter(input);
    return writer.result(writer.build());
}
