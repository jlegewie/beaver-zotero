/**
 * Write an export document as LaTeX source, citing with keys of a .bib file
 * the host writes next to it.
 *
 * Citations become biblatex (`\parencite`, `\autocite` for note styles) or
 * natbib (`\citep`) commands with the cited pages as postnotes, so LaTeX
 * formats them; the host supplies each cited work's key. The citation
 * processor's output is only used for citations without a key. Markdown maps
 * to standard LaTeX: sections, lists, `quote`, `verbatim`, booktabs tables,
 * `\href` links and footnotes; equations are passed through as written.
 *
 * Footnotes are numbered the way LaTeX numbers them — markdown footnotes and
 * note-style citations in one sequence — so a repeated footnote reference
 * (`\footnotemark[n]`) and notes from table cells point at the right number.
 * A body-only export counts from the footnote number where it is inserted.
 */

import type { MdBlock, MdBlockLayout, MdFootnoteDefinition, MdImage, MdInline, MdTable, MdTableCell } from '../mdast';
import { assignNotePlacements, sectionFootnoteDefinitions, type NotePlacement } from '../citations/noteIndices';
import { citationNotes, type CitationNotes } from '../citations/citationNotes';
import { exportLinkTarget } from '../links';
import { hexDigits } from '../note/colors';
import { trailingText } from '../note/inlineText';
import { imageDisplayWidth, imageFallback, PIXELS_PER_INCH } from '../note/images';
import { isPageLabel, locatorTerm } from '../note/locatorTerms';
import { columnWeights, isNoteTable, tableGrid } from '../note/tableGrid';
import { paperSize } from '../page';
import type { ExportDoc, ExportImage, ExportWarning, FormattedCitations, FormattedCluster, LatexExportOptions } from '../types';
import { escapeLatex, escapeLatexCode, latexUrl } from './escape';

export interface WriteLatexInput {
    doc: ExportDoc;
    citations: FormattedCitations;
    /** Citation key of each cited work, by processor id (as a string). */
    keys: Record<string, string>;
    options: LatexExportOptions;
    /** Images of the document by asset id (Zotero notes), each with its file's path next to the document. */
    images?: Record<string, ExportImage>;
}

export interface WriteLatexResult {
    tex: string;
    warnings: ExportWarning[];
    stats: { citations: number; citationsAsText: number; footnotes: number; equations: number };
}

/** Sectioning commands by heading level (deeper headings use the last). */
const SECTIONS = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'];

/** Math environments that are complete displays of their own (not valid inside `\[ \]`). */
const DISPLAY_ENVIRONMENT = /^\\begin\{(equation|align|alignat|gather|multline|flalign|eqnarray)(\*?)\}[\s\S]*\\end\{\1\2\}$/;

/** Shorthands KaTeX defines that LaTeX does not, provided when an equation uses them. */
const MATH_SHORTHANDS: Record<string, string> = {
    R: '\\mathbb{R}', N: '\\mathbb{N}', Z: '\\mathbb{Z}', Q: '\\mathbb{Q}', C: '\\mathbb{C}',
};

/** Packages that provide commands an equation may use. */
const MATH_PACKAGES: Array<[RegExp, string]> = [
    [/\\(?:b?cancel|xcancel|cancelto)(?![a-zA-Z])/, 'cancel'],
    [/\\(?:color|textcolor|colorbox)(?![a-zA-Z])/, 'xcolor'],
    [/\\bm(?![a-zA-Z])/, 'bm'],
    [/\\mathscr(?![a-zA-Z])/, 'mathrsfs'],
    [/\\centernot(?![a-zA-Z])/, 'centernot'],
    [/\\(?:coloneqq|eqqcolon|Coloneqq|vcentcolon|mathclap|mathllap|mathrlap)(?![a-zA-Z])/, 'mathtools'],
];

/** Chinese, Japanese or Korean script, which pdfLaTeX cannot typeset. */
const CJK_TEXT = /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
/** Korean script: needs a font with Hangul, which the Japanese setup lacks. */
const HANGUL_TEXT = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;

/**
 * URLs and access dates only for web pages, as CSL styles print them:
 * biblatex's default styles add them to every entry and full citation.
 */
const BIBLATEX_URL_LINES = [
    '\\newcommand{\\BeaverClearUrl}{\\ifentrytype{online}{}{\\clearfield{url}\\clearfield{urlyear}\\clearfield{urlmonth}\\clearfield{urlday}}}',
    '\\AtEveryBibitem{\\BeaverClearUrl}',
    '\\AtEveryCitekey{\\BeaverClearUrl}',
];

/**
 * Equation numbers (`\tag`) where LaTeX allows them. KaTeX accepts a tag
 * inside `aligned` or `gathered`; amsmath does not. An equation that is one
 * such block becomes the display environment (`align*`, `gather*`), where each
 * line may carry a tag; a single tag nested anywhere else moves to the end of
 * the display. A complete display environment (`equation`, `align`, …) is
 * left as written: its tags are already where LaTeX allows them.
 */
export function liftTags(source: string): string {
    if (!/\\tag\*?\{/.test(source) || DISPLAY_ENVIRONMENT.test(source)) return source;
    const whole = /^\\begin\{(aligned|gathered)\}([\s\S]*)\\end\{\1\}$/.exec(source.trim());
    if (whole) {
        const environment = whole[1] === 'aligned' ? 'align*' : 'gather*';
        return `\\begin{${environment}}${whole[2]}\\end{${environment}}`;
    }
    const tags = source.match(/\\tag\*?\{[^{}]*\}/g) ?? [];
    if (tags.length !== 1 || !/\\begin\{/.test(source)) return source;
    return `${source.replace(tags[0], '').trimEnd()} ${tags[0]}`;
}

/** Footnote counter at the start of body-only output. */
const FOOTNOTE_BASE = '\\BeaverFootnoteBase';

/** A cited work in a citation command. */
interface CiteItem extends CitationNotes {
    key: string;
}

/** Width of an image: its own width, but never wider than the line. */
const IMAGE_WIDTH_MACRO = '\\providecommand{\\BeaverImageWidth}[1]{\\ifdim#1>\\linewidth\\linewidth\\else#1\\fi}';


/**
 * A highlight: lua-ul's `\highLight` or soul's `\hl`, whichever is loaded
 * (the standalone preamble picks by engine), else the text unhighlighted.
 */
const HIGHLIGHT_MACRO = '\\providecommand{\\BeaverHighlight}[2]{\\ifdefined\\highLight\\highLight[#1]{#2}\\else\\ifdefined\\hl{\\sethlcolor{#1}\\hl{#2}}\\else#2\\fi\\fi}';

/**
 * `open` + content + `close`, with the content's leading and trailing
 * whitespace outside: some commands drop a space at their start (xcolor's
 * `\textcolor`), and a space inside a mark reads as marked.
 */
function wrapCommand(open: string, content: string, close: string): string {
    const [, leading, core, trailing] = /^(\s*)([\s\S]*?)(\s*)$/.exec(content)!;
    return core ? `${leading}${open}${core}${close}${trailing}` : content;
}

/** Typographic double quotes for a plain label (`"query"` → “query”). */
function curlyQuotes(text: string): string {
    return text.replace(/"([^"]*)"/g, '\u201c$1\u201d');
}

/** An optional argument; braces protect a `]` in its value. */
function optional(value: string): string {
    return value.includes(']') ? `[{${value}}]` : `[${value}]`;
}

/** A page locator for LaTeX: escaped, with ranges as en dashes. */
function locatorTex(locator: string): string {
    return locator.split(/\s*[-\u2013\u2014]+\s*/).map(escapeLatex).join('--');
}

/** Whether inline content holds a citation or footnote reference (commands that may make a footnote). */
function containsNoteOrCitation(node: MdInline): boolean {
    if (node.type === 'citation' || node.type === 'footnoteReference') return true;
    return 'children' in node && node.children.some(containsNoteOrCitation);
}

/** Visible text length of inline content, to size table columns. */
function textLength(nodes: MdInline[]): number {
    let length = 0;
    for (const node of nodes) {
        if ('value' in node && typeof node.value === 'string') length += node.value.length;
        else if ('children' in node) length += textLength(node.children);
        else if (node.type === 'citation') length += 12;
    }
    return length;
}

/** Characters that fit on a line of the standalone document's text width (with room to spare). */
const LINE_LENGTH = 80;
/** Columns at most this wide (labels, numbers) keep their natural width when a table must wrap. */
const NARROW_COLUMN_LENGTH = 15;

/**
 * Which columns of a table wrap (`X` columns): none when the table's natural
 * width fits the line; otherwise every column wider than a label, or all
 * columns when each is narrow but together they are too wide.
 */
export function wrappingColumns(widths: number[]): boolean[] {
    // Each column boundary takes about two characters of padding.
    const natural = widths.reduce((sum, width) => sum + width, 0) + 2 * Math.max(widths.length - 1, 0);
    if (natural <= LINE_LENGTH) return widths.map(() => false);
    const wide = widths.map(width => width > NARROW_COLUMN_LENGTH);
    return wide.some(Boolean) ? wide : widths.map(() => true);
}

interface BlockContext {
    /** Writing the argument of a command (a footnote): no `verbatim`, no tables. */
    inArgument: boolean;
    /** Writing a note table's cell, where a table inside is written as lines of text. */
    inTableCell?: boolean;
    itemize: number;
    enumerate: number;
    /** Heading depth that maps to `\section`, and the level it starts at. */
    headingBase: number;
    headingOffset: number;
}

/** A note made inside a table cell: the cell gets the mark, the text follows the table. */
interface TableNote {
    id: number;
    /** Command that writes the note text at the current footnote number. */
    command: string;
}

class LatexWriter {
    private noteCount = 0;
    private readonly writtenNotes = new Map<MdFootnoteDefinition, number>();
    private readonly placements: Map<number, NotePlacement>;
    private readonly isNoteStyle: boolean;
    private citationCount = 0;
    private citationsAsText = 0;
    private equations = 0;
    /** True while writing a footnote's content, so citations in it stay inline. */
    private insideNote = false;
    /** Depth of open links; links cannot nest. */
    private linkDepth = 0;
    /** Notes of the table cell being written, or null outside tables. */
    private tableNotes: TableNote[] | null = null;
    private readonly packages = new Set<string>();
    /** The body as written, for script detection in the preamble. */
    private bodyText = '';
    private readonly shorthands = new Set<string>();
    private hasCitations = false;
    /** Body-only output numbers footnotes from the insertion point. */
    private usesFootnoteBase = false;
    /** Highlight colors by `#rrggbb`, each defined once as a named color. */
    private readonly highlightColors = new Map<string, string>();
    private usesImageWidth = false;
    /** Paragraphs set right to left, which this output does not support. */
    private rightToLeft = 0;
    /** Clusters written as text because no citation command can express them. */
    private citationsWithoutCommand = 0;
    /** Tables inside table cells, written as lines of text. */
    private flattenedTables = 0;

    constructor(private readonly input: WriteLatexInput) {
        this.isNoteStyle = input.citations.styleClass === 'note';
        this.placements = this.isNoteStyle
            ? assignNotePlacements(input.doc, index => (this.cluster(index)?.items.length ?? 0) > 0)
            : new Map();
    }

    private cluster(index: number): FormattedCluster | undefined {
        return this.input.citations.clusters[index];
    }

    private get biblatex(): boolean {
        return this.input.options.citationPackage === 'biblatex';
    }

    // -- Inline content ------------------------------------------------------

    /** Inline content as LaTeX. `before` is the text written just before it (for a citation's spacing). */
    private inlines(nodes: MdInline[], definitions: Map<string, MdFootnoteDefinition>, inCell = false, before = ''): string {
        let out = '';
        let lastText = before;
        nodes.forEach((node, index) => {
            const next = nodes[index + 1];
            switch (node.type) {
                case 'text': {
                    let value = node.value.replace(/[ \t]*\n[ \t]*/g, '\n');
                    if (inCell) value = value.replace(/\n/g, ' ');
                    // A note mark follows the word directly.
                    if (next?.type === 'citation' && this.createsNote(next.clusterIndex)) value = value.replace(/\s+$/, '');
                    out += escapeLatex(value);
                    if (value) lastText = value;
                    break;
                }
                case 'emphasis':
                    out += `\\emph{${this.inlines(node.children, definitions, inCell)}}`;
                    lastText = trailingText(node.children);
                    break;
                case 'strong':
                    out += `\\textbf{${this.inlines(node.children, definitions, inCell)}}`;
                    lastText = trailingText(node.children);
                    break;
                case 'delete':
                    out += this.strikethrough(node.children, definitions, inCell, lastText);
                    lastText = trailingText(node.children);
                    break;
                case 'underline':
                    out += this.strikethrough(node.children, definitions, inCell, lastText, 'uline');
                    lastText = trailingText(node.children);
                    break;
                case 'subscript':
                    out += wrapCommand('\\textsubscript{', this.inlines(node.children, definitions, inCell), '}');
                    lastText = trailingText(node.children);
                    break;
                case 'superscript':
                    out += wrapCommand('\\textsuperscript{', this.inlines(node.children, definitions, inCell), '}');
                    lastText = trailingText(node.children);
                    break;
                case 'styled':
                    out += this.styled(node.color ?? null, node.background ?? null, node.children, definitions, inCell);
                    lastText = trailingText(node.children);
                    break;
                case 'inlineCode':
                    out += `\\texttt{${escapeLatexCode(node.value)}}`;
                    lastText = node.value;
                    break;
                case 'break':
                    // A line break cannot start a paragraph, and does not exist in a table cell.
                    out += inCell || !out.trim() ? ' ' : '\\newline\n';
                    lastText = ' ';
                    break;
                case 'html': {
                    if (/^<br\s*\/?>$/i.test(node.value.trim())) {
                        out += inCell || !out.trim() ? ' ' : '\\newline\n';
                        lastText = ' ';
                    } else {
                        const text = node.value.replace(/<[^>]*>/g, '');
                        out += escapeLatex(text);
                        if (text) lastText = text;
                    }
                    break;
                }
                case 'link':
                    out += this.link(node.url, node.children, definitions, inCell);
                    lastText = trailingText(node.children);
                    break;
                case 'image': {
                    const tex = this.image(node, definitions, inCell);
                    if (tex) {
                        out += tex;
                        lastText = 'x';
                    }
                    break;
                }
                case 'inlineMath':
                    out += `\\(${this.mathSource(node.value)}\\)`;
                    lastText = 'x';
                    break;
                case 'footnoteReference':
                    out += this.markdownFootnote(node.identifier, definitions);
                    lastText = 'x';
                    break;
                case 'citation': {
                    const needsSpace = !this.createsNote(node.clusterIndex) && /[^\s([{—-]$/.test(lastText);
                    const tex = this.citation(node.clusterIndex);
                    if (tex) {
                        out += (needsSpace ? ' ' : '') + tex;
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
     * Struck-through (or, with `uline`, underlined) text. ulem's commands
     * break on a footnote inside them (and citation commands may make one), so
     * marked runs are written around them, and content holding them is
     * written unmarked.
     */
    private strikethrough(
        children: MdInline[],
        definitions: Map<string, MdFootnoteDefinition>,
        inCell: boolean,
        before: string,
        command: 'sout' | 'uline' = 'sout',
    ): string {
        this.packages.add('ulem');
        let out = '';
        let lastText = before;
        let run: MdInline[] = [];
        const flush = (next: MdInline | undefined) => {
            if (run.length === 0) return;
            // A note mark follows the word directly.
            const last = run[run.length - 1];
            if (next?.type === 'citation' && this.createsNote(next.clusterIndex) && last.type === 'text') {
                run[run.length - 1] = { ...last, value: last.value.replace(/\s+$/, '') };
            }
            const text = this.inlines(run, definitions, inCell, lastText);
            // An underline keeps edge spaces outside (they would read as underlined).
            if (!text.trim()) out += text;
            else out += command === 'uline' ? wrapCommand('\\uline{', text, '}') : `\\sout{${text}}`;
            if (text) lastText = text;
            run = [];
        };
        for (const child of children) {
            if (!containsNoteOrCitation(child)) {
                run.push(child);
                continue;
            }
            flush(child);
            out += this.inlines([child], definitions, inCell, lastText);
            lastText = 'x';
        }
        flush(undefined);
        return out;
    }

    /**
     * Colored text: `\textcolor` for the text color; a background with soul's
     * `\hl`, which only takes plain text (other content keeps no background
     * rather than breaking the document).
     */
    private styled(
        color: string | null,
        background: string | null,
        children: MdInline[],
        definitions: Map<string, MdFootnoteDefinition>,
        inCell: boolean,
    ): string {
        let content = this.inlines(children, definitions, inCell);
        // The highlight packages take plain text only, not the commands
        // escaping writes for symbols and special characters.
        if (background && content.trim() && children.every(child => child.type === 'text') && !content.includes('\\')) {
            this.packages.add('xcolor');
            this.packages.add('highlight');
            let name = this.highlightColors.get(background);
            if (!name) {
                name = `BeaverHighlight${this.highlightColors.size + 1}`;
                this.highlightColors.set(background, name);
            }
            content = wrapCommand(`\\BeaverHighlight{${name}}{`, content, '}');
        }
        if (color) {
            this.packages.add('xcolor');
            content = wrapCommand(`\\textcolor[HTML]{${hexDigits(color)}}{`, content, '}');
        }
        return content;
    }

    /**
     * An image: `\includegraphics` of its file next to the document, at the
     * note's width and at most the line width; otherwise a link to an image on
     * the web (never fetched), its alt text or a placeholder.
     */
    private image(node: MdImage, definitions: Map<string, MdFootnoteDefinition>, inCell: boolean): string {
        const asset = node.assetId ? this.input.images?.[node.assetId] : undefined;
        if (!asset?.path) {
            const fallback = imageFallback(node, this.input.doc);
            if (!fallback) return '';
            if (fallback.linkUrl) return this.link(fallback.linkUrl, [{ type: 'text', value: fallback.text }], definitions, inCell);
            return `\\emph{${escapeLatex(fallback.text)}}`;
        }
        this.packages.add('graphicx');
        this.usesImageWidth = true;
        const inches = Math.max(0.1, imageDisplayWidth(node, asset) / PIXELS_PER_INCH);
        // graphicx reads the path verbatim; the host names files without TeX specials.
        return `\\includegraphics[width=\\BeaverImageWidth{${inches.toFixed(2)}in}]{${asset.path}}`;
    }

    private link(url: string, children: MdInline[], definitions: Map<string, MdFootnoteDefinition>, inCell: boolean): string {
        const target = exportLinkTarget(url, this.input.options.linkItems);
        if (!target || this.linkDepth > 0) return this.inlines(children, definitions, inCell);
        // A bare address is written with `\url`, which breaks long addresses
        // across lines — unless encoding it would change the text it shows.
        if (children.length === 1 && children[0].type === 'text' && children[0].value.trim() === target
            && !/[\\{}^~\s]/.test(target)) {
            // Space around the address stays outside it, separating what follows.
            const [, leading, trailing] = /^(\s*)[\s\S]*?(\s*)$/.exec(children[0].value)!;
            return `${leading}\\url{${latexUrl(target)}}${trailing}`;
        }
        this.linkDepth += 1;
        const content = this.inlines(children, definitions, inCell);
        this.linkDepth -= 1;
        return `\\href{${latexUrl(target)}}{${content}}`;
    }

    /** Equation source as written, without blank lines (a paragraph break ends math mode). */
    private mathSource(latex: string): string {
        this.equations += 1;
        const source = latex.trim().replace(/\n[ \t]*\n+/g, '\n');
        for (const [name] of Object.entries(MATH_SHORTHANDS)) {
            if (new RegExp(`\\\\${name}(?![a-zA-Z])`).test(source)) this.shorthands.add(name);
        }
        for (const [pattern, pkg] of MATH_PACKAGES) {
            if (pattern.test(source)) this.packages.add(pkg);
        }
        return source;
    }

    private displayMath(latex: string): string {
        const source = liftTags(this.mathSource(latex));
        return DISPLAY_ENVIRONMENT.test(source) ? source : `\\[\n${source}\n\\]`;
    }

    /**
     * The footnote number of note `id` of this document, for commands that
     * take an explicit number. Body-only output is inserted after whatever
     * footnotes precede it, so its numbers count from the counter's value
     * there (`FOOTNOTE_BASE`).
     */
    private noteNumber(id: number): string {
        if (this.input.options.standalone) return String(id);
        this.usesFootnoteBase = true;
        return `\\numexpr${FOOTNOTE_BASE}+${id}\\relax`;
    }

    /**
     * A footnote with `text`: written in place, or in a table cell as a mark
     * whose text follows the table. `tableNote` is the text command used
     * after a table (default `\footnotetext{text}`).
     */
    private footnote(text: string, tableNote = `\\footnotetext{${text}}`): string {
        const id = ++this.noteCount;
        if (this.tableNotes) {
            this.tableNotes.push({ id, command: tableNote });
            return `\\footnotemark[${this.noteNumber(id)}]`;
        }
        return `\\footnote{${text}}`;
    }

    private markdownFootnote(identifier: string, definitions: Map<string, MdFootnoteDefinition>): string {
        if (this.insideNote) return '';
        const definition = definitions.get(identifier);
        if (!definition) return '';
        // A repeated reference points at the note already written.
        const existing = this.writtenNotes.get(definition);
        if (existing !== undefined) return `\\footnotemark[${this.noteNumber(existing)}]`;
        this.insideNote = true;
        const linkDepth = this.linkDepth;
        const tableNotes = this.tableNotes;
        this.linkDepth = 0;
        this.tableNotes = null;
        const content = this.blocks(definition.children, definitions, {
            inArgument: true, itemize: 0, enumerate: 0, headingBase: 1, headingOffset: 0,
        });
        this.linkDepth = linkDepth;
        this.tableNotes = tableNotes;
        this.insideNote = false;
        const mark = this.footnote(content);
        this.writtenNotes.set(definition, this.noteCount);
        return mark;
    }

    // -- Citations -----------------------------------------------------------

    private createsNote(clusterIndex: number): boolean {
        return this.isNoteStyle && !this.insideNote && !!this.placements.get(clusterIndex)?.ownFootnote;
    }

    /** Postnote of a natbib citation: natbib does not add the page prefix itself. */
    private natbibPostnote(locator: string): string {
        const pages = locatorTex(locator);
        return `${/[-,]/.test(locator) ? 'pp.' : 'p.'}~${pages}`;
    }

    /**
     * The postnote of a cited work: its locator, then its suffix. biblatex
     * adds "p." to a bare page number itself; natbib needs it written; other
     * locator types carry their term (`chap.~3`).
     */
    private postnote(item: CiteItem): string {
        let post = '';
        if (item.locator) {
            if (!isPageLabel(item.label)) {
                const term = locatorTerm(item.label!);
                post = `${term ? `${escapeLatex(term)}~` : ''}${locatorTex(item.locator)}`;
            } else if (!this.biblatex) {
                post = this.natbibPostnote(item.locator);
            } else if (item.suffix) {
                // Followed by text, the postnote is no longer a bare page number.
                post = `${/[-,]/.test(item.locator) ? '\\ppno' : '\\pno'}~${locatorTex(item.locator)}`;
            } else {
                post = locatorTex(item.locator);
            }
        }
        if (item.suffix) post = post ? `${post} ${escapeLatex(item.suffix)}` : escapeLatex(item.suffix);
        return post;
    }

    /**
     * Whether a cited work is written without its author. Numeric and label
     * styles name no authors, so there is nothing to leave out (a year-only
     * command would replace the number).
     */
    private leavesOutAuthor(item: CiteItem): boolean {
        const format = this.input.citations.citationFormat;
        return !!item.suppressAuthor && format !== 'numeric' && format !== 'label';
    }

    /** Optional arguments of a cited work: `[pre][post]`, `[post]` or none. */
    private notes(item: CiteItem): string {
        const post = this.postnote(item);
        if (item.prefix) return `${optional(escapeLatex(item.prefix))}${optional(post)}`;
        return post ? optional(post) : '';
    }

    /**
     * The citation command for a cluster. `command` is the biblatex command
     * (`parencite`, `autocite`, `cite`); natbib clusters are parenthetical,
     * or bare (`\citealp`) when `bare` (the caller adds the note). A single
     * work cited without its author uses the starred biblatex command or
     * natbib's `\citeyearpar`.
     */
    private citeCommand(items: CiteItem[], command: string, bare = false): string {
        const annotated = items.some(item => this.notes(item));
        const withoutAuthor = items.length === 1 && this.leavesOutAuthor(items[0]);
        if (this.biblatex) {
            const single = withoutAuthor && command !== 'footcitetext' ? `${command}*` : command;
            if (!annotated) return `\\${single}{${items.map(item => item.key).join(',')}}`;
            if (items.length === 1) return `\\${single}${this.notes(items[0])}{${items[0].key}}`;
            return `\\${command}s${items.map(item => `${this.notes(item)}{${item.key}}`).join('')}`;
        }
        if (bare) {
            return items.map(item => {
                if (!this.leavesOutAuthor(item)) return `\\citealp${this.notes(item)}{${item.key}}`;
                // natbib's \citeyear drops a prenote; it goes before the year as text.
                const post = this.postnote(item);
                return `${item.prefix ? `${escapeLatex(item.prefix)} ` : ''}\\citeyear${post ? optional(post) : ''}{${item.key}}`;
            }).join('; ');
        }
        if (withoutAuthor) return `\\citeyearpar${this.notes(items[0])}{${items[0].key}}`;
        // Works cited with and without their authors, each on its own.
        if (items.some(item => this.leavesOutAuthor(item))) return `\\citetext{${this.citeCommand(items, command, true)}}`;
        if (!annotated) return `\\citep{${items.map(item => item.key).join(',')}}`;
        if (items.length === 1) return `\\citep${this.notes(items[0])}{${items[0].key}}`;
        return `\\citetext{${this.citeCommand(items, command, true)}}`;
    }

    private citation(clusterIndex: number): string {
        const cluster = this.cluster(clusterIndex);
        if (!cluster) return '';
        const items: CiteItem[] = [];
        let missing = 0;
        for (const item of cluster.items) {
            const key = this.input.keys[String(item.id)];
            if (key) {
                items.push({ key, ...citationNotes(item) });
            } else {
                missing += 1;
            }
        }
        let out = '';
        // A cluster with a work that has no key is kept as its formatted
        // text, so no cited work silently disappears. So is a cluster that
        // leaves out an author where biblatex cannot: in a multi-citation
        // command, or in a footnote (`\footcite` has no starred form). natbib
        // writes each work on its own.
        const unwritable = this.biblatex && items.some(item => this.leavesOutAuthor(item)) && (items.length > 1 || this.isNoteStyle);
        const asText = (missing > 0 || unwritable) && !!cluster.plain;
        if (items.length > 0 || asText) {
            if (asText && missing > 0) this.citationsAsText += 1;
            else if (asText) this.citationsWithoutCommand += 1;
            else this.citationCount += 1;
            if (items.length > 0) this.hasCitations = true;
            if (!this.createsNote(clusterIndex)) {
                out += asText ? escapeLatex(cluster.plain) : this.citeCommand(items, this.isNoteStyle ? 'autocite' : 'parencite');
            } else if (asText) {
                out += this.footnote(escapeLatex(cluster.plain));
            } else if (!this.biblatex) {
                out += this.footnote(`${this.citeCommand(items, 'cite', true)}.`);
            } else if (this.tableNotes) {
                // The note text follows the table, in the style's note form.
                out += this.footnote('', this.citeCommand(items, 'footcitetext'));
            } else {
                // `\autocite` makes the footnote itself.
                this.noteCount += 1;
                out += this.citeCommand(items, 'autocite');
            }
            // Works with a key in a cluster written as text still belong in the bibliography.
            if (asText && items.length > 0) out += `\\nocite{${items.map(item => item.key).join(',')}}`;
        }
        for (const text of cluster.fallbackTexts) {
            out += escapeLatex(`${out ? ' ' : ''}${text}`);
        }
        return out;
    }

    // -- Blocks --------------------------------------------------------------

    private blocks(nodes: MdBlock[], definitions: Map<string, MdFootnoteDefinition>, context: BlockContext): string {
        const parts: string[] = [];
        for (const node of nodes) {
            const part = this.block(node, definitions, context);
            if (part) parts.push(part);
        }
        return parts.join('\n\n');
    }

    private block(node: MdBlock, definitions: Map<string, MdFootnoteDefinition>, context: BlockContext): string {
        switch (node.type) {
            case 'paragraph': {
                const content = this.inlines(node.children, definitions).trim();
                // An image alone in its paragraph is centered, as a figure would be.
                if (!context.inArgument && content && node.children.length === 1 && node.children[0].type === 'image') {
                    return `\\begin{center}\n${content}\n\\end{center}`;
                }
                return this.layout(node, content, context);
            }
            case 'heading': {
                const content = this.inlines(node.children, definitions).trim();
                if (context.inArgument) return `\\textbf{${content}}`;
                const level = Math.min(Math.max(node.depth - context.headingBase + context.headingOffset, 0), SECTIONS.length - 1);
                return `\\${SECTIONS[level]}*{${content}}`;
            }
            case 'thematicBreak':
                return '\\begin{center}\n\\rule{0.5\\linewidth}{0.4pt}\n\\end{center}';
            case 'blockquote':
                return `\\begin{quote}\n${this.blocks(node.children, definitions, context)}\n\\end{quote}`;
            case 'list':
                return this.list(node.ordered ?? false, node.start ?? 1, node.children, definitions, context);
            case 'code': {
                if (context.inArgument) {
                    return node.value.split('\n').map(line => `\\texttt{${escapeLatexCode(line)}}`).join('\\newline\n');
                }
                // Nothing inside `Verbatim` is interpreted except its own end;
                // long lines wrap (fvextra) instead of running off the page.
                this.packages.add('fvextra');
                const value = node.value.replace(/\\end\{Verbatim\}/g, '\\end {Verbatim}');
                return `\\begin{Verbatim}[breaklines,breakanywhere]\n${value}\n\\end{Verbatim}`;
            }
            case 'math':
                return this.displayMath(node.value);
            case 'table':
                // A table inside a table cell: one line per row, cells separated by bars.
                if (context.inTableCell && !this.insideNote) {
                    this.flattenedTables += 1;
                    return node.children
                        .map(row => row.children.map(inner => this.cellContent(inner, definitions)).join(' \\textbar{} '))
                        .join(' \\par\n');
                }
                // Notes hold text, not tables (the note numbering skips them too).
                return context.inArgument || this.insideNote ? '' : this.table(node, definitions);
            default:
                // Raw HTML blocks were turned into paragraphs by the parser;
                // footnote definitions are written where they are referenced.
                return '';
        }
    }

    /**
     * A paragraph with a note's layout: centered or right-aligned text in its
     * environment, indentation as a left skip. Right-to-left text is written
     * as is and counted for a warning: it needs a bidi setup this output does
     * not make.
     */
    private layout(node: MdBlockLayout, content: string, context: BlockContext): string {
        if (!content) return content;
        if (node.dir === 'rtl') this.rightToLeft += 1;
        if (context.inArgument) return content;
        let out = content;
        if (node.align === 'center') out = `\\begin{center}\n${out}\n\\end{center}`;
        else if (node.align === 'right') out = `\\begin{flushright}\n${out}\n\\end{flushright}`;
        if (node.indent) out = `\\begingroup\\leftskip=${node.indent * 2}em\\relax\n${out}\\par\\endgroup`;
        return out;
    }

    private list(
        ordered: boolean,
        start: number,
        items: Array<{ checked?: boolean | null; children: MdBlock[] }>,
        definitions: Map<string, MdFootnoteDefinition>,
        context: BlockContext,
    ): string {
        const depth = ordered ? context.enumerate : context.itemize;
        // LaTeX nests at most four lists of a kind, six in all; deeper lists
        // are written as marked paragraphs.
        if (depth >= 4 || context.itemize + context.enumerate >= 6) {
            return items.map((item, index) => {
                const marker = ordered ? `${start + index}.` : '\\textendash{}';
                return `${marker} ${this.blocks(item.children, definitions, context)}`;
            }).join('\n\n');
        }
        const inner: BlockContext = ordered
            ? { ...context, enumerate: context.enumerate + 1 }
            : { ...context, itemize: context.itemize + 1 };
        const environment = ordered ? 'enumerate' : 'itemize';
        let out = `\\begin{${environment}}\n`;
        const first = Number.isInteger(start) ? start : 1;
        if (ordered && first !== 1) {
            out += `\\setcounter{enum${['i', 'ii', 'iii', 'iv'][depth]}}{${first - 1}}\n`;
        }
        for (const item of items) {
            // A bullet task item's checkbox replaces the bullet; a numbered one
            // keeps its number, with the checkbox after it.
            const box = item.checked == null ? '' : item.checked ? '$\\boxtimes$' : '$\\square$';
            const label = box && !ordered ? `[${box}]` : '';
            const body = this.blocks(item.children, definitions, inner);
            const content = box && ordered ? `${box} ${body}`.trimEnd() : body;
            // A bracket at the start would read as the item's optional label.
            out += `\\item${label}${content ? ` ${!label && content.startsWith('[') ? '{}' : ''}${content}` : ''}\n`;
        }
        return `${out}\\end{${environment}}`;
    }

    /**
     * A Zotero note's table: paragraph columns (cells hold paragraphs and
     * lists) sized from the note's column widths, `\multicolumn` for cells
     * spanning columns, and a cell spanning rows written in its first row (the
     * rows below stay empty there). Cell backgrounds use `\cellcolor`. A first
     * row of header cells repeats on every page.
     */
    private noteTable(node: MdTable, definitions: Map<string, MdFootnoteDefinition>): string {
        const grid = tableGrid(node);
        const columns = grid.columns;
        const weights = columnWeights(node, columns) ?? Array.from({ length: columns }, () => 1);
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        // A share of the line, less the padding of the columns it covers.
        const width = (from: number, span: number) => {
            const share = weights.slice(from, from + span).reduce((sum, weight) => sum + weight, 0) / total;
            const padding = 2 * columns * share - 2 * (span - 1);
            return `\\dimexpr ${share.toFixed(4)}\\linewidth-${Math.max(padding, 0).toFixed(4)}\\tabcolsep\\relax`;
        };
        const column = (from: number, span: number) => `>{\\raggedright\\arraybackslash}p{${width(from, span)}}`;
        this.packages.add('array');
        this.packages.add('booktabs');
        this.packages.add('longtable');

        const notes: TableNote[] = [];
        this.tableNotes = notes;
        const lines: string[] = [];
        grid.rows.forEach((slots, rowIndex) => {
            const cells: string[] = [];
            for (let index = 0; index < columns; index++) {
                const slot = slots[index];
                if (!slot || !slot.origin) {
                    cells.push('');
                    continue;
                }
                const span = Math.min(Math.max(1, slot.cell.colspan ?? 1), columns - index);
                let content = this.cellContent(slot.cell, definitions);
                if (slot.cell.background) {
                    this.packages.add('colortbl');
                    content = `\\cellcolor[HTML]{${hexDigits(slot.cell.background)}}${content}`;
                }
                cells.push(span > 1 ? `\\multicolumn{${span}}{${column(index, span)}}{${content}}` : content);
                index += span - 1;
            }
            lines.push(`${cells.join(' & ')} \\\\`);
            // The header row repeats on every page.
            if (rowIndex === 0 && node.headerRow !== false && grid.rows.length > 1) lines.push('\\midrule', '\\endhead');
        });
        this.tableNotes = null;
        const spec = Array.from({ length: columns }, (_, index) => column(index, 1)).join('');
        let out = `\\begin{longtable}[l]{@{}${spec}@{}}\n\\toprule\n${lines.join('\n')}\n\\bottomrule\n\\end{longtable}`;
        out += notes.map(note => `\n\\setcounter{footnote}{${this.noteNumber(note.id)}}${note.command}`).join('');
        return out;
    }

    /** A note table cell's blocks as paragraph-column content; header cells bold. */
    private cellContent(cell: MdTableCell, definitions: Map<string, MdFootnoteDefinition>): string {
        const blocks = cell.blocks ?? [{ type: 'paragraph', children: cell.children }];
        // As in a command argument: no verbatim and no sectioning; tables inside are flattened.
        const context: BlockContext = { inArgument: true, inTableCell: true, itemize: 0, enumerate: 0, headingBase: 1, headingOffset: 0 };
        const parts = blocks.map(block => {
            if (block.type === 'list') return this.list(block.ordered ?? false, block.start ?? 1, block.children, definitions, context);
            if (block.type === 'math') return this.displayMath(block.value);
            const content = this.block(block, definitions, context);
            return cell.header && content && (block.type === 'paragraph' || block.type === 'heading') ? `\\textbf{${content}}` : content;
        }).filter(Boolean);
        return parts.join(' \\par\n');
    }

    private table(node: MdTable, definitions: Map<string, MdFootnoteDefinition>): string {
        if (isNoteTable(node)) return this.noteTable(node, definitions);
        const [header, ...body] = node.children;
        if (!header) return '';
        const columns = Math.max(...node.children.map(row => row.children.length), 1);
        const wraps = wrappingColumns(Array.from({ length: columns }, (_, index) =>
            Math.max(...node.children.map(row => textLength(row.children[index]?.children ?? [])))));
        const anyWrap = wraps.some(Boolean);
        const spec = Array.from({ length: columns }, (_, index) => {
            const align = node.align?.[index];
            if (!wraps[index]) return align === 'center' ? 'c' : align === 'right' ? 'r' : 'l';
            const alignment = align === 'center' ? '\\centering' : align === 'right' ? '\\raggedleft' : '\\raggedright';
            return `>{${alignment}\\arraybackslash}X`;
        }).join(' ');
        this.packages.add('booktabs');
        // Long tables continue on the next page (`X` columns: xltabular).
        const environment = anyWrap ? 'xltabular' : 'longtable';
        this.packages.add(environment);

        const notes: TableNote[] = [];
        this.tableNotes = notes;
        const row = (cells: MdTable['children'][number]['children']) => Array.from({ length: columns }, (_, index) =>
            (cells[index] ? this.inlines(cells[index].children, definitions, true).trim() : '')).join(' & ') + ' \\\\';
        // The header row repeats on every page.
        const lines = [row(header.children), '\\midrule', '\\endhead', ...body.map(bodyRow => row(bodyRow.children))];
        this.tableNotes = null;

        let out = `\\begin{${environment}}[l]${anyWrap ? '{\\linewidth}' : ''}{@{}${spec}@{}}\n\\toprule\n${lines.join('\n')}\n\\bottomrule\n\\end{${environment}}`;
        // The marks used explicit numbers (an `X` cell is typeset more than
        // once); each text is written at its number, which leaves the counter
        // where the next note continues.
        out += notes.map(note => `\n\\setcounter{footnote}{${this.noteNumber(note.id)}}${note.command}`).join('');
        return out;
    }

    // -- Document ------------------------------------------------------------

    /** Shallowest heading depth among sections (headings of that depth become `\section`). */
    private headingBase(sections: ExportDoc['sections']): number {
        let base = 6;
        const visit = (blocks: MdBlock[]) => {
            for (const block of blocks) {
                if (block.type === 'heading') base = Math.min(base, block.depth);
                else if (block.type === 'blockquote') visit(block.children);
                else if (block.type === 'list') block.children.forEach(item => visit(item.children));
            }
        };
        for (const section of sections) visit(section.children);
        return base;
    }

    private body(): string {
        const { doc } = this.input;
        const parts: string[] = [];
        const responseBase = this.headingBase(doc.sections.filter(section => section.kind !== 'note'));
        for (const section of doc.sections) {
            const definitions = sectionFootnoteDefinitions(doc, section);
            const context: BlockContext = { inArgument: false, itemize: 0, enumerate: 0, headingBase: responseBase, headingOffset: 0 };
            if (section.kind === 'user') {
                parts.push(`\\begin{quote}\n\\textbf{User:} ${this.blocks(section.children, definitions, context)}\n\\end{quote}`);
                continue;
            }
            if (section.kind === 'activity') {
                for (const call of section.calls ?? []) {
                    parts.push(`{\\small\\itshape ${escapeLatex(curlyQuotes(call))}\\par}`);
                }
                continue;
            }
            if (section.kind === 'note') {
                // A note's own headings sit below its title.
                if (section.title) parts.push(`\\section*{${escapeLatex(section.title)}}`);
                const noteContext = { ...context, headingBase: this.headingBase([section]), headingOffset: section.title ? 1 : 0 };
                parts.push(this.blocks(section.children, definitions, noteContext));
                continue;
            }
            parts.push(this.blocks(section.children, definitions, context));
        }
        return parts.filter(Boolean).join('\n\n');
    }

    /** biblatex style options; `isbn=false` also drops ISSNs, which CSL styles leave out. */
    private biblatexOptions(): string {
        return `${this.biblatexStyle()},isbn=false`;
    }

    private biblatexStyle(): string {
        switch (this.input.citations.citationFormat) {
            case 'numeric':
                return 'style=numeric-comp,sorting=none';
            case 'label':
                return 'style=alphabetic';
            case 'note':
                return 'style=verbose,autocite=footnote';
            default:
                return this.isNoteStyle ? 'style=verbose,autocite=footnote' : 'style=authoryear';
        }
    }

    /** Whether the text (body or references) has Chinese, Japanese or Korean script. */
    private get cjk(): { any: boolean; hangul: boolean } {
        const text = `${this.bodyText}\n${(this.input.citations.bibliography?.entries ?? []).join('\n')}`;
        return { any: CJK_TEXT.test(text), hangul: HANGUL_TEXT.test(text) };
    }

    /** Preamble lines that typeset CJK script under LuaLaTeX and XeLaTeX. */
    private cjkLines(): string[] {
        const { any, hangul } = this.cjk;
        if (!any) return [];
        return [
            '\\ifPDFTeX',
            `  \\errmessage{This document contains ${hangul ? 'Korean' : 'Chinese, Japanese or Korean'} text. Compile it with ${hangul ? 'LuaLaTeX' : 'LuaLaTeX or XeLaTeX'}}`,
            '\\fi',
            '\\ifLuaTeX',
            ...(hangul
                ? ['  \\usepackage{luatexko}']
                // Curly quotes stay Latin punctuation, not Japanese characters with their own spacing.
                : ['  \\usepackage{luatexja-fontspec}', '  \\ltjsetparameter{jacharrange={-9}}']),
            '\\fi',
            '\\ifXeTeX',
            // xeCJK's default font has no Hangul, so Korean would vanish.
            hangul
                ? '  \\errmessage{This document contains Korean text, which the default XeLaTeX CJK font lacks. Compile it with LuaLaTeX}'
                : '  \\usepackage{xeCJK}',
            '\\fi',
        ];
    }

    private natbibSetup(): { options: string; style: string } {
        return this.input.citations.citationFormat === 'numeric'
            ? { options: 'numbers,sort&compress', style: 'unsrtnat' }
            : { options: 'round', style: 'plainnat' };
    }

    /** Packages the body uses, in load order. */
    private packageLines(): string[] {
        const lines: string[] = [];
        // Cell colors come from xcolor's table support (colortbl).
        if (this.packages.has('colortbl')) this.packages.add('xcolor');
        for (const pkg of ['array', 'booktabs', 'longtable', 'xltabular', 'ulem', 'fvextra', 'mathtools', 'cancel', 'centernot', 'xcolor', 'graphicx', 'bm', 'mathrsfs']) {
            if (!this.packages.has(pkg)) continue;
            if (pkg === 'ulem') lines.push('\\usepackage[normalem]{ulem}');
            else if (pkg === 'xcolor' && this.packages.has('colortbl')) lines.push('\\usepackage[table]{xcolor}');
            else lines.push(`\\usepackage{${pkg}}`);
        }
        return lines;
    }

    private shorthandLines(): string[] {
        return [...this.shorthands].sort().map(name => `\\providecommand{\\${name}}{${MATH_SHORTHANDS[name]}}`);
    }

    /** Definitions the body's commands need: the image width cap and highlight colors. */
    private definitionLines(): string[] {
        return [
            ...(this.usesImageWidth ? [IMAGE_WIDTH_MACRO] : []),
            ...(this.packages.has('highlight') ? [HIGHLIGHT_MACRO] : []),
            ...[...this.highlightColors].map(([color, name]) => `\\definecolor{${name}}{HTML}{${hexDigits(color)}}`),
        ];
    }

    private standalone(body: string): string {
        const { doc, citations, options } = this.input;
        const title = doc.title.trim();
        const bib = this.hasCitations ? options.bibFileName : null;
        const bibBase = bib?.replace(/\.bib$/i, '') ?? '';
        const paper = paperSize(citations.locale) === 'a4' ? 'a4paper' : 'letterpaper';
        const engines = this.cjk.hangul
            ? 'LuaLaTeX (the text has Korean script)'
            : this.cjk.any ? 'LuaLaTeX or XeLaTeX (not pdfLaTeX: the text has CJK script)' : 'LuaLaTeX, XeLaTeX or pdfLaTeX';
        const lines = [
            ...(title ? [`% ${title.replace(/\s+/g, ' ')}`] : []),
            `% Exported by Beaver. Compile with ${engines}${bib ? (this.biblatex ? ' and Biber' : ' and BibTeX') : ''},`,
            '% for example: latexmk -lualatex <file>.tex',
            '\\documentclass[11pt]{article}',
            '\\usepackage{iftex}',
            '\\ifPDFTeX',
            '  \\usepackage[utf8]{inputenc}',
            '  \\usepackage[T1]{fontenc}',
            '  \\usepackage{lmodern}',
            '\\else',
            '  \\usepackage{fontspec}',
            '\\fi',
            ...this.cjkLines(),
            `\\usepackage[${paper},margin=1in]{geometry}`,
            // Paragraphs separated by space, not indented, as in the other formats.
            '\\usepackage{parskip}',
            '\\usepackage{amsmath,amssymb}',
            ...this.packageLines(),
        ];
        if (bib && this.biblatex) {
            lines.push(
                '\\usepackage{csquotes}',
                `\\usepackage[backend=biber,${this.biblatexOptions()}]{biblatex}`,
                `\\addbibresource{${bib}}`,
                ...BIBLATEX_URL_LINES,
            );
        } else if (bib) {
            lines.push(`\\usepackage[${this.natbibSetup().options}]{natbib}`);
        }
        // Highlights: lua-ul under LuaLaTeX, soul under pdfLaTeX (soul loses
        // non-ASCII text under the Unicode engines); XeLaTeX writes them unhighlighted.
        if (this.packages.has('highlight')) lines.push('\\ifLuaTeX\\usepackage{luacolor,lua-ul}\\fi', '\\ifPDFTeX\\usepackage{soul}\\fi');
        lines.push('\\usepackage[hidelinks]{hyperref}', ...this.shorthandLines(), ...this.definitionLines());
        if (title) {
            lines.push(`\\title{${escapeLatex(title)}}`, '\\author{}', `\\date{${escapeLatex(options.date)}}`);
        }
        lines.push('', '\\begin{document}', '');
        if (title) lines.push('\\maketitle', '');
        lines.push(body, '');
        if (bib && this.biblatex) {
            lines.push(`\\printbibliography[title={${escapeLatex(options.bibliographyTitle)}}]`, '');
        } else if (bib) {
            lines.push(`\\bibliographystyle{${this.natbibSetup().style}}`, `\\bibliography{${bibBase}}`, '');
        }
        lines.push('\\end{document}', '');
        return lines.join('\n');
    }

    /** The body alone, headed by what the including document must provide. */
    private bodyOnly(body: string): string {
        const { options } = this.input;
        const bib = this.hasCitations ? options.bibFileName : null;
        // Options are named where the body depends on them (`xcolor` with `table` for cell colors).
        const packages = ['amsmath', 'amssymb', 'hyperref', ...this.packageLines().map(line => {
            const [, options, name] = /^\\usepackage(?:\[([^\]]*)\])?\{([^}]+)\}$/.exec(line)!;
            return options && name === 'xcolor' ? `${name} (option ${options})` : name;
        }), ...(this.packages.has('highlight') ? ['lua-ul and luacolor (LuaLaTeX) or soul (pdfLaTeX) for highlights'] : [])];
        const lines = [
            '% Exported by Beaver: document body, to include in a LaTeX document.',
            `% Uses the packages ${packages.join(', ')}.`,
        ];
        if (bib && this.biblatex) {
            lines.push(`% Cites with biblatex (${this.biblatexOptions()}); add \\addbibresource{${bib}} to the preamble.`);
        } else if (bib) {
            lines.push(`% Cites with natbib (${this.natbibSetup().options}); add \\bibliography{${bib.replace(/\.bib$/i, '')}} where the references go.`);
        }
        if (this.cjk.any) {
            lines.push(this.cjk.hangul
                ? '% Has Korean text: compile with LuaLaTeX (package luatexko).'
                : '% Has Chinese, Japanese or Korean text: compile with LuaLaTeX (package luatexja-fontspec, with \\ltjsetparameter{jacharrange={-9}}) or XeLaTeX (package xeCJK).');
        }
        const shorthands = this.shorthandLines();
        if (shorthands.length > 0) lines.push('% Equations use these shorthands:', ...shorthands.map(line => `%   ${line}`));
        lines.push('');
        // Definitions the body uses, provided here so the body compiles as it is.
        lines.push(...this.definitionLines());
        if (this.usesFootnoteBase) lines.push(`\\edef${FOOTNOTE_BASE}{\\number\\value{footnote}}`);
        lines.push(body, '');
        return lines.join('\n');
    }

    build(): string {
        const body = this.body();
        this.bodyText = body;
        return this.input.options.standalone ? this.standalone(body) : this.bodyOnly(body);
    }

    result(tex: string): WriteLatexResult {
        const warnings: ExportWarning[] = [];
        if (this.citationsAsText > 0) {
            warnings.push({
                code: 'citations_as_text',
                message: `${this.citationsAsText} citation${this.citationsAsText === 1 ? '' : 's'} could not be given a citation key and ${this.citationsAsText === 1 ? 'was' : 'were'} written as text.`,
                count: this.citationsAsText,
            });
        }
        if (this.citationsWithoutCommand > 0) {
            warnings.push({
                code: 'citations_as_text',
                message: `${this.citationsWithoutCommand} citation${this.citationsWithoutCommand === 1 ? '' : 's'} leaving out an author ${this.citationsWithoutCommand === 1 ? 'was' : 'were'} written as text: biblatex has no command for ${this.citationsWithoutCommand === 1 ? 'it' : 'them'} here.`,
                count: this.citationsWithoutCommand,
            });
        }
        if (this.flattenedTables > 0) {
            warnings.push({
                code: 'formatting_simplified',
                message: `${this.flattenedTables} table${this.flattenedTables === 1 ? '' : 's'} inside a table cell ${this.flattenedTables === 1 ? 'was' : 'were'} written as lines of text.`,
                count: this.flattenedTables,
            });
        }
        if (this.rightToLeft > 0) {
            warnings.push({
                code: 'formatting_simplified',
                message: `${this.rightToLeft} right-to-left paragraph${this.rightToLeft === 1 ? ' was' : 's were'} written left to right; set up bidi (polyglossia or babel) to typeset ${this.rightToLeft === 1 ? 'it' : 'them'}.`,
                count: this.rightToLeft,
            });
        }
        return {
            tex,
            warnings,
            stats: {
                citations: this.citationCount,
                citationsAsText: this.citationsAsText,
                footnotes: this.noteCount,
                equations: this.equations,
            },
        };
    }
}

/** Write the document as LaTeX source. */
export function writeLatex(input: WriteLatexInput): WriteLatexResult {
    const writer = new LatexWriter(input);
    return writer.result(writer.build());
}
