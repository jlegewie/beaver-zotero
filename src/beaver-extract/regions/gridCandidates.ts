/**
 * Grid candidates: blocks of text lines whose column gutters stay aligned over
 * several rows. Text groups (`textCandidates.ts`) leave running text out, so a
 * table whose cells hold phrases or sentences has no candidate there; this
 * source reads the page's column structure instead and lets running text in
 * when it sits in such a grid.
 *
 * Lines are set in rows (one baseline band each) and cut into segments at
 * wide gaps. A gutter is a vertical strip that stays free of text from row to
 * row and has text on both sides on at least `MIN_ROWS` of them; rows where
 * only one side holds text (a cell wrapping beside an empty one) leave it
 * free. A caption's row ends every gutter. Each gutter proposes the rows it
 * spans, longest first, unless a grid found already holds it.
 *
 * Gutters between the page's text columns (justified running text on both
 * sides, see `layoutGutters`) bound the blocks beside them, and propose a block
 * only when its rows are both ruled apart and start together in every column.
 * An outer text column of the page beside a block is dropped from it. What
 * remains is a grid only with evidence of rows read across its columns, and
 * not when its first column holds list markers:
 * - cells that start on one row in several columns;
 * - rules between its rows;
 * - unless two or more of its columns are justified running text (the page's
 *   text columns): a label column (short lines on some rows only, each beside
 *   text in another column), or cells that are not running text side by side.
 *
 * Two kinds of grid propose less than they hold: a list of entries with their
 * pages (a table of contents, an index) proposes nothing (`entryList`), and the
 * rows of a grid end at the page's running heads and feet (`rowsWithin`). Either
 * is still found as a grid, so that the other grids and candidates of the page
 * are those found without these tests.
 */
import { parsePageNumber } from "../MarginFilter";
import { isBoldFont } from "../StyleAnalyzer";
import { iou, unionRect, type Rect } from "./geometry";
import { NOTE_CAPTION_RE, isSpaceChar, isTableCaption, wideGaps, wordCounts, type Primitive, type RegionLine } from "./pageSignals";
import { extendOverRules } from "./textCandidates";

/** Text on one row this many em apart is in separate columns. */
const GUTTER_EM = 0.7;
/** A gutter has text on both sides on at least this many rows. */
const MIN_ROWS = 3;
/** Rows more than this many line heights apart break a gutter. */
const ROW_GAP = 2.5;
/** A gutter with justified running text on both sides on this many rows separates text columns of the page... */
const LAYOUT_ROWS = 5;
/** ...when the lines on each side are at least this many em wide, at the median (a table's narrow column of justified cells is none). */
const LAYOUT_COLUMN_EM = 15;
/** A gutter inside a block is bordered on at least this share of the block's bordered rows. */
const INNER_SHARE = 0.5;
/** A grid has text in two or more of its columns on at least this many rows. */
const MIN_MULTI_ROWS = 3;
/** A label column holds text on at most this share of the block's rows... */
const SPARSE_OCCUPANCY = 0.75;
/** ...each beside text in another column on at least this share of its rows. */
const ANCHORED = 0.8;
/** A label column's text comes in at least this many runs of rows... */
const LABEL_RUNS = 3;
/** ...of at most this many rows each, at the median (a label wraps over a line or two). */
const LABEL_RUN_ROWS = 3;
/** A list's marker: a number, letter or roman numeral with its punctuation, a bracketed number, or a bullet. */
const LIST_MARKER_RE = /^(?:\(?(?:\d{1,4}|[a-zA-Z]|[ivxlcIVXLC]{1,6})[.):]|\[\d{1,4}\]|[•●○◦▪■►▸‣∙·–—-])$/u;
/** A first column of at least this share of list markers makes the block a list. */
const LIST_MARKERS = 0.7;
/** A label column's lines have at most this many words, at the median. */
const LABEL_WORDS = 5;
/** A gap between rows wider than this many line heights is a band between table rows. */
const BREAK_GAP = 0.6;
/** Rows where two or more columns start a cell together: at least this many past the first... */
const MIN_ALIGNED_STARTS = 2;
/** ...and at least this share of the rows where any column starts one. */
const ALIGNED_STARTS_SHARE = 0.5;
/** A gutter with this share of its rows in a grid found already, within its width, is one of its own. */
const CONTAINED = 0.8;
/** A column's lines end at its right edge, within this many em, on this share of its lines: justified text. */
const JUSTIFY_EM = 0.25;
const JUSTIFIED_LINES = 0.5;
/** Lines of at least this many words take part in the justified test. */
const JUSTIFY_WORDS = 4;
/** Columns of cells that are not running text: at most this share of their lines is running text... */
const SHORT_CELLS_RUNNING = 0.5;
/** ...and at least this share of the rows hold two or more cells. */
const SHORT_CELLS_ROWS = 0.5;
/** A rule between rows spans at least this share of the block's width. */
const ROW_RULE_SPAN = 0.6;
/** Rules between rows: at least this many. */
const MIN_ROW_RULES = 2;
/** A column of prose: at least this share of its segments is running text... */
const PROSE_RUNNING = 0.6;
/** ...and, beside a grid, it holds text on at least this share of the grid's rows. */
const PROSE_OCCUPANCY = 0.8;
/** Two candidates this similar (IoU) are one. */
const DUPLICATE_IOU = 0.9;
/** A wrapped line of a cell starts at most this many em left of its column's cells. */
const WRAP_INDENT_EM = 0.5;
/** A note's marker opening a line: a symbol, or a letter with a bracket or period ("a)", "b. "). */
const NOTE_MARKER_RE = /^\s*(?:[*∗†‡§¶#]|\(?[a-z]\)|[a-z]\.\s)/u;
/** A list of abbreviations ("h, human; m, mouse"). */
const ABBREVIATIONS_RE = /^[^\s,;]{1,15},\s[^,;]{2,60};/u;
/** A numbered heading ("3.2. Results", "B. Analysis", "IV. Discussion"). */
const NUMBERED_HEADING_RE = /^(?:\d{1,2}(?:\.\d{1,2})*\.?|[A-Z]\.|[IVX]{1,4}\.)\s+\p{Lu}/u;
/**
 * A table continuing on another page says so on a line of its own: bracketed ("(Continued)",
 * "[cont'd]") or naming the page ("continued on next page", "continued overleaf"). A bare
 * "Continues" is a cell's value.
 */
const CONTINUED_RE =
    /^(?:[([]\s*(?:continued|cont['’]?d\.?)\s*[)\]]|(?:continued|continues|cont['’]?d\.?)\s+(?:(?:on|to|from)\s+(?:the\s+)?(?:next|following|previous|preceding)\s+page|overleaf))\s*[.…:]*$/iu;
/** A repeated header set over a table's columns is at most this many line heights from its rows. */
const HEADER_GAP = 1;
/** A running head or foot is at most this many lines (a title and its page number)... */
const RUNNING_LINES = 2;
/** ...of at most this many of a grid's cells (a title set with a wide space before its date). */
const RUNNING_CELLS = 3;
/** Dot leaders: a run of four or more dots (or three middle dots, two ellipses), spaced or not. */
const LEADER_RE = /(?:\.\s?){4,}|(?:[·∙•]\s?){3,}|…{2,}/gu;
/** `LEADER_RE`, for testing a text (no global state). */
const LEADERS_RE = new RegExp(LEADER_RE.source, "u");
/** A heading's number ("4", "9.3", "A.1", "IV."); one of a list's entries. */
const SECTION_NUMBER_RE = /^(?:[1-9]\d?|[A-Z])(?:\.[1-9]\d?)*\.?$|^[IVXL]{1,6}\.?$/u;
/** A column of page numbers' head ("Page", "p."), not a table's header. */
const PAGE_HEADER_RE = /^(?:pages?|pp?\.?|pg\.?|seite|page\s+no\.?)$/iu;
/** A list of entries refers to at least this many pages... */
const ENTRY_PAGES = 3;
/** ...in a column of page numbers: at least this share of its cells. */
const PAGE_CELLS = 0.8;
/** Page numbers differ: at least this share of them distinct. */
const DISTINCT_PAGES = 0.5;
/** Entries in order: at least this share of neighbouring entries... */
const ENTRIES_ORDERED = 0.9;
/** ...of at least this many, for entries ordered by name (an index). */
const NAMED_ENTRIES = 6;
/** The other columns of a list hold words or heading numbers: at most this share of their cells is anything else. */
const ENTRY_VALUE_CELLS = 0.2;
/** Dot leaders on at least this share of the rows set entries apart. */
const LEADER_ROWS = 0.5;
/** A line set this many points larger than its column's cells, at the median, is a heading... */
const HEADING_SIZE = 0.5;
/** ...and so is a numbered line of at most this many words. */
const HEADING_WORDS = 4;

/**
 * A character of a line: the character and its extent along the line's row, in
 * its reading frame, from `bbox.l` to `bbox.r` (a structured-text character of
 * an upright line is one as it is).
 */
export interface LineChar {
    c: string;
    bbox: { l: number; r: number };
}

/** A line's characters, left to right in its reading frame: `chars[start]` to `chars[end - 1]`. */
export interface LineChars {
    chars: readonly LineChar[];
    start: number;
    end: number;
}

/**
 * Lines' characters from their structured-text lines (`FindCandidatesOptions.sources`).
 * Cells MuPDF set on one line meet at the gaps between them, and each cell has its
 * own text. Without them a line splits at its `wideGaps` (upright lines only), and
 * each of its cells reads as the whole line's text.
 */
export interface CharsOf {
    /** A line's characters; undefined when unknown. */
    chars(l: RegionLine): LineChars | undefined;
    /**
     * The extent of a line's one cell when `segments` provably does not cut it at
     * `minGap` (no gap between its inked characters is that wide) and the cell's
     * text is the line's, told without reading its characters; undefined when not
     * known so (an upright page line of one piece with an `inkSpan` and narrower
     * `gaps`).
     */
    uncut(l: RegionLine, minGap: number): readonly [number, number] | undefined;
}

export interface GridGroup {
    bbox: Rect;
    lines: RegionLine[];
    /**
     * The box with the rows past the block's own cells that it left out (`ownRows`),
     * when it left any: a candidate that repeats it so repeats the grid.
     */
    reach?: Rect;
    /**
     * What the grid proposes when not all of it (`gridGroups`): nothing, or the rows
     * short of the page's running headers and footers. A candidate that repeats the
     * grid as found (`bbox`, `reach`) still repeats it, and takes these lines only.
     */
    proposes?: { bbox: Rect; lines: RegionLine[] } | null;
}

/** What a grid candidate looks like, for the region features (`rowStructure`). */
export interface GridShape {
    /** Rows of the lines (baseline bands). */
    rows: number;
    /** Gutters with text on both sides on at least `MIN_ROWS` rows. */
    gutters: number;
    /** Share of rows with text in two or more columns. */
    multiRows: number;
    /** Share of rows the emptiest column holds text on (1 without a gutter). */
    sparseOccupancy: number;
    /** Share of the emptiest column's rows that have text in another column too. */
    anchored: number;
    /** Share of row transitions that are bands of space between rows crossing every column. */
    breaks: number;
}

/**
 * A cell of a line. Its text and words are read on first use: most cells never
 * reach the tests that read them.
 */
class Segment {
    private cellText?: string;
    private cellWords?: number;

    constructor(
        readonly x0: number,
        readonly x1: number,
        readonly line: RegionLine,
        /** Caption or figure text: it cuts gutters, but borders none and joins no grid. */
        readonly blocker: boolean,
        /** The cell's own text: from its characters, or a line that is one cell. */
        public exact: boolean,
        /**
         * The cell's characters, `chars[a]` to `chars[b - 1]`; absent when they are its
         * line's text (a line `CharsOf.uncut` leaves whole) or unknown.
         */
        private readonly chars?: readonly LineChar[],
        private readonly a = 0,
        private readonly b = 0,
    ) {}

    /** The cell's text: its characters joined, or its line's. */
    get text(): string {
        if (this.cellText === undefined) {
            if (!this.chars) {
                this.cellText = this.line.text;
            } else {
                let text = "";
                for (let i = this.a; i < this.b; i++) text += this.chars[i].c;
                this.cellText = text.trim();
            }
        }
        return this.cellText;
    }

    /** The cell's words: of its text, or its line's. */
    get words(): number {
        this.cellWords ??= this.chars ? wordCounts(this.text).words : this.line.words;
        return this.cellWords;
    }
}

/** How a row's lines are cut into cells. */
interface CellSource {
    blockers: ReadonlySet<RegionLine>;
    charsOf?: CharsOf;
}

/** Lines sharing a baseline band. Its lines are cut into cells on first use (`segs`). */
class Row {
    readonly lines: RegionLine[] = [];
    private cells?: Segment[];

    constructor(
        public y0: number,
        public y1: number,
        /** Typical line height of the row. */
        readonly h: number,
        public em: number,
        /** The row holds a caption: a table's top or bottom, which no gutter crosses. */
        public caption: boolean,
        private readonly source: CellSource,
    ) {}

    /** The cells of the row's lines, left to right. */
    get segs(): Segment[] {
        if (!this.cells) {
            const cells: Segment[] = [];
            for (const l of this.lines) cells.push(...segments(l, Math.max(1, l.size), this.source.blockers.has(l), this.source.charsOf));
            this.cells = cells.sort((a, b) => a.x0 - b.x0);
        }
        return this.cells;
    }

    /**
     * Whether two cells of the row may border a gap (`freeIntervals`): false only
     * when at most one of its cells is not a blocker. Told without cutting its lines
     * when they are not cut yet: a blocker's line has no such cell, and a line
     * `oneCell` vouches for has one.
     */
    mayBorder(): boolean {
        if (this.cells) return this.cells.filter((s) => !s.blocker).length >= 2;
        let cells = 0;
        for (const l of this.lines) {
            if (this.source.blockers.has(l)) continue;
            cells += oneCell(l, Math.max(1, l.size), this.source.charsOf) ? 1 : 2;
            if (cells >= 2) return true;
        }
        return false;
    }
}

interface Chain {
    x0: number;
    x1: number;
    /** Row indexes where text stands on both sides of it. */
    bordered: number[];
    last: number;
}

/** Lines in rows (sharing most of their height), top to bottom; each row's segments left to right. */
function buildRows(lines: readonly RegionLine[], blockers: ReadonlySet<RegionLine>, captions: ReadonlySet<RegionLine>, charsOf?: CharsOf): Row[] {
    const sorted = [...lines].sort((a, b) => a.bbox[1] + a.bbox[3] - (b.bbox[1] + b.bbox[3]));
    const source: CellSource = { blockers, charsOf };
    const rows: Row[] = [];
    for (const l of sorted) {
        const h = l.bbox[3] - l.bbox[1];
        const cy = (l.bbox[1] + l.bbox[3]) / 2;
        let row: Row | undefined;
        for (let k = rows.length - 1; k >= 0 && k >= rows.length - 3; k--) {
            const r = rows[k];
            const overlap = Math.min(r.y1, l.bbox[3]) - Math.max(r.y0, l.bbox[1]);
            if (cy >= r.y0 && cy <= r.y1 && overlap >= 0.5 * Math.min(h, r.h)) {
                row = r;
                break;
            }
        }
        const em = Math.max(1, l.size);
        if (row) {
            row.y0 = Math.min(row.y0, l.bbox[1]);
            row.y1 = Math.max(row.y1, l.bbox[3]);
            row.em = Math.max(row.em, em);
            row.caption ||= captions.has(l);
        } else {
            row = new Row(l.bbox[1], l.bbox[3], h, em, captions.has(l), source);
            rows.push(row);
        }
        row.lines.push(l);
    }
    return rows;
}

/**
 * Whether `segments` provably makes one cell of a line (at `em`), told without its
 * characters: `CharsOf.uncut` vouches for it, or, without characters, none of its
 * `wideGaps` (where alone it is then cut) is `GUTTER_EM` wide.
 */
function oneCell(l: RegionLine, em: number, charsOf?: CharsOf): boolean {
    if (charsOf) return !!charsOf.uncut(l, GUTTER_EM * em);
    return wideGaps(l).every(([g0, g1]) => g1 - g0 < GUTTER_EM * em);
}

/** A line's extent cut at gaps of at least `GUTTER_EM` between its inked characters (cells MuPDF set on one line). */
function segments(l: RegionLine, em: number, blocker: boolean, charsOf?: CharsOf): Segment[] {
    const uncut = charsOf?.uncut(l, GUTTER_EM * em);
    if (uncut) return [new Segment(uncut[0], uncut[1], l, blocker, true)];
    const known = charsOf?.chars(l);
    if (known && known.end > known.start) {
        const { chars, end } = known;
        const out: Segment[] = [];
        // The current cell: its first character (spaces before its first inked one
        // included), its inked extent, and whether its text is more than spaces.
        let first = known.start;
        let left = Infinity;
        let right = -Infinity;
        let text = false;
        for (let i = first; i < end; i++) {
            const ch = chars[i];
            if (isSpaceChar(ch.c)) {
                // A space stays in the cell; a "character" of several code points may
                // hold more than one.
                if (ch.c.length > 1 && ch.c.trim()) text = true;
                continue;
            }
            if (right !== -Infinity && ch.bbox.l - right >= GUTTER_EM * em) {
                if (text) out.push(new Segment(left, right, l, blocker, true, chars, first, i));
                first = i;
                left = Infinity;
                right = -Infinity;
                text = false;
            }
            if (ch.c) text = true;
            left = Math.min(left, ch.bbox.l);
            right = Math.max(right, ch.bbox.r);
        }
        if (text) out.push(new Segment(left, right, l, blocker, true, chars, first, end));
        if (out.length) return out;
    }
    const out: Segment[] = [];
    let x0 = l.bbox[0];
    const cut = (x1: number) => out.push(new Segment(x0, x1, l, blocker, false));
    for (const [g0, g1] of wideGaps(l)) {
        if (g1 - g0 < GUTTER_EM * em || g0 <= x0 || g1 >= l.bbox[2]) continue;
        cut(g0);
        x0 = g1;
    }
    cut(l.bbox[2]);
    if (out.length === 1) out[0].exact = true;
    return out;
}

/** Free x-intervals of a row (between and beside its segments), and whether text borders each on both sides. */
function freeIntervals(row: Row): { x0: number; x1: number; bordered: boolean }[] {
    const out: { x0: number; x1: number; bordered: boolean }[] = [];
    let edge = -Infinity;
    let left: Segment | undefined;
    for (const s of row.segs) {
        if (s.x0 > edge) out.push({ x0: edge, x1: s.x0, bordered: !!left && !left.blocker && !s.blocker });
        if (s.x1 > edge) {
            edge = s.x1;
            left = s;
        }
    }
    out.push({ x0: edge, x1: Infinity, bordered: false });
    return out;
}

/**
 * Gutters: strips free of text from row to row, narrowing to what stays free,
 * broken by a line across them, a caption's row or a gap of more than `ROW_GAP`
 * line heights.
 */
function findChains(rows: readonly Row[]): Chain[] {
    const done: Chain[] = [];
    let active: Chain[] = [];
    rows.forEach((row, r) => {
        if (row.caption) {
            done.push(...active);
            active = [];
            return;
        }
        // With no gutter running, a row starts one only at a gap that two of its cells
        // border; one that cannot need not be cut into cells.
        if (!active.length && !row.mayBorder()) return;
        const free = freeIntervals(row);
        const gmin = GUTTER_EM * row.em;
        const next: Chain[] = [];
        for (const c of active) {
            const prev = rows[c.last];
            if (row.y0 - prev.y1 > ROW_GAP * Math.max(prev.h, row.h)) {
                done.push(c);
                continue;
            }
            let best: (typeof free)[number] | undefined;
            let bestOverlap = 0;
            for (const f of free) {
                const o = Math.min(f.x1, c.x1) - Math.max(f.x0, c.x0);
                if (o > bestOverlap) {
                    best = f;
                    bestOverlap = o;
                }
            }
            if (!best || bestOverlap < gmin) {
                done.push(c);
                continue;
            }
            c.x0 = Math.max(c.x0, best.x0);
            c.x1 = Math.min(c.x1, best.x1);
            c.last = r;
            if (best.bordered) c.bordered.push(r);
            next.push(c);
        }
        // A gap between cells that no running gutter passes through starts one.
        for (const f of free) {
            if (!f.bordered || f.x1 - f.x0 < gmin) continue;
            if (next.some((c) => c.last === r && Math.min(f.x1, c.x1) - Math.max(f.x0, c.x0) >= gmin)) continue;
            next.push({ x0: f.x0, x1: f.x1, bordered: [r], last: r });
        }
        // Two gutters narrowed into one strip are one: the one bordered on more rows.
        active = [];
        for (const c of next) {
            const twin = active.findIndex((o) => Math.abs(o.x0 - c.x0) < 0.5 && Math.abs(o.x1 - c.x1) < 0.5);
            if (twin < 0) active.push(c);
            else if (c.bordered.length > active[twin].bordered.length) active[twin] = c;
        }
    });
    done.push(...active);
    return done.filter((c) => c.bordered.length >= MIN_ROWS);
}

/**
 * Column cuts of gutters, left to right: one per strip, at its centre. Gutters
 * whose strips overlap are one, broken off at different rows (by a header
 * spanning the columns, or a gap).
 */
function cutsOf(chains: readonly Chain[]): number[] {
    const strips: [number, number][] = [];
    for (const c of [...chains].sort((a, b) => a.x0 - b.x0)) {
        const last = strips[strips.length - 1];
        if (last && c.x0 < last[1]) {
            last[0] = Math.max(last[0], c.x0);
            last[1] = Math.min(last[1], c.x1);
        } else {
            strips.push([c.x0, c.x1]);
        }
    }
    return strips.map(([x0, x1]) => (x0 + x1) / 2);
}

/** Per column, which rows hold text, from the segments within [x0, x1] cut at `cuts` (gutter centres). */
function columnRows(rows: readonly Row[], first: number, last: number, cuts: readonly number[], x0: number, x1: number): Segment[][][] {
    const columns: Segment[][][] = Array.from({ length: cuts.length + 1 }, () => []);
    for (let r = first; r <= last; r++) {
        const perColumn: Segment[][] = Array.from({ length: cuts.length + 1 }, () => []);
        for (const s of rows[r].segs) {
            if (s.blocker) continue;
            const cx = (s.x0 + s.x1) / 2;
            if (cx < x0 || cx > x1) continue;
            let k = 0;
            while (k < cuts.length && cx > cuts[k]) k++;
            perColumn[k].push(s);
        }
        perColumn.forEach((segs, k) => columns[k].push(segs));
    }
    return columns;
}

/** Row structure of a block (rows `first`..`last`, columns cut at `cuts`, within [x0, x1]). */
function blockShape(
    rows: readonly Row[],
    first: number,
    last: number,
    cuts: readonly number[],
    x0: number,
    x1: number,
): Omit<GridShape, "gutters"> & { columns: Segment[][][]; occupied: boolean[][] } {
    const columns = columnRows(rows, first, last, cuts, x0, x1);
    const n = last - first + 1;
    const occupied = columns.map((col) => col.map((segs) => segs.length > 0));
    const textRows = Array.from({ length: n }, (_, i) => occupied.some((col) => col[i]));
    const rowsWithText = textRows.filter(Boolean).length;
    const multi = Array.from({ length: n }, (_, i) => occupied.filter((col) => col[i]).length >= 2).filter(Boolean).length;
    let sparseOccupancy = 1;
    let anchored = 0;
    if (cuts.length) {
        // The emptiest column (the first of equals).
        const counts = occupied.map((col) => col.filter(Boolean).length);
        const k = counts.indexOf(Math.min(...counts));
        sparseOccupancy = rowsWithText ? counts[k] / rowsWithText : 0;
        const beside = occupied[k].filter((v, i) => v && occupied.some((o, j) => j !== k && o[i])).length;
        anchored = counts[k] ? beside / counts[k] : 0;
    }
    return {
        rows: rowsWithText,
        multiRows: rowsWithText ? multi / rowsWithText : 0,
        sparseOccupancy,
        anchored,
        breaks: breakShare(rows, first, textRows),
        columns,
        occupied,
    };
}

/**
 * Share of the transitions between rows that hold text (`textRows`, from row
 * `first`) that are bands of space wider than `BREAK_GAP` line heights.
 */
function breakShare(rows: readonly Row[], first: number, textRows: readonly boolean[]): number {
    let transitions = 0;
    let breaks = 0;
    let prev = -1;
    for (let i = 0; i < textRows.length; i++) {
        if (!textRows[i]) continue;
        if (prev >= 0) {
            transitions++;
            const a = rows[first + prev];
            const b = rows[first + i];
            if (b.y0 - a.y1 > BREAK_GAP * Math.min(a.h, b.h)) breaks++;
        }
        prev = i;
    }
    return transitions ? breaks / transitions : 0;
}

/**
 * Row structure of a set of lines (a candidate's): its rows, gutters and how its
 * columns fill its rows. Lines set at an angle or rotated are left out.
 */
export function rowStructure(lines: readonly RegionLine[], charsOf?: CharsOf): GridShape {
    const upright = lines.filter((l) => !l.rot && !l.skewed && l.inkChars > 0);
    if (!upright.length) return { rows: 0, gutters: 0, multiRows: 0, sparseOccupancy: 1, anchored: 0, breaks: 0 };
    const rows = buildRows(upright, new Set(), new Set(), charsOf);
    const cuts = cutsOf(findChains(rows));
    if (!cuts.length) {
        // One column holding every row: each line has a cell and there are no blockers,
        // so the shape follows from the rows alone (as `blockShape` would give it).
        return { rows: rows.length, gutters: 0, multiRows: 0, sparseOccupancy: 1, anchored: 0, breaks: breakShare(rows, 0, rows.map(() => true)) };
    }
    const shape = blockShape(rows, 0, rows.length - 1, cuts, -Infinity, Infinity);
    return {
        rows: shape.rows,
        gutters: cuts.length,
        multiRows: shape.multiRows,
        sparseOccupancy: shape.sparseOccupancy,
        anchored: shape.anchored,
        breaks: shape.breaks,
    };
}

/**
 * Grid candidates among upright `lines` (in a reading frame). `blockers`
 * (captions, figure text) cut gutters and never join, and a caption's row ends
 * every gutter (`captions`); `running` marks running text; `prims` give the
 * rules a block may extend over; `charsOf` gives the cells of a line; `margin`
 * holds the page's furniture (running heads and feet), which no block takes;
 * `stops` the running heads and feet a grid's rows end at (`rowsWithin`).
 * Grids that list entries (`entryList`) propose nothing (`GridGroup.proposes`).
 */
export function gridGroups(
    lines: readonly RegionLine[],
    blockers: ReadonlySet<RegionLine>,
    captions: ReadonlySet<RegionLine>,
    running: ReadonlySet<RegionLine>,
    prims: readonly Primitive[],
    bs: number,
    charsOf?: CharsOf,
    margin?: ReadonlySet<RegionLine>,
    stops?: ReadonlySet<RegionLine>,
): GridGroup[] {
    const upright = lines.filter((l) => !l.rot && !l.skewed && l.inkChars > 0);
    if (upright.length < MIN_ROWS) return [];
    const rows = buildRows(upright, blockers, captions, charsOf);
    // Longest gutters first: a gutter inside a grid found already is one of its own.
    const chains = findChains(rows).sort((a, b) => b.bordered.length - a.bordered.length);
    if (!chains.length) return [];
    const hrules = prims.filter((p) => p.kind === "hrule").map((p) => p.bbox);
    const layout = layoutGutters(chains, rows, running);
    const out: GridGroup[] = [];
    const blocks: { first: number; last: number; x0: number; x1: number }[] = [];
    // Lines of the grids that list entries (`entryList`).
    const listed = new Set<RegionLine>();
    for (const chain of chains) {
        let first = chain.bordered[0];
        // The last row's cell may wrap on below the last row bordered on both sides: the
        // rows the gutter runs on through, stacked at line spacing, are its lines.
        let last = chain.bordered[chain.bordered.length - 1];
        while (last < chain.last && rows[last + 1].y0 - rows[last].y1 <= BREAK_GAP * Math.min(rows[last].h, rows[last + 1].h)) last++;
        const own = chain.bordered.length;
        const mid = (chain.x0 + chain.x1) / 2;
        const covered = (b: (typeof blocks)[number]) =>
            mid > b.x0 && mid < b.x1 && chain.bordered.filter((r) => r >= b.first && r <= b.last).length >= CONTAINED * own;
        if (blocks.some(covered)) continue;
        // Gutters over the same rows, left and right. The nearest gutter between the
        // page's text columns on each side bounds the block; one bordered on most of
        // its rows is another gutter of the grid.
        const within = (c: Chain) => c.bordered.filter((r) => r >= first && r <= last).length;
        let x0 = -Infinity;
        let x1 = Infinity;
        for (const c of layout) {
            if (within(c) === 0) continue;
            if (c.x1 <= chain.x0) x0 = Math.max(x0, c.x1);
            else if (c.x0 >= chain.x1) x1 = Math.min(x1, c.x0);
        }
        const inner: Chain[] = [chain];
        for (const c of chains) {
            if (c === chain || layout.has(c) || c.x0 < x0 || c.x1 > x1) continue;
            if (within(c) >= INNER_SHARE * own) inner.push(c);
        }
        const cuts = cutsOf(inner);
        let shape = blockShape(rows, first, last, cuts, x0, x1);
        // An outer column of justified running text on nearly every row that runs on
        // above or below the grid is a text column of the page beside it, not one of its
        // columns, when the grid has columns enough without it. (A table's column of
        // justified descriptions ends with the table.)
        const prose = (k: number) =>
            shape.occupied[k].filter(Boolean).length >= PROSE_OCCUPANCY * Math.max(1, shape.rows) &&
            proseColumn(shape.columns[k], running) &&
            runsOn(shape.columns[k], rows, first, last, running);
        while (cuts.length >= 2 && (prose(0) || prose(cuts.length))) {
            if (prose(0)) x0 = cuts.shift()!;
            else x1 = cuts.pop()!;
            shape = blockShape(rows, first, last, cuts, x0, x1);
        }
        // A gutter between the page's text columns proposes a grid only with rows set
        // apart twice over: cells starting together and rules between the rows (a table
        // of two wide columns of justified text). Paragraphs of two text columns may
        // start together by chance.
        const accepts = (shape: ReturnType<typeof blockShape>, first: number, last: number): boolean =>
            layout.has(chain)
                ? alignedStarts(shape.occupied, rows, first) && rowRules(shape, rows, first, last, hrules) >= MIN_ROW_RULES &&
                  evidence(shape, cuts.length, running, rows, first, last, hrules)
                : evidence(shape, cuts.length, running, rows, first, last, hrules);
        if (!accepts(shape, first, last)) continue;
        const [start, end] = ownRows(rows, chain, first, last, cuts, x0, x1, running, margin);
        let reach: Rect | undefined;
        if (start > first || end < last) {
            reach = extendOverRules(cellSpan(shape.columns.flat(2)), prims, bs);
            [first, last] = [start, end];
            shape = blockShape(rows, first, last, cuts, x0, x1);
        }
        const grid = gridLines(rows, first, last, shape);
        if (!grid) continue;
        const span = cellSpan(grid.cells);
        blocks.push({ first, last, x0: span[0], x1: span[2] });
        const bbox = extendOverRules(span, prims, bs);
        if (out.some((g) => iou(g.bbox, bbox) >= DUPLICATE_IOU)) continue;
        const group: GridGroup = { bbox, lines: grid.members, ...(reach ? { reach } : {}) };
        out.push(group);
        // A grid is found as above whatever it then proposes, so that every other grid and
        // candidate is found as without these tests: a grid holding running headers or footers
        // proposes only the rows short of them, and a list of entries nothing. The list test
        // reads those rows: a running head's page number over a table's column is no page.
        const [top, bottom] = rowsWithin(rows, first, last, grid.cells, cuts, stops);
        const whole = top === first && bottom === last;
        const cut = whole ? shape : top <= bottom ? blockShape(rows, top, bottom, cuts, x0, x1) : undefined;
        const rest = whole ? grid : cut && accepts(cut, top, bottom) ? gridLines(rows, top, bottom, cut) : undefined;
        if (cut && rest && !tableCaptioned(rows, top, bottom, captions) && entryList(cut)) {
            group.proposes = null;
            for (const l of rest.members) listed.add(l);
            continue;
        }
        if (!whole) group.proposes = rest ? { bbox: extendOverRules(cellSpan(rest.cells), prims, bs), lines: rest.members } : null;
    }
    // Nor does a grid holding any of a list's lines.
    if (listed.size) {
        for (const g of out) if (g.proposes !== null && (g.proposes ?? g).lines.some((l) => listed.has(l))) g.proposes = null;
    }
    return out;
}

/**
 * The cells and lines of a block's rows `first`..`last` (of `shape`): at least two
 * cells on each of `MIN_ROWS` rows, however MuPDF set them in lines, and the lines
 * whose every cell is in the block. A line that also holds text the block left out
 * (prose beside it, set on one structured-text line) stays out, since taking the line
 * would take that text too. Undefined when too few.
 */
function gridLines(rows: readonly Row[], first: number, last: number, shape: ReturnType<typeof blockShape>): { cells: Segment[]; members: RegionLine[] } | undefined {
    const cells = shape.columns.flat(2);
    if (cells.length < MIN_ROWS * 2) return undefined;
    const kept = new Set(cells);
    const partly = new Set<RegionLine>();
    for (let r = first; r <= last; r++) for (const s of rows[r].segs) if (!kept.has(s)) partly.add(s.line);
    const members = [...new Set(cells.map((s) => s.line))].filter((l) => !partly.has(l));
    return members.length < MIN_ROWS ? undefined : { cells, members };
}

/**
 * The rows of a block (`first`..`last`, with `cells`, columns cut at `cuts`) short of
 * the page's running headers and footers: a row whose cells in the block include one
 * of `stops`, or are one line that says the table continues (`CONTINUED_RE`), ends the
 * block's rows on its side (the nearer end), itself included. They are page furniture,
 * not a row. A running head is a line or two of words, with at most one number alone
 * (its page number), set apart from the table. A row of stops is the table's own (its
 * header or column numbers set in the margin band, repeated on each page of a long
 * table) when it is more lines than `RUNNING_LINES` or cells than `RUNNING_CELLS`,
 * holds several cells without letters, sits at the table's line spacing from its
 * nearest row (`BREAK_GAP`), or, at most `HEADER_GAP` line heights from it, sets two
 * or more cells over the table's columns, each starting, ending or centred with a
 * cell of its column on another row, one of them inside the table's outer edges. A
 * running head stands further off, whatever its cells line up with. Rows are judged
 * from the table's body outward, each against the nearest row found to be the
 * table's, so a header of two rows is one.
 */
function rowsWithin(
    rows: readonly Row[],
    first: number,
    last: number,
    cells: readonly Segment[],
    cuts: readonly number[],
    stops?: ReadonlySet<RegionLine>,
): [number, number] {
    const kept = new Set(cells);
    const own = (r: number) => rows[r].segs.filter((s) => kept.has(s));
    const continued = (r: number) => {
        const segs = own(r);
        return segs.length === 1 && CONTINUED_RE.test(segs[0].line.text.trim());
    };
    const stopped = (r: number) => own(r).filter((s) => stops?.has(s.line));
    // Rows of stops that may be furniture, as their cells tell.
    const candidates = new Set<number>();
    for (let r = first; r <= last; r++) {
        const segs = stopped(r);
        if (!segs.length || segs.length > RUNNING_CELLS || new Set(segs.map((s) => s.line)).size > RUNNING_LINES) continue;
        if (segs.filter((s) => !/\p{L}/u.test(s.text)).length <= 1) candidates.add(r);
    }
    const column = (s: Segment) => {
        const cx = (s.x0 + s.x1) / 2;
        let k = 0;
        while (k < cuts.length && cx > cuts[k]) k++;
        return k;
    };
    // Candidates found to be the table's own rows, judged from the table's body outward.
    const accepted = new Set<number>();
    // The table's own row next to row `r` toward the block's body: the nearest with cells of the
    // block that says nothing of continuing and is no candidate, or one found to be the table's
    // (the header row below a second one).
    const neighbour = (r: number): number | undefined => {
        const step = r - first <= last - r ? 1 : -1;
        for (let q = r + step; q >= first && q <= last; q += step) {
            if (own(q).length && !continued(q) && (!candidates.has(q) || accepted.has(q))) return q;
        }
        return undefined;
    };
    const tableRow = (r: number): boolean => {
        const q = neighbour(r);
        if (q === undefined) return false;
        const [a, b] = q > r ? [rows[r], rows[q]] : [rows[q], rows[r]];
        const gap = (b.y0 - a.y1) / Math.min(a.h, b.h);
        if (gap <= BREAK_GAP) return true;
        const segs = stopped(r);
        if (segs.length < 2 || gap > HEADER_GAP) return false;
        const others = [...kept].filter((t) => !stops?.has(t.line) && ![...candidates].some((c) => rows[c].segs.includes(t)));
        // How a cell sits over its column: starting, ending or centred with one of its cells.
        // A running head starts at the table's left edge and its page number ends at the right
        // one; a header also meets a column inside (a start past the first, an end before the
        // last, or a centre).
        let inner = false;
        const fits = segs.every((s) => {
            const tol = WRAP_INDENT_EM * Math.max(1, s.line.size);
            const k = column(s);
            const column_ = others.filter((t) => column(t) === k);
            const starts = column_.some((t) => Math.abs(t.x0 - s.x0) <= tol);
            const ends = column_.some((t) => Math.abs(t.x1 - s.x1) <= tol);
            const centred = column_.some((t) => Math.abs(t.x0 + t.x1 - s.x0 - s.x1) <= 2 * tol);
            if ((starts && k > 0) || (ends && k < cuts.length) || (centred && !starts && !ends)) inner = true;
            return starts || ends || centred;
        });
        return fits && inner;
    };
    // From the body outward on each side: the first row of furniture ends the block there.
    const furniture = (r: number): boolean => {
        if (continued(r)) return true;
        if (!candidates.has(r)) return false;
        if (!tableRow(r)) return true;
        accepted.add(r);
        return false;
    };
    let [top, bottom] = [first, last];
    const middle = (first + last) / 2;
    for (let r = Math.floor(middle); r >= first; r--) {
        if (furniture(r)) {
            top = r + 1;
            break;
        }
    }
    for (let r = Math.floor(middle) + 1; r <= last; r++) {
        if (furniture(r)) {
            bottom = r - 1;
            break;
        }
    }
    return [top, bottom];
}

/**
 * Whether a table's caption ("Table 1. Sample size by method") stands over or under a
 * block (rows `first`..`last`): its caption rows run on from the row next to the block,
 * at most `ROW_GAP` line heights apart, and one of them is a table caption's. A list of
 * tables has entries that read as captions too, but each leads to its page number
 * (`pageEntry`).
 */
function tableCaptioned(rows: readonly Row[], first: number, last: number, captions: ReadonlySet<RegionLine>): boolean {
    for (const [from, step] of [
        [first, -1],
        [last, 1],
    ] as const) {
        for (let r = from + step, prev = from; r >= 0 && r < rows.length && rows[r].caption; prev = r, r += step) {
            const [a, b] = step < 0 ? [rows[r], rows[prev]] : [rows[prev], rows[r]];
            if (b.y0 - a.y1 > ROW_GAP * Math.max(a.h, b.h)) break;
            if (rows[r].lines.some((l) => captions.has(l) && isTableCaption(l.text)) && !pageEntry(rows[r])) return true;
        }
    }
    return false;
}

/**
 * Whether a row is an entry of a list of tables or figures: dot leaders, or a page
 * number set apart from the title as a cell of its own at the row's end (a number
 * within the title, "in Experiment 2", is none).
 */
function pageEntry(row: Row): boolean {
    if (row.lines.some((l) => LEADERS_RE.test(l.text))) return true;
    const segs = row.segs;
    const end = segs[segs.length - 1];
    return segs.length >= 2 && end.exact && pageRef(end.text.trim()) !== null;
}

/** The box of cells: their extents across, their lines' down. */
function cellSpan(cells: readonly Segment[]): Rect {
    let span: Rect = [cells[0].x0, cells[0].line.bbox[1], cells[0].x1, cells[0].line.bbox[3]];
    for (const s of cells) span = unionRect(span, [s.x0, s.line.bbox[1], s.x1, s.line.bbox[3]]);
    return span;
}

/**
 * The block's rows (of `first`..`last`) from the first to the last row its own
 * cells border, and the rows after them that join as a cell's wrapped lines
 * (`wraps`). Its own cells are text of the block (within [x0, x1]) on both sides
 * of the gutter `chain`: the page's other text column beyond a bound borders the
 * gutter too, and so, below the first row, does a line of prose whose word spaces
 * are as wide as a gutter. A row without text of the block neither joins nor
 * stops the wrapped lines. A block whose cells border none of its rows keeps them
 * all.
 */
function ownRows(
    rows: readonly Row[],
    chain: Chain,
    first: number,
    last: number,
    cuts: readonly number[],
    x0: number,
    x1: number,
    running: ReadonlySet<RegionLine>,
    margin?: ReadonlySet<RegionLine>,
): [number, number] {
    const inBlock = (s: Segment) => (s.x0 + s.x1) / 2 >= x0 && (s.x0 + s.x1) / 2 <= x1;
    // Whether the block's cells border the gutter on row `r`; below its first row, not
    // both from one line of running text cut into more cells than the block has
    // columns: prose with wide word spaces (a header MuPDF set on one line is cells).
    const own = (r: number, prose: boolean): boolean => {
        let left: Segment | undefined;
        let right: Segment | undefined;
        for (const s of rows[r].segs) {
            if (s.x1 <= chain.x0 + 0.5 && (!left || s.x1 > left.x1)) left = s;
            if (s.x0 >= chain.x1 - 0.5 && (!right || s.x0 < right.x0)) right = s;
        }
        if (!left || !right || left.blocker || right.blocker || !inBlock(left) || !inBlock(right)) return false;
        if (prose || left.line !== right.line || !running.has(left.line)) return true;
        return rows[r].segs.filter((s) => s.line === left.line && inBlock(s)).length <= cuts.length + 1;
    };
    const start = chain.bordered.find((r) => own(r, true));
    if (start === undefined) return [first, last];
    let end = start;
    for (const r of chain.bordered) if (r > end && own(r, false)) end = r;
    if (end === last) return [start, end];
    const column = (s: Segment) => {
        const cx = (s.x0 + s.x1) / 2;
        let k = 0;
        while (k < cuts.length && cx > cuts[k]) k++;
        return k;
    };
    // The columns' cells as far as the block's rows go; the style of the cells of the
    // rows the block's cells border.
    const columns = new Map<number, BlockColumn>();
    const cells: Segment[] = [];
    const record = (r: number) => {
        const added = new Set<number>();
        for (const s of rows[r].segs) {
            if (s.blocker || !inBlock(s)) continue;
            const k = column(s);
            let c = columns.get(k);
            if (!c) columns.set(k, (c = { above: [], left: s.x0, right: s.x1 }));
            if (!added.has(k)) c.above = [];
            added.add(k);
            c.above.push(s);
            c.left = Math.min(c.left, s.x0);
            c.right = Math.max(c.right, s.x1);
        }
    };
    for (let r = start; r <= end; r++) {
        record(r);
        for (const s of rows[r].segs) if (!s.blocker && inBlock(s)) cells.push(s);
    }
    const style = cellStyle(cells, column);
    for (let r = end + 1, prev = end; r <= last; r++) {
        const segs = rows[r].segs.filter(inBlock);
        if (!segs.length) continue;
        const lines = rows[prev].segs.filter((s) => !s.blocker && inBlock(s));
        if (!wraps(lines, segs, columns, column, style, margin)) break;
        record(r);
        end = prev = r;
    }
    return [start, end];
}

/** A column of a block as far as its rows go, for the wrapped lines of its cells. */
interface BlockColumn {
    /** Its cells on the last row with text in it. */
    above: Segment[];
    /** The extent of its cells. */
    left: number;
    right: number;
}

/** What a block's cells look like, for telling a heading below it. */
interface CellStyle {
    /** Per column, the type size of its cells (`inkSize`) at the median. */
    size: Map<number, number>;
    /** Share of cells set bold. */
    bold: number;
    /** Share of cells opening like a numbered heading. */
    numbered: number;
}

function cellStyle(cells: readonly Segment[], column: (s: Segment) => number): CellStyle {
    const sizes = new Map<number, number[]>();
    for (const s of cells) sizes.set(column(s), [...(sizes.get(column(s)) ?? []), inkSize(s)]);
    const size = new Map([...sizes].map(([k, v]) => [k, v.sort((a, b) => a - b)[Math.floor(v.length / 2)]]));
    const share = (test: (s: Segment) => boolean) => (cells.length ? cells.filter(test).length / cells.length : 0);
    return {
        size,
        bold: share((s) => isBoldFont(s.line.font ?? "", undefined)),
        numbered: share((s) => NUMBERED_HEADING_RE.test(s.text)),
    };
}

const inkSize = (s: Segment) => s.line.inkSize ?? s.line.size;

/**
 * Whether the cells `segs` of a row are wrapped lines of cells above them: set at
 * the line spacing of the row above (`prev`, the block's cells on it), each in its
 * column and clear of the cells of the columns beside it, under a cell it
 * continues: starting no further left than `WRAP_INDENT_EM` beyond the column's
 * cells, or centred or right-aligned with the column's cell on the last row with
 * text there. A line that starts something else is none: a note
 * (`NOTE_CAPTION_RE`, a marker, a list of abbreviations), page furniture
 * (`margin`), or a heading (larger than its column's cells, bold, or short and
 * numbered, unlike the cells). A line of prose after the block crosses its
 * columns.
 */
function wraps(
    prev: readonly Segment[],
    segs: readonly Segment[],
    columns: ReadonlyMap<number, BlockColumn>,
    column: (s: Segment) => number,
    style: CellStyle,
    margin?: ReadonlySet<RegionLine>,
): boolean {
    if (!prev.length || segs.some((s) => s.blocker)) return false;
    const height = (s: Segment) => s.line.bbox[3] - s.line.bbox[1];
    const top = Math.min(...segs.map((s) => s.line.bbox[1]));
    const bottom = Math.max(...prev.map((s) => s.line.bbox[3]));
    if (top - bottom > BREAK_GAP * Math.min(Math.max(...segs.map(height)), Math.max(...prev.map(height)))) return false;
    return segs.every((s) => {
        const k = column(s);
        const own = columns.get(k);
        if (!own || s.x0 < (columns.get(k - 1)?.right ?? -Infinity) || s.x1 > (columns.get(k + 1)?.left ?? Infinity)) return false;
        const text = s.text;
        if (margin?.has(s.line) || NOTE_CAPTION_RE.test(text) || NOTE_MARKER_RE.test(text) || ABBREVIATIONS_RE.test(text)) return false;
        if (inkSize(s) >= (style.size.get(k) ?? Infinity) + HEADING_SIZE) return false;
        if (style.bold < 0.5 && isBoldFont(s.line.font ?? "", undefined)) return false;
        if (style.numbered < 0.5 && NUMBERED_HEADING_RE.test(text) && s.words <= HEADING_WORDS) return false;
        const tol = WRAP_INDENT_EM * Math.max(1, s.line.size);
        if (s.x0 >= own.left - tol) return true;
        return own.above.some((t) => Math.abs(s.x0 + s.x1 - t.x0 - t.x1) <= 2 * tol || Math.abs(s.x1 - t.x1) <= tol);
    });
}

/**
 * A column's text runs on past the block (rows `first`..`last`): the nearest row
 * above or below it, at most `ROW_GAP` line heights away, holds running text
 * within the column's span and at least half its width.
 */
function runsOn(column: readonly Segment[][], rows: readonly Row[], first: number, last: number, running: ReadonlySet<RegionLine>): boolean {
    const segs = column.flat();
    if (!segs.length) return false;
    const left = Math.min(...segs.map((s) => s.x0));
    const right = Math.max(...segs.map((s) => s.x1));
    const tolerance = Math.max(1, ...segs.map((s) => s.line.size));
    const near = (r: number, edge: number) =>
        r >= 0 && r < rows.length && !rows[r].caption && Math.abs(r < edge ? rows[edge].y0 - rows[r].y1 : rows[r].y0 - rows[edge].y1) <= ROW_GAP * Math.max(rows[r].h, rows[edge].h);
    return [
        [first - 1, first],
        [last + 1, last],
    ].some(
        ([r, edge]) =>
            near(r, edge) &&
            rows[r].segs.some(
                (s) => running.has(s.line) && s.x0 >= left - tolerance && s.x1 <= right + tolerance && s.x1 - s.x0 >= 0.5 * (right - left),
            ),
    );
}

/**
 * Gutters between text columns of the page (`layoutGutter`), and the gutters
 * above or below one in its strip with nothing set across the strip between
 * them: the page's gutter through a table set in each column, broken off by
 * the tables' notes.
 */
function layoutGutters(chains: readonly Chain[], rows: readonly Row[], running: ReadonlySet<RegionLine>): Set<Chain> {
    const layout = new Set(chains.filter((c) => layoutGutter(c, rows, running)));
    const crossed = (a: Chain, b: Chain) => {
        const x0 = Math.max(a.x0, b.x0);
        const x1 = Math.min(a.x1, b.x1);
        if (x1 - x0 < 1) return true;
        const [upper, lower] = a.last < b.bordered[0] ? [a, b] : [b, a];
        for (let r = upper.last + 1; r < lower.bordered[0]; r++) {
            if (rows[r].segs.some((s) => s.x0 < x1 - 0.5 && s.x1 > x0 + 0.5)) return true;
        }
        return false;
    };
    for (let grown = true; grown; ) {
        grown = false;
        for (const c of chains) {
            if (layout.has(c)) continue;
            const apart = (l: Chain) => l.last < c.bordered[0] || c.last < l.bordered[0];
            if ([...layout].some((l) => apart(l) && !crossed(l, c))) {
                layout.add(c);
                grown = true;
            }
        }
    }
    return layout;
}

/**
 * A gutter between text columns of the page: on at least `LAYOUT_ROWS` of its
 * rows, running text stands on both sides, justified on each (`proseColumn`) and
 * as wide as a page's text column (`LAYOUT_COLUMN_EM`). Such a gutter may run on
 * through tables set in the columns, or between them.
 */
function layoutGutter(c: Chain, rows: readonly Row[], running: ReadonlySet<RegionLine>): boolean {
    const left: Segment[][] = [];
    const right: Segment[][] = [];
    for (const r of c.bordered) {
        let l: Segment | undefined;
        let rt: Segment | undefined;
        for (const s of rows[r].segs) {
            if (s.x1 <= c.x0 + 0.5 && (!l || s.x1 > l.x1)) l = s;
            if (s.x0 >= c.x1 - 0.5 && (!rt || s.x0 < rt.x0)) rt = s;
        }
        if (!l || !rt || !running.has(l.line) || !running.has(rt.line)) continue;
        left.push([l]);
        right.push([rt]);
    }
    const wide = (side: Segment[][]) => {
        const ems = side.map(([s]) => (s.x1 - s.x0) / Math.max(1, s.line.size)).sort((a, b) => a - b);
        return ems[Math.floor(ems.length / 2)] >= LAYOUT_COLUMN_EM;
    };
    return left.length >= LAYOUT_ROWS && wide(left) && wide(right) && proseColumn(left, running) && proseColumn(right, running);
}

/** Whether a block shows rows read across its columns (see the module comment). */
function evidence(
    shape: ReturnType<typeof blockShape>,
    gutters: number,
    running: ReadonlySet<RegionLine>,
    rows: readonly Row[],
    first: number,
    last: number,
    hrules: readonly Rect[],
): boolean {
    if (gutters < 1) return false;
    const multi = Math.round(shape.multiRows * shape.rows);
    if (multi < MIN_MULTI_ROWS) return false;
    // A first column of markers: a numbered or bulleted list (references, items).
    const markers = shape.columns[0].flat();
    if (markers.length && markers.filter((s) => LIST_MARKER_RE.test(segmentLead(s))).length >= LIST_MARKERS * markers.length) return false;
    // Cells that start on one row in several columns.
    if (alignedStarts(shape.occupied, rows, first)) return true;
    // Rules between rows.
    if (rowRules(shape, rows, first, last, hrules) >= MIN_ROW_RULES) return true;
    const segs = shape.columns.flat(2);
    // Without either, two or more columns of justified running text are the page's text columns.
    if (shape.columns.filter((col) => proseColumn(col, running)).length >= 2) return false;
    // A label column beside wrapped cells.
    if (shape.sparseOccupancy <= SPARSE_OCCUPANCY && shape.anchored >= ANCHORED && labelColumn(shape.occupied, shape.columns)) return true;
    // Cells that are not running text, side by side.
    return runningShare(segs, running) <= SHORT_CELLS_RUNNING && shape.multiRows >= SHORT_CELLS_ROWS;
}

/**
 * A segment's text as far as list markers go: its own, or, without its line's
 * characters, for the first of several segments of one line (a marker MuPDF set
 * on its item's line), the line's first word.
 */
function segmentLead(s: Segment): string {
    const text = s.text.trim();
    return !s.exact && s.x0 <= s.line.bbox[0] + 0.5 ? text.split(/\s+/u)[0] : text;
}

/** Rules between a block's first and last rows spanning at least `ROW_RULE_SPAN` of its text's width. */
function rowRules(shape: ReturnType<typeof blockShape>, rows: readonly Row[], first: number, last: number, hrules: readonly Rect[]): number {
    const segs = shape.columns.flat(2);
    if (!segs.length) return 0;
    const left = Math.min(...segs.map((s) => s.x0));
    const right = Math.max(...segs.map((s) => s.x1));
    const top = rows[first].y1;
    const bottom = rows[last].y0;
    return hrules.filter((r) => r[1] > top && r[3] < bottom && Math.min(r[2], right) - Math.max(r[0], left) >= ROW_RULE_SPAN * (right - left)).length;
}

function runningShare(segs: readonly Segment[], running: ReadonlySet<RegionLine>): number {
    return segs.length ? segs.filter((s) => running.has(s.line)).length / segs.length : 1;
}

/**
 * Whether a block lists entries with the pages they are on (a table of contents, a
 * list of tables or figures, an author index, a list of notes) rather than rows of
 * a table. It does when:
 * - its first or last column holds page numbers (`parsePageNumber`: "17", "p. 17",
 *   "xii") in at least `PAGE_CELLS` of its cells, `ENTRY_PAGES` or more, under no
 *   header other than "Page", not each one more than the last (rows numbered
 *   1, 2, 3), and at least `DISTINCT_PAGES` of them distinct;
 * - every other column holds words (titles, names, headings) or the numbers of
 *   headings in order ("4", "9.3", "A.1"), with at most `ENTRY_VALUE_CELLS` of its
 *   cells anything else, and one holds words;
 * - and the entries are set out as a list: the pages increase down the block, or a
 *   column of names is in alphabetical order, whole names compared (an index), or dot leaders lead to the
 *   pages on at least `LEADER_ROWS` of its rows.
 * A table whose last column holds small integers has a header row over it, or a
 * second column of values (other numbers than headings'), or values that do not
 * increase down the block, beside cells that are not in alphabetical order.
 */
function entryList(shape: ReturnType<typeof blockShape>): boolean {
    const columns = shape.columns;
    if (columns.length < 2) return false;
    const n = columns[0]?.length ?? 0;
    // A column's cells top to bottom (its text on a row, without leaders) and its rows with
    // leaders, read on first use: most tables fail on their outer columns' first cells,
    // before the text of their other cells is read.
    const read: { cells: string[]; leaders: number[] }[] = [];
    const column = (k: number) => {
        if (!read[k]) {
            const cells: string[] = [];
            const leaders: number[] = [];
            for (let i = 0; i < n; i++) {
                if (!columns[k][i].length) continue;
                const [cell, leader] = cellText(columns[k][i]);
                if (leader) leaders.push(i);
                if (cell) cells.push(cell);
            }
            read[k] = { cells, leaders };
        }
        return read[k];
    };
    for (const p of new Set([columns.length - 1, 0])) {
        if (!leadsWithPage(columns[p], n)) continue;
        const cells = column(p).cells;
        const entries = pageRef(cells[0]) === null ? cells.slice(1) : cells;
        const numbers = entries.map(pageRef).filter((v): v is number => v !== null);
        if (numbers.length < ENTRY_PAGES || numbers.length < PAGE_CELLS * entries.length || numbers.every((v) => v >= 1000)) continue;
        // Numbers that each step by one number the rows (1, 2, 3); a few values repeated
        // (all 0, all 12) are a table's. Neither refers to pages.
        if (numbers.every((v, i) => i === 0 || v === numbers[i - 1] + 1)) continue;
        const distinct = new Set(numbers).size;
        if (distinct < ENTRY_PAGES || distinct < DISTINCT_PAGES * numbers.length) continue;
        const others = columns.flatMap((_, k) => (k !== p && column(k).cells.length ? [column(k).cells] : []));
        if (!others.every(entryColumn) || !others.some((c) => c.filter(isWords).length >= ENTRY_PAGES)) continue;
        // Names in order: whole labels, so that a first word they share ("The") orders nothing.
        const named = others.some((c) => {
            const keys = c.filter(isWords).map((t) => t.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim());
            return new Set(keys).size >= NAMED_ENTRIES && orderedShare(keys, (a, b) => a.localeCompare(b)) >= ENTRIES_ORDERED;
        });
        const textRows = Array.from({ length: n }, (_, i) => columns.some((c) => c[i].length)).filter(Boolean).length;
        const leaderRows = new Set(columns.flatMap((_, k) => column(k).leaders)).size;
        if (orderedShare(numbers, (a, b) => a - b) >= ENTRIES_ORDERED || named || leaderRows >= LEADER_ROWS * textRows) return true;
    }
    return false;
}

/** A cell's text on a row (its segments'), without leaders, and whether it had any. */
function cellText(segs: readonly Segment[]): [string, boolean] {
    const raw = segs.map((s) => s.text).join(" ");
    const cell = raw.replace(LEADER_RE, " ").trim();
    return [cell, cell !== raw.trim()];
}

/**
 * Whether a column's first cell with text is a page number, or its head ("Page") over
 * one: no header of a table's column of values above it, nor under its first number.
 */
function leadsWithPage(column: readonly Segment[][], n: number): boolean {
    let headed = false;
    let page = false;
    for (let i = 0; i < n; i++) {
        if (!column[i].length) continue;
        const [cell] = cellText(column[i]);
        if (!cell) continue;
        const ref = pageRef(cell) !== null;
        // A header under the first number ("12" then "N") is a table's, the number above it a
        // running head's page number that joined its rows.
        if (page) return ref || PAGE_HEADER_RE.test(cell);
        if (ref) page = true;
        else if (headed || !PAGE_HEADER_RE.test(cell)) return false;
        else headed = true;
    }
    return page;
}

/** The page a cell of a column of page numbers refers to, or null (an Arabic or lowercase Roman number). */
function pageRef(text: string): number | null {
    return /\d/u.test(text) || /^[ivxlc]+$/u.test(text) ? parsePageNumber(text) : null;
}

/** A cell of words: two or more letters, at least half its characters. */
function isWords(text: string): boolean {
    const letters = (text.match(/\p{L}/gu) ?? []).length;
    return letters >= 2 && letters >= 0.5 * text.replace(/\s/gu, "").length;
}

/** A column of a list's entries beside its pages: words, or heading numbers in order. */
function entryColumn(cells: readonly string[]): boolean {
    const numbered = cells.filter((t) => !isWords(t) && SECTION_NUMBER_RE.test(t));
    if (cells.length - numbered.length - cells.filter(isWords).length > ENTRY_VALUE_CELLS * cells.length) return false;
    return numbered.length < 2 || orderedShare(numbered.map(sectionKey), compareSections) >= ENTRIES_ORDERED;
}

/** A heading number's parts, in order: numbers, Roman numerals, letters after them. */
function sectionKey(text: string): number[] {
    const roman: Record<string, number> = { I: 1, V: 5, X: 10, L: 50 };
    return text
        .replace(/\.$/u, "")
        .split(".")
        .map((part) => {
            if (/^\d+$/u.test(part)) return Number(part);
            if (/^[IVXL]+$/u.test(part)) {
                let total = 0;
                for (let i = 0; i < part.length; i++) total += roman[part[i]] < (roman[part[i + 1]] ?? 0) ? -roman[part[i]] : roman[part[i]];
                return total;
            }
            return 1000 + part.charCodeAt(0);
        });
}

function compareSections(a: readonly number[], b: readonly number[]): number {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
}

/** Share of neighbouring values in order (equal ones included). */
function orderedShare<T>(values: readonly T[], compare: (a: T, b: T) => number): number {
    let up = 0;
    for (let i = 1; i < values.length; i++) if (compare(values[i - 1], values[i]) <= 0) up++;
    return values.length > 1 ? up / (values.length - 1) : 0;
}

/**
 * The sparsest column holds labels: short lines in short runs of rows, with
 * rows of other columns between them (each label beside the first lines of a
 * wrapped cell). A text column interrupted by a figure runs on for many rows;
 * one of short paragraphs under headings has lines of many words. (Running
 * text is no test: a label beside running text is read as running text too.)
 */
function labelColumn(occupied: readonly boolean[][], columns: readonly Segment[][][]): boolean {
    let k = 0;
    occupied.forEach((col, j) => {
        if (col.filter(Boolean).length < occupied[k].filter(Boolean).length) k = j;
    });
    const words = columns[k].flat().map((s) => s.words).sort((a, b) => a - b);
    if (!words.length || words[Math.floor(words.length / 2)] > LABEL_WORDS) return false;
    const sparsest = occupied[k];
    const runs: number[] = [];
    for (let i = 0; i < sparsest.length; i++) {
        if (!sparsest[i]) continue;
        if (i === 0 || !sparsest[i - 1]) runs.push(0);
        runs[runs.length - 1]++;
    }
    if (runs.length < LABEL_RUNS) return false;
    runs.sort((a, b) => a - b);
    return runs[Math.floor(runs.length / 2)] <= LABEL_RUN_ROWS;
}

/**
 * A column of justified running text: most of its segments are running text,
 * and most of its lines of words end at its right edge.
 */
function proseColumn(column: readonly Segment[][], running: ReadonlySet<RegionLine>): boolean {
    const segs = column.flat();
    if (!segs.length || runningShare(segs, running) < PROSE_RUNNING) return false;
    const wordy = segs.filter((s) => s.words >= JUSTIFY_WORDS);
    if (!wordy.length) return false;
    // The edge most lines end at: ragged text has none.
    const ends = wordy.map((s) => s.x1).sort((a, b) => a - b);
    const tolerance = JUSTIFY_EM * Math.max(1, ...wordy.map((s) => s.line.size));
    let flush = 0;
    for (let i = 0, j = 0; i < ends.length; i++) {
        while (ends[i] - ends[j] > tolerance) j++;
        flush = Math.max(flush, i - j + 1);
    }
    return flush >= JUSTIFIED_LINES * wordy.length;
}

/**
 * Cells start together: on at least `MIN_ALIGNED_STARTS` rows past the first,
 * two or more columns start a block of text (after an empty row or a band of
 * space in that column), and such rows are at least `ALIGNED_STARTS_SHARE` of
 * the rows where any column starts one. The paragraphs of text columns set side
 * by side start where each column's text happens to break.
 */
function alignedStarts(occupied: readonly boolean[][], rows: readonly Row[], first: number): boolean {
    const n = occupied[0]?.length ?? 0;
    const lastText = occupied.map(() => -1);
    let firstText = -1;
    let aligned = 0;
    let any = 0;
    for (let i = 0; i < n; i++) {
        let starts = 0;
        occupied.forEach((col, k) => {
            if (!col[i]) return;
            const prev = lastText[k];
            const a = prev >= 0 ? rows[first + prev] : undefined;
            const b = rows[first + i];
            if (prev < 0 || prev < i - 1 || b.y0 - a!.y1 > BREAK_GAP * Math.min(a!.h, b.h)) starts++;
            lastText[k] = i;
        });
        if (firstText < 0) {
            if (occupied.some((col) => col[i])) firstText = i;
            continue;
        }
        if (starts > 0) any++;
        if (starts >= 2) aligned++;
    }
    return aligned >= MIN_ALIGNED_STARTS && aligned >= ALIGNED_STARTS_SHARE * any;
}
