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
 */
import { iou, unionRect, type Rect } from "./geometry";
import { wideGaps, wordCounts, type Primitive, type RegionLine } from "./pageSignals";
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

/** A character of a line: its extent along the line's row (in its reading frame) and the character. */
export interface LineChar {
    x0: number;
    x1: number;
    c: string;
}

/**
 * A line's characters, left to right in its reading frame, from its structured-text
 * line (`FindCandidatesOptions.sources`); undefined when unknown. Cells MuPDF set on
 * one line meet at the gaps between them, and each cell has its own text. Without
 * them a line splits at its `wideGaps` (upright lines only), and each of its cells
 * reads as the whole line's text.
 */
export type CharsOf = (l: RegionLine) => readonly LineChar[] | undefined;

export interface GridGroup {
    bbox: Rect;
    lines: RegionLine[];
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

interface Segment {
    x0: number;
    x1: number;
    line: RegionLine;
    /** Caption or figure text: it cuts gutters, but borders none and joins no grid. */
    blocker: boolean;
    /** The cell's text and words; the whole line's when its characters are unknown (`exact` false). */
    text: string;
    words: number;
    exact: boolean;
}

interface Row {
    y0: number;
    y1: number;
    /** Typical line height of the row. */
    h: number;
    em: number;
    segs: Segment[];
    /** The row holds a caption: a table's top or bottom, which no gutter crosses. */
    caption: boolean;
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
        const segs = segments(l, em, blockers.has(l), charsOf);
        if (row) {
            row.y0 = Math.min(row.y0, l.bbox[1]);
            row.y1 = Math.max(row.y1, l.bbox[3]);
            row.segs.push(...segs);
            row.em = Math.max(row.em, em);
            row.caption ||= captions.has(l);
        } else {
            rows.push({ y0: l.bbox[1], y1: l.bbox[3], h, em, segs, caption: captions.has(l) });
        }
    }
    for (const row of rows) row.segs.sort((a, b) => a.x0 - b.x0);
    return rows;
}

/** A line's extent cut at gaps of at least `GUTTER_EM` between its inked characters (cells MuPDF set on one line). */
function segments(l: RegionLine, em: number, blocker: boolean, charsOf?: CharsOf): Segment[] {
    const chars = charsOf?.(l);
    if (chars?.length) {
        const out: Segment[] = [];
        let cell: LineChar[] = [];
        let left = Infinity;
        let right = -Infinity;
        const close = () => {
            const text = cell.map((ch) => ch.c).join("").trim();
            if (text) out.push({ x0: left, x1: right, line: l, blocker, text, words: wordCounts(text).words, exact: true });
        };
        for (const ch of chars) {
            if (/\s/u.test(ch.c)) {
                cell.push(ch);
                continue;
            }
            if (right !== -Infinity && ch.x0 - right >= GUTTER_EM * em) {
                close();
                cell = [];
                left = Infinity;
                right = -Infinity;
            }
            cell.push(ch);
            left = Math.min(left, ch.x0);
            right = Math.max(right, ch.x1);
        }
        close();
        if (out.length) return out;
    }
    const out: Segment[] = [];
    let x0 = l.bbox[0];
    const cut = (x1: number) => out.push({ x0, x1, line: l, blocker, text: l.text, words: l.words, exact: false });
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
    // Bands of space between rows that hold text, wider than `BREAK_GAP` line heights.
    let transitions = 0;
    let breaks = 0;
    let prev = -1;
    for (let i = 0; i < n; i++) {
        if (!textRows[i]) continue;
        if (prev >= 0) {
            transitions++;
            const a = rows[first + prev];
            const b = rows[first + i];
            if (b.y0 - a.y1 > BREAK_GAP * Math.min(a.h, b.h)) breaks++;
        }
        prev = i;
    }
    return {
        rows: rowsWithText,
        multiRows: rowsWithText ? multi / rowsWithText : 0,
        sparseOccupancy,
        anchored,
        breaks: transitions ? breaks / transitions : 0,
        columns,
        occupied,
    };
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
 * rules a block may extend over; `charsOf` gives the cells of a line.
 */
export function gridGroups(
    lines: readonly RegionLine[],
    blockers: ReadonlySet<RegionLine>,
    captions: ReadonlySet<RegionLine>,
    running: ReadonlySet<RegionLine>,
    prims: readonly Primitive[],
    bs: number,
    charsOf?: CharsOf,
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
    for (const chain of chains) {
        const first = chain.bordered[0];
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
        const accepted = layout.has(chain)
            ? alignedStarts(shape.occupied, rows, first) && rowRules(shape, rows, first, last, hrules) >= MIN_ROW_RULES &&
              evidence(shape, cuts.length, running, rows, first, last, hrules)
            : evidence(shape, cuts.length, running, rows, first, last, hrules);
        if (!accepted) continue;
        // At least two cells on each of `MIN_ROWS` rows, however MuPDF set them in lines.
        const cells = shape.columns.flat(2);
        if (cells.length < MIN_ROWS * 2) continue;
        // The grid's lines: those whose every cell is in it. A line that also holds text
        // the grid left out (prose beside it, set on one structured-text line) stays out,
        // since taking the line would take that text too. The box is the cells'.
        const kept = new Set(cells);
        const members = [...new Set(cells.map((s) => s.line))].filter((l) =>
            rows.slice(first, last + 1).every((row) => row.segs.every((s) => s.line !== l || kept.has(s))),
        );
        if (members.length < MIN_ROWS) continue;
        let span: Rect = [cells[0].x0, cells[0].line.bbox[1], cells[0].x1, cells[0].line.bbox[3]];
        for (const s of cells) span = unionRect(span, [s.x0, s.line.bbox[1], s.x1, s.line.bbox[3]]);
        blocks.push({ first, last, x0: span[0], x1: span[2] });
        const bbox = extendOverRules(span, prims, bs);
        if (!out.some((g) => iou(g.bbox, bbox) >= DUPLICATE_IOU)) out.push({ bbox, lines: members });
    }
    return out;
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
