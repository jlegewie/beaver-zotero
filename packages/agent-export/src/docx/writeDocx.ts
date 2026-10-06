/**
 * Write an export document as a Word (.docx) file.
 *
 * Headings, lists, tables, quotes, code and links map to Word's built-in
 * structures; equations become native Office Math (see `math/`). Citations are
 * written with the text the citation processor produced and, with live
 * citations on, as Zotero fields: the Zotero Word plugin then recognizes them
 * and can refresh them, change the style and keep the bibliography current.
 * Note styles put each citation in a footnote.
 *
 * All formatting comes from the theme (`theme.ts`): this module only picks
 * style ids and structure.
 *
 * Runs in any JS realm: the `docx` library and its zip writer are pure JS. In
 * a realm without `setImmediate`, the host must provide one before this module
 * is evaluated (JSZip otherwise schedules work on a channel that never fires).
 */

import {
    AlignmentType,
    BorderStyle,
    Document,
    ExternalHyperlink,
    Footer,
    FootnoteReferenceRun,
    HeadingLevel,
    ImportedXmlComponent,
    LineRuleType,
    Packer,
    PageNumber,
    Paragraph,
    ShadingType,
    Tab,
    Table,
    TableCell,
    TableRow,
    TabStopType,
    TextRun,
    WidthType,
    type ParagraphChild,
} from 'docx';
import { itemLinkExportHref, parseItemLinkHref } from '@beaver/agent-core/identity/itemLinks';
import type { MdBlock, MdFootnoteDefinition, MdInline, MdTable } from '../mdast';
import { latexToOmml } from '../math/latexToOmml';
import { escapeXml, parseXml, stripInvalidXmlChars, type XmlNode } from '../math/xml';
import { assignNotePlacements, sectionFootnoteDefinitions, type NotePlacement } from '../citations/noteIndices';
import { parseCslHtml, type StyledSegment } from '../citations/inlineHtml';
import { BIBLIOGRAPHY_FIELD_CODE, citationFieldCode, documentPreferenceProperties } from './zoteroFields';
import {
    DOCX_THEME,
    STYLE,
    documentStyles,
    gapAfterBlock,
    listContinuationIndent,
    listLevels,
    pageProperties,
    taskLevels,
    quoteIndent,
    tableBorders,
    themeUnits,
    type DocxTheme,
} from './theme';
import type {
    DocxExportOptions,
    ExportDoc,
    ExportWarning,
    FormattedCitations,
    FormattedCluster,
} from '../types';

export interface WriteDocxInput {
    doc: ExportDoc;
    citations: FormattedCitations;
    options: DocxExportOptions;
    /** Formatting; defaults to `DOCX_THEME`. */
    theme?: DocxTheme;
}

export interface WriteDocxResult {
    bytes: Uint8Array;
    warnings: ExportWarning[];
    stats: { citationFields: number; footnotes: number; equations: number; equationsAsText: number };
}

type Child = ParagraphChild;
type Block = Paragraph | Table;

interface Marks {
    bold?: boolean;
    italics?: boolean;
    strike?: boolean;
    code?: boolean;
    superScript?: boolean;
    subScript?: boolean;
    smallCaps?: boolean;
    underline?: boolean;
    hyperlink?: boolean;
}

const HEADINGS = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
];

const BULLETS = 'beaver-bullets';
const ORDERED = 'beaver-ordered';
const TASKS_OPEN = 'beaver-tasks-open';
const TASKS_DONE = 'beaver-tasks-done';

/** Elements whose text is content, kept even when it is only spaces. */
const TEXT_ELEMENTS = new Set(['w:t', 'm:t', 'w:instrText']);

function xmlComponent(node: XmlNode, parentName: string): ImportedXmlComponent | string | null {
    if (node.type === 'text') {
        return node.value.trim() || TEXT_ELEMENTS.has(parentName) ? node.value : null;
    }
    const component = new ImportedXmlComponent(node.name, Object.keys(node.attributes).length > 0 ? node.attributes : undefined);
    for (const child of node.children) {
        const converted = xmlComponent(child, node.name);
        if (converted !== null) component.push(converted);
    }
    return component;
}

/**
 * Raw OOXML as a paragraph child. The `w:`/`m:` prefixes need no declaration
 * here: nothing resolves namespaces, and the document root declares both.
 * Parsed here rather than with `ImportedXmlComponent.fromXmlString`, which
 * drops text that is only whitespace — the em spaces of `\quad` included.
 */
function rawXml(xml: string): Child {
    const element = parseXml(xml).find(node => node.type === 'element');
    if (!element) throw new Error('Raw XML has no element');
    return xmlComponent(element, '') as Child;
}

/** Field begin/end runs, so link handling can keep a field's runs together. */
const FIELD_BEGINS = new WeakSet<object>();
const FIELD_ENDS = new WeakSet<object>();

const fieldChar = (type: 'begin' | 'separate' | 'end'): Child => {
    const run = rawXml(`<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`);
    if (type === 'begin') FIELD_BEGINS.add(run);
    if (type === 'end') FIELD_ENDS.add(run);
    return run;
};
const fieldInstruction = (code: string): Child =>
    rawXml(`<w:r><w:instrText xml:space="preserve">${escapeXml(code)}</w:instrText></w:r>`);

/** A text run, with tab characters as real tabs. Inline code takes the theme's mono face. */
function textRun(text: string, marks: Marks = {}, extra: { break?: number } = {}, theme: DocxTheme = DOCX_THEME): TextRun {
    const parts = stripInvalidXmlChars(text).split('\t');
    const children: Array<string | Tab> = [];
    parts.forEach((part, index) => {
        if (index > 0) children.push(new Tab());
        if (part) children.push(part);
    });
    return new TextRun({
        children,
        ...(extra.break ? { break: extra.break } : {}),
        ...(marks.bold ? { bold: true } : {}),
        ...(marks.italics ? { italics: true } : {}),
        ...(marks.strike ? { strike: true } : {}),
        ...(marks.superScript ? { superScript: true } : {}),
        ...(marks.subScript ? { subScript: true } : {}),
        ...(marks.smallCaps ? { smallCaps: true } : {}),
        ...(marks.underline ? { underline: {} } : {}),
        ...(marks.hyperlink ? { style: STYLE.hyperlink } : {}),
        ...(marks.code ? { font: theme.fonts.mono, shading: { type: ShadingType.CLEAR, fill: theme.colors.codeBackground, color: 'auto' } } : {}),
    });
}

/** Hidden bookmark on a markdown footnote's first reference mark. */
const footnoteBookmark = (footnoteId: number) => `_RefBeaverNote${footnoteId}`;

/** Runs for styled citation-processor output. */
function segmentRuns(segments: StyledSegment[], base: Marks = {}): TextRun[] {
    return segments.map(segment => textRun(segment.text, {
        ...base,
        bold: base.bold || segment.bold,
        italics: segment.italic ?? base.italics,
        smallCaps: segment.smallCaps,
        underline: segment.underline,
        superScript: segment.superscript,
        subScript: segment.subscript,
    }, segment.lineBreak ? { break: 1 } : {}));
}

/** Typographic double quotes for a plain label (`"query"` → “query”). */
function curlyQuotes(text: string): string {
    return text.replace(/"([^"]*)"/g, '\u201c$1\u201d');
}

/** Drop the layout whitespace around an entry (citeproc indents its divs). */
function trimSegments(segments: StyledSegment[]): StyledSegment[] {
    const out = segments.map(segment => ({ ...segment }));
    while (out.length > 0 && !out[0].text.trim() && !out[0].text.includes('\t')) out.shift();
    while (out.length > 0 && !out[out.length - 1].text.trim()) out.pop();
    if (out.length > 0) {
        out[0].text = out[0].text.replace(/^[ \n]+/, '');
        out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
    }
    return out;
}

/** Text of inline HTML, with `<br>` as line breaks and other tags dropped. */
function inlineHtmlText(html: string): { text: string; lineBreak: boolean } {
    if (/^<br\s*\/?>$/i.test(html.trim())) return { text: '', lineBreak: true };
    return { text: html.replace(/<[^>]*>/g, ''), lineBreak: false };
}

function isWebLink(url: string): boolean {
    return /^(https?:|mailto:)/i.test(url);
}

class DocxWriter {
    private readonly footnotes: Record<string, { children: Paragraph[] }> = {};
    /** A markdown footnote is being written and its first text still needs its leading space. */
    private footnoteLeadPending = false;
    private footnoteCount = 0;
    private readonly writtenFootnotes = new Map<MdFootnoteDefinition, number>();
    private bookmarkCount = 0;
    private readonly orderedStarts = new Map<string, { start: number; level: number }>();
    private listInstance = 0;
    private equations = 0;
    private equationsAsText = 0;
    private citationFields = 0;
    private readonly placements: Map<number, NotePlacement>;
    private readonly isNoteStyle: boolean;
    private readonly theme: DocxTheme;
    /** Footnote currently being written, so citations inside it stay inline. */
    private insideFootnote: number | null = null;

    constructor(private readonly input: WriteDocxInput) {
        this.theme = input.theme ?? DOCX_THEME;
        this.isNoteStyle = input.citations.styleClass === 'note';
        this.placements = this.isNoteStyle
            ? assignNotePlacements(input.doc, index => this.hasProcessorItems(index))
            : new Map();
    }

    private cluster(index: number): FormattedCluster | undefined {
        return this.input.citations.clusters[index];
    }

    private hasProcessorItems(index: number): boolean {
        return (this.cluster(index)?.items.length ?? 0) > 0;
    }

    // -- Inline content ------------------------------------------------------

    private inlines(nodes: MdInline[], marks: Marks, definitions: Map<string, MdFootnoteDefinition>): Child[] {
        const out: Child[] = [];
        let lastText = '';
        const emitText = (text: string, textMarks: Marks) => {
            if (!text) return;
            out.push(textRun(text, textMarks));
            lastText = text;
        };

        nodes.forEach((node, index) => {
            const next = nodes[index + 1];
            switch (node.type) {
                case 'text': {
                    let value = node.value.replace(/\s*\n\s*/g, ' ');
                    // A footnote mark follows the word directly.
                    if (next?.type === 'citation' && this.createsFootnote(next.clusterIndex)) value = value.replace(/\s+$/, '');
                    emitText(value, marks);
                    break;
                }
                case 'emphasis':
                    out.push(...this.inlines(node.children, { ...marks, italics: true }, definitions));
                    lastText = 'x';
                    break;
                case 'strong':
                    out.push(...this.inlines(node.children, { ...marks, bold: true }, definitions));
                    lastText = 'x';
                    break;
                case 'delete':
                    out.push(...this.inlines(node.children, { ...marks, strike: true }, definitions));
                    lastText = 'x';
                    break;
                case 'inlineCode':
                    out.push(textRun(node.value, { ...marks, code: true }, {}, this.theme));
                    lastText = node.value;
                    break;
                case 'break':
                    out.push(textRun('', marks, { break: 1 }));
                    lastText = ' ';
                    break;
                case 'html': {
                    const { text, lineBreak } = inlineHtmlText(node.value);
                    if (lineBreak) {
                        out.push(textRun('', marks, { break: 1 }));
                        lastText = ' ';
                    } else {
                        emitText(text, marks);
                    }
                    break;
                }
                case 'link':
                    out.push(...this.link(node.url, node.children, marks, definitions));
                    lastText = 'x';
                    break;
                case 'image':
                    if (node.alt) emitText(node.alt, { ...marks, italics: true });
                    break;
                case 'inlineMath':
                    out.push(this.math(node.value, false));
                    lastText = 'x';
                    break;
                case 'footnoteReference':
                    out.push(...this.markdownFootnote(node.identifier, definitions));
                    lastText = 'x';
                    break;
                case 'citation': {
                    const needsSpace = !this.createsFootnote(node.clusterIndex) && /[^\s([{—-]$/.test(lastText);
                    const runs = this.citation(node.clusterIndex, { ...marks, hyperlink: false });
                    if (runs.length > 0 && needsSpace) out.push(textRun(' ', marks));
                    out.push(...runs);
                    if (runs.length > 0) lastText = 'x';
                    break;
                }
            }
        });
        return out;
    }

    private link(url: string, children: MdInline[], marks: Marks, definitions: Map<string, MdFootnoteDefinition>): Child[] {
        const itemLink = parseItemLinkHref(url);
        let target: string | null = null;
        if (itemLink) {
            target = this.input.options.linkItems ? itemLinkExportHref(url) : null;
        } else if (isWebLink(url)) {
            target = url;
        }
        if (!target) return this.inlines(children, marks, definitions);
        // A hyperlink holds only text runs; equations, footnote marks and
        // citation fields inside the link text are kept, between link parts.
        // A field's runs stay together outside any hyperlink.
        const out: Child[] = [];
        let runs: TextRun[] = [];
        let fieldDepth = 0;
        const flush = () => {
            if (runs.length > 0) out.push(new ExternalHyperlink({ link: target!, children: runs }));
            runs = [];
        };
        for (const child of this.inlines(children, { ...marks, hyperlink: true }, definitions)) {
            if (FIELD_BEGINS.has(child)) fieldDepth += 1;
            if (child instanceof TextRun && fieldDepth === 0) {
                runs.push(child);
            } else {
                flush();
                out.push(child);
            }
            if (FIELD_ENDS.has(child)) fieldDepth -= 1;
        }
        flush();
        return out;
    }

    private math(latex: string, display: boolean): Child {
        const result = latexToOmml(latex, display);
        this.equations += 1;
        if (!result.converted) this.equationsAsText += 1;
        return rawXml(result.xml);
    }

    private markdownFootnote(identifier: string, definitions: Map<string, MdFootnoteDefinition>): Child[] {
        if (this.insideFootnote !== null) return [];
        const definition = definitions.get(identifier);
        if (!definition) return [];
        // A repeated reference is a cross-reference to the note already written
        // (Word's NOTEREF field on a bookmark around the first mark), so it
        // renumbers with the document instead of becoming a second copy.
        const existing = this.writtenFootnotes.get(definition);
        if (existing !== undefined) {
            return [
                fieldChar('begin'),
                fieldInstruction(` NOTEREF ${footnoteBookmark(existing)} \\f \\h `),
                fieldChar('separate'),
                new TextRun({ text: String(existing), style: STYLE.footnoteReference }),
                fieldChar('end'),
            ];
        }
        const id = ++this.footnoteCount;
        this.writtenFootnotes.set(definition, id);
        const previous = this.insideFootnote;
        const previousLead = this.footnoteLeadPending;
        this.insideFootnote = id;
        // A note that opens with a list or code has no text run to lead.
        this.footnoteLeadPending = definition.children[0]?.type === 'paragraph';
        const paragraphs = this.blocks(definition.children, { depth: 0, quote: 0 }, definitions)
            .filter((block): block is Paragraph => block instanceof Paragraph);
        this.insideFootnote = previous;
        this.footnoteLeadPending = previousLead;
        this.footnotes[String(id)] = { children: paragraphs.length > 0 ? paragraphs : [new Paragraph({})] };
        const bookmark = ++this.bookmarkCount;
        return [
            rawXml(`<w:bookmarkStart w:id="${bookmark}" w:name="${footnoteBookmark(id)}"/>`),
            new FootnoteReferenceRun(id),
            rawXml(`<w:bookmarkEnd w:id="${bookmark}"/>`),
        ];
    }

    // -- Citations -----------------------------------------------------------

    private createsFootnote(clusterIndex: number): boolean {
        return this.isNoteStyle && this.insideFootnote === null && !!this.placements.get(clusterIndex)?.ownFootnote;
    }

    /** The citation's visible runs, wrapped in a Zotero field when live. */
    private citationRuns(cluster: FormattedCluster, marks: Marks): Child[] {
        const runs: Child[] = [];
        if (cluster.items.length > 0) {
            const result = segmentRuns(parseCslHtml(cluster.html), marks);
            if (this.input.options.liveCitations) {
                this.citationFields += 1;
                runs.push(fieldChar('begin'), fieldInstruction(citationFieldCode(cluster)), fieldChar('separate'), ...result, fieldChar('end'));
            } else {
                runs.push(...result);
            }
        }
        for (const text of cluster.fallbackTexts) {
            const separator = runs.length > 0 || this.isNoteStyle ? ' ' : '';
            runs.push(textRun(`${separator}${text}`, marks));
        }
        return runs;
    }

    private citation(clusterIndex: number, marks: Marks): Child[] {
        const cluster = this.cluster(clusterIndex);
        if (!cluster) return [];
        if (!this.createsFootnote(clusterIndex)) return this.citationRuns(cluster, marks);

        const id = ++this.footnoteCount;
        // The field records the footnote it actually sits in.
        const noted = { ...cluster, noteIndex: id };
        this.footnotes[String(id)] = {
            children: [new Paragraph({ style: STYLE.footnoteText, children: [textRun(' '), ...this.citationRuns(noted, {})] })],
        };
        return [new FootnoteReferenceRun(id)];
    }

    // -- Blocks --------------------------------------------------------------

    private blocks(
        nodes: MdBlock[],
        context: { depth: number; quote: number },
        definitions: Map<string, MdFootnoteDefinition>,
        /** Space owed by a list or table just before these blocks. */
        leadingGap = 0,
    ): Block[] {
        const out: Block[] = [];
        // Inside a list item, blocks align with the item's text; quotes indent further.
        const indent = listContinuationIndent(context.depth, this.theme) + quoteIndent(context.quote, this.theme);
        const paragraphBase = {
            style: this.insideFootnote !== null ? STYLE.footnoteText : context.quote > 0 ? STYLE.quote : STYLE.body,
            ...(indent > 0 ? { indent: { left: indent, ...(context.quote > 0 ? { right: quoteIndent(1, this.theme) } : {}) } } : {}),
        };
        // A list's items and a table end without a paragraph's space after; the
        // next block makes it up.
        let gapBefore = leadingGap;
        // Word shades a paragraph's spacing too: a code block right after
        // another code block or a table would merge into it or touch it, so an
        // unshaded spacer goes between them.
        let previous: 'code' | 'table' | 'other' | null = null;
        const spacer = () => new Paragraph({
            spacing: { before: 0, after: 0, line: gapAfterBlock(this.theme), lineRule: LineRuleType.EXACT },
            children: [],
        });
        const spacedBase = () => {
            const base = gapBefore > 0 ? { ...paragraphBase, spacing: { before: gapBefore } } : paragraphBase;
            gapBefore = 0;
            return base;
        };
        for (const node of nodes) {
            const kind = node.type === 'code' ? 'code' : node.type === 'table' ? 'table' : 'other';
            switch (node.type) {
                case 'paragraph':
                    out.push(new Paragraph({
                        ...spacedBase(),
                        children: [...this.footnoteLead(), ...this.inlines(node.children, {}, definitions)],
                    }));
                    break;
                case 'heading':
                    out.push(new Paragraph({
                        heading: HEADINGS[Math.min(Math.max(node.depth, 1), 6) - 1],
                        children: this.inlines(node.children, {}, definitions),
                    }));
                    break;
                case 'thematicBreak':
                    out.push(new Paragraph({
                        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: this.theme.colors.rule, space: 1 } },
                    }));
                    break;
                case 'blockquote':
                    out.push(...this.blocks(node.children, { ...context, quote: context.quote + 1 }, definitions, gapBefore));
                    gapBefore = 0;
                    break;
                case 'list':
                    out.push(...this.list(node.ordered ?? false, node.start ?? 1, node.children, context, definitions));
                    gapBefore = gapAfterBlock(this.theme);
                    break;
                case 'code': {
                    const lines = node.value.split('\n');
                    if (previous === 'code' || previous === 'table') out.push(spacer());
                    gapBefore = 0;
                    out.push(new Paragraph({
                        style: STYLE.code,
                        ...(indent > 0 ? { indent: { left: indent } } : {}),
                        children: lines.map((line, index) => textRun(line, {}, index > 0 ? { break: 1 } : {})),
                    }));
                    break;
                }
                case 'math':
                    out.push(new Paragraph({ ...spacedBase(), children: [this.math(node.value, true)] }));
                    break;
                case 'table':
                    if (this.insideFootnote === null) {
                        out.push(this.table(node, definitions));
                        gapBefore = gapAfterBlock(this.theme);
                    }
                    break;
                case 'html':
                    // The parser turns raw HTML blocks into paragraphs.
                    break;
                case 'footnoteDefinition':
                    // Written where it is referenced.
                    break;
            }
            previous = kind;
        }
        return out;
    }

    /**
     * A space after the footnote number, before the note's first text, as
     * Word and Zotero write notes. Given once per note.
     */
    private footnoteLead(): Child[] {
        if (!this.footnoteLeadPending) return [];
        this.footnoteLeadPending = false;
        return [textRun(' ')];
    }

    private list(
        ordered: boolean,
        start: number,
        items: Array<{ checked?: boolean | null; children: MdBlock[] }>,
        context: { depth: number; quote: number },
        definitions: Map<string, MdFootnoteDefinition>,
    ): Block[] {
        const out: Block[] = [];
        const level = Math.min(context.depth, 8);
        const reference = ordered ? this.orderedReference(start, level) : BULLETS;
        const instance = ++this.listInstance;
        for (const item of items) {
            // A bullet task item's checkbox takes the bullet's place; a
            // numbered one keeps its number, with the checkbox after it.
            const isTask = item.checked != null;
            const itemReference = isTask && !ordered ? (item.checked ? TASKS_DONE : TASKS_OPEN) : reference;
            const checkbox = isTask && ordered ? [textRun(item.checked ? '☒ ' : '☐ ')] : [];
            const numbering = { reference: itemReference, level, instance };
            // The item's marker goes on its first block; a block that cannot
            // carry it (code, table, …) gets a marker line of its own.
            if (item.children.length === 0 || !['paragraph', 'heading'].includes(item.children[0].type)) {
                out.push(new Paragraph({ style: context.quote > 0 ? STYLE.quote : STYLE.listParagraph, numbering, children: checkbox }));
            }
            item.children.forEach((child, index) => {
                const first = index === 0;
                if (first && child.type === 'paragraph') {
                    out.push(new Paragraph({
                        style: context.quote > 0 ? STYLE.quote : STYLE.listParagraph,
                        numbering,
                        children: [...checkbox, ...this.inlines(child.children, {}, definitions)],
                    }));
                } else if (first && child.type === 'heading') {
                    out.push(new Paragraph({
                        heading: HEADINGS[Math.min(Math.max(child.depth, 1), 6) - 1],
                        numbering,
                        children: [...checkbox, ...this.inlines(child.children, {}, definitions)],
                    }));
                } else if (child.type === 'list') {
                    out.push(...this.list(child.ordered ?? false, child.start ?? 1, child.children, { ...context, depth: context.depth + 1 }, definitions));
                } else {
                    out.push(...this.blocks([child], { ...context, depth: context.depth + 1 }, definitions));
                }
            });
        }
        return out;
    }

    /** Numbering for an ordered list; a list starting above 1 gets its own definition, starting at its level. */
    private orderedReference(start: number, level: number): string {
        const value = Number.isInteger(start) && start > 0 ? start : 1;
        if (value === 1) return ORDERED;
        const reference = `${ORDERED}-${value}-${level}`;
        this.orderedStarts.set(reference, { start: value, level });
        return reference;
    }

    private table(node: MdTable, definitions: Map<string, MdFootnoteDefinition>): Table {
        const columns = Math.max(...node.children.map(row => row.children.length), 1);
        const alignment = (index: number) => {
            const align = node.align?.[index];
            return align === 'center' ? AlignmentType.CENTER : align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT;
        };
        const borders = tableBorders(this.theme);
        return new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: borders.table,
            rows: node.children.map((row, rowIndex) => new TableRow({
                tableHeader: rowIndex === 0,
                cantSplit: true,
                children: Array.from({ length: columns }, (_, columnIndex) => {
                    const cell = row.children[columnIndex];
                    return new TableCell({
                        ...(rowIndex === 0 ? { borders: { bottom: borders.headerBottom } } : {}),
                        margins: borders.cellMargins,
                        children: [new Paragraph({
                            style: STYLE.tableText,
                            alignment: alignment(columnIndex),
                            children: cell ? this.inlines(cell.children, rowIndex === 0 ? { bold: true } : {}, definitions) : [],
                        })],
                    });
                }),
            })),
        });
    }

    // -- Document ------------------------------------------------------------

    private bibliography(): Paragraph[] {
        const bibliography = this.input.citations.bibliography;
        if (!bibliography || bibliography.entries.length === 0) return [];
        const { layout } = bibliography;
        const indent = {
            left: layout.indent,
            ...(layout.firstLineIndent < 0 ? { hanging: -layout.firstLineIndent } : { firstLine: layout.firstLineIndent }),
        };
        const spacing = { line: layout.lineSpacing || 240, lineRule: LineRuleType.AUTO, after: layout.entrySpacing };
        // A stop at 0 is real: with the number hanging in the margin
        // (`second-field-align="margin"`), it aligns the entry's first line
        // with its continuation lines.
        const tabStops = layout.tabStops.filter(position => position >= 0)
            .map(position => ({ type: TabStopType.LEFT, position }));
        const live = this.input.options.liveCitations;
        const last = bibliography.entries.length - 1;
        const paragraphs = bibliography.entries.map((entry, index) => {
            const children: Child[] = [];
            if (live && index === 0) children.push(fieldChar('begin'), fieldInstruction(BIBLIOGRAPHY_FIELD_CODE), fieldChar('separate'));
            children.push(...segmentRuns(trimSegments(parseCslHtml(entry))));
            if (live && index === last) children.push(fieldChar('end'));
            return new Paragraph({ style: STYLE.bibliography, indent, spacing, ...(tabStops.length ? { tabStops } : {}), children });
        });
        return [
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [textRun(this.input.options.bibliographyTitle)] }),
            ...paragraphs,
        ];
    }

    private sectionBlocks(): Block[] {
        const { doc } = this.input;
        const out: Block[] = [];
        if (doc.title.trim()) out.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [textRun(doc.title.trim())] }));
        for (const section of doc.sections) {
            const definitions = sectionFootnoteDefinitions(doc, section);
            if (section.kind === 'user') {
                out.push(new Paragraph({ style: STYLE.promptLabel, children: [textRun('User')] }));
                out.push(...this.blocks(section.children, { depth: 0, quote: 1 }, definitions));
                continue;
            }
            if (section.kind === 'activity') {
                for (const call of section.calls ?? []) {
                    out.push(new Paragraph({ style: STYLE.activity, keepNext: true, children: [textRun(curlyQuotes(call))] }));
                }
                continue;
            }
            if (section.kind === 'note' && section.title) {
                out.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [textRun(section.title)] }));
            }
            out.push(...this.blocks(section.children, { depth: 0, quote: 0 }, definitions));
        }
        return out;
    }

    private numbering() {
        const config = [
            { reference: BULLETS, levels: listLevels(false, this.theme) },
            { reference: ORDERED, levels: listLevels(true, this.theme) },
            { reference: TASKS_OPEN, levels: taskLevels(false, this.theme) },
            { reference: TASKS_DONE, levels: taskLevels(true, this.theme) },
        ];
        for (const [reference, { start, level }] of this.orderedStarts) {
            config.push({ reference, levels: listLevels(true, this.theme, start, level) });
        }
        return { config };
    }

    /** Centered page numbers, when the theme asks for them. */
    private footers() {
        if (!this.theme.page.pageNumbers) return undefined;
        return {
            default: new Footer({
                children: [new Paragraph({
                    alignment: AlignmentType.CENTER,
                    spacing: { before: 0, after: 0 },
                    children: [new TextRun({
                        children: [PageNumber.CURRENT],
                        size: themeUnits.halfPoints(this.theme.sizes.pageNumber),
                        color: this.theme.colors.muted,
                    })],
                })],
            }),
        };
    }

    build(): Document {
        const body = this.sectionBlocks();
        body.push(...this.bibliography());
        const { citations, options, doc } = this.input;
        const customProperties = options.liveCitations && citations.documentData && this.citationFields > 0
            ? documentPreferenceProperties(citations.documentData)
            : [];
        return new Document({
            creator: 'Beaver',
            title: stripInvalidXmlChars(doc.title),
            ...(customProperties.length > 0 ? { customProperties } : {}),
            numbering: this.numbering(),
            footnotes: this.footnotes,
            styles: documentStyles(this.theme),
            sections: [{
                properties: { page: pageProperties(citations.locale, this.theme) },
                ...(this.footers() ? { footers: this.footers() } : {}),
                children: body,
            }],
        });
    }

    result(bytes: Uint8Array): WriteDocxResult {
        const warnings: ExportWarning[] = [];
        if (this.equationsAsText > 0) {
            warnings.push({
                code: 'math_as_text',
                message: `${this.equationsAsText} equation${this.equationsAsText === 1 ? '' : 's'} exported as LaTeX text.`,
                count: this.equationsAsText,
            });
        }
        return {
            bytes,
            warnings,
            stats: {
                citationFields: this.citationFields,
                footnotes: this.footnoteCount,
                equations: this.equations,
                equationsAsText: this.equationsAsText,
            },
        };
    }
}

/** Write the document as .docx bytes. */
export async function writeDocx(input: WriteDocxInput): Promise<WriteDocxResult> {
    const writer = new DocxWriter(input);
    const document = writer.build();
    const buffer = await Packer.toArrayBuffer(document);
    return writer.result(new Uint8Array(buffer));
}
