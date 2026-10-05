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
 * Runs in any JS realm: the `docx` library and its zip writer are pure JS. In
 * a realm without `setImmediate`, the host must provide one before this module
 * is evaluated (JSZip otherwise schedules work on a channel that never fires).
 */

import {
    AlignmentType,
    BorderStyle,
    Document,
    ExternalHyperlink,
    FootnoteReferenceRun,
    HeadingLevel,
    ImportedXmlComponent,
    LevelFormat,
    LineRuleType,
    Packer,
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
import { escapeXml, stripInvalidXmlChars } from '../math/xml';
import { footnoteDefinitions, assignNotePlacements, type NotePlacement } from '../citations/noteIndices';
import { parseCslHtml, type StyledSegment } from '../citations/inlineHtml';
import { BIBLIOGRAPHY_FIELD_CODE, citationFieldCode, documentPreferenceProperties } from './zoteroFields';
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
const CODE_FONT = 'Consolas';
const LIST_INDENT = 360;
const QUOTE_INDENT = 567;
const TABLE_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };

/**
 * Raw OOXML as a paragraph child. The `w:`/`m:` prefixes need no declaration
 * here: the parser does not resolve namespaces, and the document root declares
 * both.
 */
function rawXml(xml: string): Child {
    // `root` is the parsed element list; the first entry is the element itself.
    return (ImportedXmlComponent.fromXmlString(xml) as unknown as { root: Child[] }).root[0];
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

/** A text run, with tab characters as real tabs. */
function textRun(text: string, marks: Marks = {}, extra: { break?: number } = {}): TextRun {
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
        ...(marks.hyperlink ? { style: 'Hyperlink' } : {}),
        ...(marks.code ? { font: CODE_FONT, shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } } : {}),
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
    /** Footnote currently being written, so citations inside it stay inline. */
    private insideFootnote: number | null = null;

    constructor(private readonly input: WriteDocxInput) {
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
                    emitText(node.value, { ...marks, code: true });
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
                new TextRun({ text: String(existing), style: 'FootnoteReference' }),
                fieldChar('end'),
            ];
        }
        const id = ++this.footnoteCount;
        this.writtenFootnotes.set(definition, id);
        const previous = this.insideFootnote;
        this.insideFootnote = id;
        const paragraphs = this.blocks(definition.children, { depth: 0, quote: 0 }, definitions)
            .filter((block): block is Paragraph => block instanceof Paragraph);
        this.insideFootnote = previous;
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
            children: [new Paragraph({ style: 'FootnoteText', children: this.citationRuns(noted, {}) })],
        };
        return [new FootnoteReferenceRun(id)];
    }

    // -- Blocks --------------------------------------------------------------

    private blocks(
        nodes: MdBlock[],
        context: { depth: number; quote: number },
        definitions: Map<string, MdFootnoteDefinition>,
    ): Block[] {
        const out: Block[] = [];
        const indent = context.quote * QUOTE_INDENT + context.depth * LIST_INDENT * 2;
        const paragraphBase = {
            ...(this.insideFootnote !== null ? { style: 'FootnoteText' } : context.quote > 0 ? { style: 'Quote' } : {}),
            ...(indent > 0 ? { indent: { left: indent } } : {}),
        };
        for (const node of nodes) {
            switch (node.type) {
                case 'paragraph':
                    out.push(new Paragraph({ ...paragraphBase, children: this.inlines(node.children, {}, definitions) }));
                    break;
                case 'heading':
                    out.push(new Paragraph({
                        heading: HEADINGS[Math.min(Math.max(node.depth, 1), 6) - 1],
                        children: this.inlines(node.children, {}, definitions),
                    }));
                    break;
                case 'thematicBreak':
                    out.push(new Paragraph({
                        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BFBFBF', space: 1 } },
                    }));
                    break;
                case 'blockquote':
                    out.push(...this.blocks(node.children, { ...context, quote: context.quote + 1 }, definitions));
                    break;
                case 'list':
                    out.push(...this.list(node.ordered ?? false, node.start ?? 1, node.children, context, definitions));
                    break;
                case 'code': {
                    const lines = node.value.split('\n');
                    out.push(new Paragraph({
                        style: 'Code',
                        ...(indent > 0 ? { indent: { left: indent } } : {}),
                        children: lines.map((line, index) => textRun(line, {}, index > 0 ? { break: 1 } : {})),
                    }));
                    break;
                }
                case 'math':
                    out.push(new Paragraph({ ...paragraphBase, children: [this.math(node.value, true)] }));
                    break;
                case 'table':
                    if (this.insideFootnote === null) out.push(this.table(node, definitions));
                    break;
                case 'html':
                    // The parser turns raw HTML blocks into paragraphs.
                    break;
                case 'footnoteDefinition':
                    // Written where it is referenced.
                    break;
            }
        }
        return out;
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
            const checkbox = item.checked == null ? [] : [textRun(item.checked ? '☒ ' : '☐ ')];
            const numbering = { reference, level, instance };
            // The item's marker goes on its first block; a block that cannot
            // carry it (code, table, …) gets a marker line of its own.
            if (item.children.length === 0 || !['paragraph', 'heading'].includes(item.children[0].type)) {
                out.push(new Paragraph({ ...(context.quote > 0 ? { style: 'Quote' } : {}), numbering, children: checkbox }));
            }
            item.children.forEach((child, index) => {
                const first = index === 0;
                if (first && child.type === 'paragraph') {
                    out.push(new Paragraph({
                        ...(context.quote > 0 ? { style: 'Quote' } : {}),
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
        return new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
                top: TABLE_BORDER,
                bottom: TABLE_BORDER,
                left: TABLE_BORDER,
                right: TABLE_BORDER,
                insideHorizontal: TABLE_BORDER,
                insideVertical: TABLE_BORDER,
            },
            rows: node.children.map((row, rowIndex) => new TableRow({
                tableHeader: rowIndex === 0,
                children: Array.from({ length: columns }, (_, columnIndex) => {
                    const cell = row.children[columnIndex];
                    return new TableCell({
                        ...(rowIndex === 0 ? { shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } } : {}),
                        margins: { top: 40, bottom: 40, left: 80, right: 80 },
                        children: [new Paragraph({
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
            children.push(...segmentRuns(parseCslHtml(entry)));
            if (live && index === last) children.push(fieldChar('end'));
            return new Paragraph({ style: 'Bibliography', indent, spacing, ...(tabStops.length ? { tabStops } : {}), children });
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
            const definitions = footnoteDefinitions(section.children);
            if (section.kind === 'user') {
                out.push(new Paragraph({ style: 'PromptLabel', children: [textRun('User')] }));
                out.push(...this.blocks(section.children, { depth: 0, quote: 1 }, definitions));
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
        const bulletChars = ['•', '◦', '▪'];
        const orderedFormats = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
        const levels = (ordered: boolean, start = 1, startLevel = 0) => Array.from({ length: 9 }, (_, level) => ({
            level,
            format: ordered ? orderedFormats[level % 3] : LevelFormat.BULLET,
            text: ordered ? `%${level + 1}.` : bulletChars[level % 3],
            alignment: AlignmentType.LEFT,
            start: level === startLevel ? start : 1,
            style: { paragraph: { indent: { left: LIST_INDENT * 2 * (level + 1), hanging: LIST_INDENT } } },
        }));
        const config = [{ reference: BULLETS, levels: levels(false) }, { reference: ORDERED, levels: levels(true) }];
        for (const [reference, { start, level }] of this.orderedStarts) {
            config.push({ reference, levels: levels(true, start, level) });
        }
        return { config };
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
            styles: {
                paragraphStyles: [
                    {
                        id: 'Quote', name: 'Quote', basedOn: 'Normal', next: 'Normal', quickFormat: true,
                        run: { italics: true, color: '404040' },
                        paragraph: { indent: { left: QUOTE_INDENT }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'BFBFBF', space: 8 } } },
                    },
                    {
                        id: 'PromptLabel', name: 'Prompt Label', basedOn: 'Normal', next: 'Quote',
                        run: { bold: true, color: '595959', size: 18 },
                        paragraph: { spacing: { before: 240, after: 60 }, keepNext: true },
                    },
                    {
                        id: 'Code', name: 'Code', basedOn: 'Normal', next: 'Normal',
                        run: { font: CODE_FONT, size: 18 },
                        paragraph: { spacing: { before: 60, after: 120 }, shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } },
                    },
                    { id: 'Bibliography', name: 'Bibliography', basedOn: 'Normal', next: 'Bibliography', quickFormat: true },
                ],
            },
            sections: [{ children: body }],
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
