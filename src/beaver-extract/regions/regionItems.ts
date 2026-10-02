/**
 * Region detection → document items (structured extraction, schema presets
 * with `regions`).
 *
 * Text lines routed to a table, figure or display equation leave the prose:
 * they are removed from the page before paragraph detection and become the
 * region item's text instead.
 * - table: one row per table row, cells joined by " | "; each row is a
 *   sentence. A cell's text wrapped over several lines is one cell, and the
 *   visual lines of one row are one row (`tableRows`). A row missing cells
 *   keeps an empty slot for each, so values stay under their column. A region
 *   that cannot be read as a table (`readsAsTable`: no column structure, or
 *   much of the text between its rows left in the prose) emits nothing and
 *   leaves its text in the prose.
 * - formula: the equation's rows; an equation number stays at the end of its row.
 * - picture: label rows, not sentences; rows of bare numbers (axis ticks) are
 *   dropped and the text is capped.
 * Decorations take no text, and running text and captions are not routed
 * (`routeLines`), so prose keeps its sentences; only lines on a table's rows
 * join the table whatever their flags. Skewed text spanning the page (a
 * diagonal watermark) leaves the layout as margin text: it would otherwise cut
 * across the page's columns.
 *
 * Routing works on the detector's visual lines, which split structured-text
 * lines at wide gaps and join word fragments. A structured-text line goes
 * wherever most of its characters are routed, so no text is duplicated or lost.
 */
import type {
    BoundingBox,
    DocItem,
    ItemLine,
    RawBlockDetailed,
    RawLine,
    RawLineDetailed,
    RawPageDataDetailed,
    SentenceItem,
} from "@beaver/agent-core/extract/types";

import { decideLineBreakHyphen } from "../ParagraphSentenceMapper";
import { rotateBBox, type RotationAngle } from "../PageRotationNormalizer";
import type { Rect } from "./geometry";
import type { RegionClass } from "./model";
import { sourceLines, type RegionLine } from "./pageSignals";
import { LINE_CAPTION, LINE_FURNITURE, LINE_SKEWED, type LineRouting, type RegionDetection } from "./RegionDetector";

export type RegionItemKind = "table" | "picture" | "formula";

/** A region item before it is placed in the page's reading order. */
export interface RegionItemDraft {
    kind: RegionItemKind;
    /** Index of the detected region (`RegionDetection.candidates`) the item comes from. */
    region: number;
    /** The region's box, grown to cover the text it absorbed. */
    bbox: BoundingBox;
    /** Rows in reading order; each row's cells left to right. */
    rows: RegionCell[][];
    /** Table column count, when rows were aligned to columns. */
    columns?: number;
}

export interface RegionCell {
    text: string;
    bbox: BoundingBox;
    /** Table column of the cell; set on every cell of an aligned row. */
    column?: number;
}

export interface PageRegionItems {
    /** The page without the lines regions absorbed or set aside (the input page when none are). */
    page: RawPageDataDetailed;
    items: RegionItemDraft[];
    /** Page furniture set aside as margin text (`LINE_FURNITURE`), in page order. */
    margin: RawLine[];
}

const ITEM_KINDS: ReadonlySet<RegionClass> = new Set<RegionClass>(["table", "picture", "formula"]);

/** A formula line with this many ordinary words is prose around the equation. */
export const FORMULA_PROSE_WORDS = 5;
/** Figure label text beyond this many characters is cut. */
export const PICTURE_TEXT_MAX_CHARS = 2000;
/** Figure text of numbers and number punctuation alone: axis ticks, scales, data values. */
const NUMERIC_TEXT_RE = /^[\s\p{N}.,:;%+\-−–—()[\]/×·^*$€£]*$/u;

/**
 * Items for the regions of one page and the page without the lines they
 * absorb. `detection` must come from `detectRegions(page, …, { route: true })`
 * with a model; a scanned page gets no regions.
 */
export function regionItemsForPage(
    page: RawPageDataDetailed,
    detection: RegionDetection,
    vocabulary?: ReadonlySet<string>,
): PageRegionItems {
    const routing = detection.routing;
    const regions = detection.candidates;
    const kept = regions.map((r) => r.label !== undefined && r.label !== "other");
    if (!routing || detection.scanned) return { page, items: [], margin: [] };
    const numbered = sourceLines(page);
    const furniture = new Set<RawLine>();
    routing.lines.forEach((line, i) => {
        if (!(routing.flags[i] & LINE_FURNITURE)) return;
        for (const piece of line.parts ?? [line]) {
            const source = numbered[piece.source - 1];
            if (source) furniture.add(source);
        }
    });
    const margin = numbered.filter((l) => furniture.has(l));
    if (!kept.some((k, i) => k && regions[i].label !== "decoration")) {
        return { page: withoutLines(page, furniture), items: [], margin };
    }

    // Each piece with the region its visual line is routed to.
    const pieces: { piece: RegionLine; line: number; route: number }[] = [];
    routing.lines.forEach((line, i) => {
        let route = routing.routes[i];
        if (route >= 0 && regions[route].label === "formula" && line.alphaWords >= FORMULA_PROSE_WORDS) route = -1;
        // Decorations take no text (`routeLines` never routes to one); nothing is deleted.
        if (route >= 0 && regions[route].label === "decoration") route = -1;
        for (const piece of line.parts ?? [line]) pieces.push({ piece, line: i, route });
    });

    // A structured-text line goes where most of its characters go; a tie,
    // with prose or between regions, keeps it in prose.
    const votes = new Map<number, Map<number, number>>();
    for (const { piece, route } of pieces) {
        const bySource = votes.get(piece.source) ?? new Map<number, number>();
        bySource.set(route, (bySource.get(route) ?? 0) + Math.max(1, piece.inkChars));
        votes.set(piece.source, bySource);
    }
    const destination = new Map<number, number>();
    for (const [source, bySource] of votes) {
        let best = -1;
        let bestInk = bySource.get(-1) ?? 0;
        for (const [route, ink] of bySource) {
            if (route < 0) continue;
            if (ink > bestInk) {
                best = route;
                bestInk = ink;
            } else if (ink === bestInk) {
                best = -1;
            }
        }
        if (best >= 0) destination.set(source, best);
    }
    // Cells: the pieces of one visual line that end up in the same region.
    const cellsByRegion = new Map<number, Cell[]>();
    const byLine = new Map<string, RegionLine[]>();
    for (const { piece, line } of pieces) {
        const region = destination.get(piece.source);
        if (region === undefined) continue;
        const key = `${region}:${line}`;
        const list = byLine.get(key) ?? [];
        list.push(piece);
        byLine.set(key, list);
    }
    for (const [key, parts] of byLine) {
        const region = Number(key.slice(0, key.indexOf(":")));
        const rect = parts.reduce<Rect>(
            (u, p) => [Math.min(u[0], p.bbox[0]), Math.min(u[1], p.bbox[1]), Math.max(u[2], p.bbox[2]), Math.max(u[3], p.bbox[3])],
            [Infinity, Infinity, -Infinity, -Infinity],
        );
        const rot = readingRotation(parts[0]);
        parts.sort((a, b) => readingFrame(a.bbox, rot)[0] - readingFrame(b.bbox, rot)[0]);
        const cells = cellsByRegion.get(region) ?? [];
        const lead = firstWordWidth(parts[0], numbered[parts[0].source - 1]);
        const size = Math.max(...parts.map((p) => p.size));
        const text = parts.map((p) => p.text).join(" ");
        const cell: Cell = { rect, text, rot, size, ...(lead !== undefined ? { lead } : {}) };
        if (regions[region].label === "picture") {
            const numbers = figureNumbers(cell, parts, numbered);
            if (numbers) cell.numbers = numbers;
        }
        cells.push(cell);
        cellsByRegion.set(region, cells);
    }

    // Where each visual line ends up: the region holding its text, or -1 for prose.
    const lineDestination = routing.lines.map((line) => {
        for (const piece of line.parts ?? [line]) {
            const d = destination.get(piece.source);
            if (d !== undefined) return d;
        }
        return -1;
    });

    const items: RegionItemDraft[] = [];
    regions.forEach((region, k) => {
        if (!kept[k] || !ITEM_KINDS.has(region.label!)) return;
        const kind = region.label as RegionItemKind;
        const framed = groupRows(cellsByRegion.get(k) ?? []);
        const table = kind === "table" ? tableRows(framed, routing.rules ?? [], routing.verticalRules ?? [], vocabulary) : undefined;
        if (table && table.rows.length && !readsAsTable(table, tableLeak(k, routing, lineDestination, table))) {
            // Not a table to read row by row: its text stays in the prose.
            for (const [source, d] of destination) if (d === k) destination.delete(source);
            return;
        }
        // A figure keeps its labels and data values; only axis ticks are dropped.
        const ticks = kind === "picture" ? axisTicks(cellsByRegion.get(k) ?? []) : undefined;
        let rows =
            table?.rows ??
            framed
                .map((row) => row.filter(({ cell }) => !ticks?.has(cell)).map(({ cell }) => ({ text: cell.text, bbox: toBBox(cell.rect) })))
                .filter((row) => row.length > 0);
        if (kind === "picture") rows = pictureRows(rows);
        // Whole structured-text lines are absorbed, so text can reach past the region.
        const bbox = rows.flat().reduce((u, c) => unionBBox(u, c.bbox), toBBox(region.bbox));
        items.push({ kind, region: k, bbox, rows, ...(table?.columns ? { columns: table.columns } : {}) });
    });

    const absorbed = new Set<RawLine>(furniture);
    for (const source of destination.keys()) {
        const line = numbered[source - 1];
        if (line) absorbed.add(line);
    }
    return { page: withoutLines(page, absorbed), items, margin };
}

type ReadingRotation = 0 | 90 | 180 | 270;

interface Cell {
    rect: Rect;
    text: string;
    rot: ReadingRotation;
    /** Width of the first word along the line, from its character boxes. */
    lead?: number;
    /** Font size of the line. */
    size: number;
    /** A figure cell of numbers alone: each number's value and centre. */
    numbers?: FigureNumber[];
}

/** Width of `piece`'s first word along its line, when its source line has character boxes. */
function firstWordWidth(piece: RegionLine, source: RawLine | undefined): number | undefined {
    const chars = (source as RawLineDetailed | undefined)?.chars;
    if (!chars || chars.length !== source!.text.length) return undefined;
    let i = piece.range[0];
    const end = Math.min(piece.range[1], chars.length);
    while (i < end && /\s/.test(chars[i].c)) i++;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = i; j < end && !/\s/.test(chars[j].c); j++) {
        const b = chars[j].bbox;
        lo = Math.min(lo, piece.rot ? b.t : b.l);
        hi = Math.max(hi, piece.rot ? b.b : b.r);
    }
    return hi > lo ? hi - lo : undefined;
}

/** The direction a line reads in: vertical, upside down, or upright. */
function readingRotation(line: RegionLine): ReadingRotation {
    return line.turned ? 180 : line.rot;
}

/**
 * `r` in a frame where text of rotation `rot` reads left to right and top to
 * bottom. Only for ordering: the frame is mirrored, not translated.
 */
function readingFrame(r: Rect, rot: ReadingRotation): Rect {
    switch (rot) {
        case 90:
            return [r[1], -r[2], r[3], -r[0]];
        case 180:
            return [-r[2], -r[3], -r[0], -r[1]];
        case 270:
            return [-r[3], r[0], -r[1], r[2]];
        default:
            return r;
    }
}

/** A table needs this share of its rows to hold cells in two or more of its columns... */
export const TABLE_MIN_ALIGNED_ROWS = 0.2;
/** ...and may leave at most this share of the text between its rows in the prose. */
export const TABLE_MAX_LEAK = 0.3;
/** A column holds lines on at least this share of a table's visual lines to bound it. */
const COLUMN_MIN_ROWS = 0.1;
/** A table of one column is a list: at least this many rows, and almost nothing between them left out. */
const LIST_MIN_ROWS = 3;
const LIST_MAX_LEAK = 0.1;

/**
 * Whether a table's rows can be read as a table. Its text must not be split
 * with the prose: when much of the text between its rows stays out (cells set
 * as running text, the long lines of a code listing), the table holds a
 * fragment and the prose the rest, each out of order. And it must have column
 * structure: rows of cells under its columns, or one column of short rows (a
 * list). Code, a caption or reference list split at wide word gaps, and a
 * title alone have neither. A region that fails is no table; its text reads
 * best as prose.
 */
function readsAsTable(table: TableRows, leak: number): boolean {
    if (leak >= TABLE_MAX_LEAK) return false;
    if (!table.columns) return table.rows.every((row) => row.length === 1) && table.rows.length >= LIST_MIN_ROWS && leak < LIST_MAX_LEAK;
    const aligned = table.rows.filter((row) => row.length >= 2 && row.every((c) => c.column !== undefined)).length;
    return aligned >= TABLE_MIN_ALIGNED_ROWS * table.rows.length;
}

/**
 * Share of the text between a table's rows that stays in the prose: lines
 * with a line of the table both above and below them in their own horizontal
 * range, starting within the table's columns (its cells placed in a column),
 * captions aside; against the table's own text. A line the table took in from
 * beside it (a box reaching into the next text column) neither counts nor
 * frames the prose there.
 */
function tableLeak(k: number, routing: LineRouting, destination: readonly number[], table: TableRows): number {
    const rows = table.rows;
    const mine = routing.lines.flatMap((line, i) => (destination[i] === k ? [line] : []));
    if (mine.length === 0) return 0;
    const rotCounts = new Map<ReadingRotation, number>();
    for (const line of mine) rotCounts.set(readingRotation(line), (rotCounts.get(readingRotation(line)) ?? 0) + 1);
    const rot = [...rotCounts].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    // The columns' extent: cells in a column that runs down the table's lines
    // (not a stray line set beside a row or two), or every cell of a
    // one-column table or one without such a column.
    const minLines = Math.max(2, COLUMN_MIN_ROWS * table.lines);
    const cells = rows.flat();
    const inColumns = table.columns ? cells.filter((c) => c.column !== undefined && (table.columnLines.get(c.column) ?? 0) >= minLines) : cells;
    const placed = inColumns.length ? inColumns : cells;
    let left = Infinity;
    let right = -Infinity;
    for (const c of placed) {
        const f = readingFrame([c.bbox.l, c.bbox.t, c.bbox.r, c.bbox.b], rot);
        left = Math.min(left, f[0]);
        right = Math.max(right, f[2]);
    }
    const within = (f: Rect) => f[0] >= left - 1 && f[0] <= right;
    const boxes = mine.map((line) => readingFrame(line.bbox, rot)).filter(within);
    const own = mine.reduce((n, line) => n + line.inkChars, 0);
    let out = 0;
    routing.lines.forEach((line, i) => {
        if (destination[i] !== -1 || routing.flags[i] & (LINE_CAPTION | LINE_FURNITURE | LINE_SKEWED)) return;
        const f = readingFrame(line.bbox, rot);
        if (!within(f)) return;
        const cy = (f[1] + f[3]) / 2;
        let above = false;
        let below = false;
        for (const g of boxes) {
            if (Math.min(f[2], g[2]) <= Math.max(f[0], g[0])) continue;
            if (g[3] <= cy) above = true;
            if (g[1] >= cy) below = true;
        }
        if (above && below) out += line.inkChars;
    });
    return out / (out + own);
}

/** A cell with its box in the region's reading frame. */
interface FramedCell {
    cell: Cell;
    f: Rect;
}

/** The reading rotation of most cells: the frame a region's rows are read in. */
function dominantRotation(cells: readonly Cell[]): ReadingRotation {
    const rotCounts = new Map<ReadingRotation, number>();
    for (const c of cells) rotCounts.set(c.rot, (rotCounts.get(c.rot) ?? 0) + 1);
    return [...rotCounts].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

/**
 * Cells grouped into rows: cells sharing most of their height are one row,
 * rows top to bottom and cells left to right. Vertical and upside-down text is
 * grouped in its own reading frame.
 */
function groupRows(cells: Cell[]): FramedCell[][] {
    if (cells.length === 0) return [];
    const rot = dominantRotation(cells);
    const framed = cells.map((c) => ({ cell: c, f: readingFrame(c.rect, rot) }));
    framed.sort((a, b) => a.f[1] + a.f[3] - (b.f[1] + b.f[3]) || a.f[0] - b.f[0]);
    const rows: { top: number; bottom: number; cells: FramedCell[] }[] = [];
    for (const item of framed) {
        const h = item.f[3] - item.f[1];
        const row = rows[rows.length - 1];
        if (row) {
            const overlap = Math.min(row.bottom, item.f[3]) - Math.max(row.top, item.f[1]);
            if (overlap >= 0.5 * Math.min(h, row.bottom - row.top)) {
                row.cells.push(item);
                row.top = Math.min(row.top, item.f[1]);
                row.bottom = Math.max(row.bottom, item.f[3]);
                continue;
            }
        }
        rows.push({ top: item.f[1], bottom: item.f[3], cells: [item] });
    }
    return rows.map((row) => row.cells.sort((a, b) => a.f[0] - b.f[0]));
}

/** Rows of several cells that must align to a column structure for it to stand. */
const ALIGNED_ROWS = 0.5;
/** Neighbouring pieces of a row overlapping by more than this share of the narrower one are stacked, not side by side. */
const STACK_OVERLAP = 0.5;

/**
 * Each cell's table column. Columns span the cells of the rows with the most
 * cells; another row is aligned when each of its cells overlaps exactly one
 * column and they keep their order. Other rows (a header spanning columns, a
 * cell in a gutter) stay unaligned (`undefined`). A row whose pieces are
 * stacked over each other (a label set in two short lines) sets no columns.
 * When most rows of several cells do not align, the rows with the most cells
 * are no column structure (a line whose justified word gaps split it into
 * pieces), and rows with fewer cells that line up with each other set the
 * columns; failing that, the rows
 * with the most cells do, and few rows align (`readsAsTable`). A table whose
 * rows hold one cell each is one column; one whose rows never set
 * side-by-side columns has none (`columns` 1, nothing aligned).
 */
function assignColumns(rows: FramedCell[][]): { columns: number; of: (number | undefined)[][] } {
    const counts = [...new Set(rows.map((row) => row.length))].sort((a, b) => b - a);
    if ((counts[0] ?? 0) <= 1) return { columns: counts[0] ?? 0, of: rows.map((row) => row.map(() => 0)) };
    const multi = rows.filter((row) => row.length >= 2).length;
    let first: { columns: number; of: (number | undefined)[][] } | undefined;
    for (const columns of counts) {
        if (columns < 2) break;
        const of = alignToColumns(rows, columns, columns < counts[0]);
        if (!of) continue;
        first ??= { columns, of };
        const aligned = rows.filter((row, i) => row.length >= 2 && of[i].every((j) => j !== undefined)).length;
        if (aligned >= ALIGNED_ROWS * multi) return { columns, of };
    }
    return first ?? { columns: 1, of: rows.map((row) => row.map(() => undefined)) };
}

/**
 * Each cell's column among the spans of the rows with exactly `columns` cells
 * whose cells stand side by side (see `assignColumns`) and, when `agreeing`,
 * line up with each other; `undefined` when no such row sets them (each one
 * holds pieces stacked over each other).
 */
function alignToColumns(rows: FramedCell[][], columns: number, agreeing: boolean): (number | undefined)[][] | undefined {
    const sideBySide = (row: FramedCell[]) =>
        row.every(({ f }, j) => j === 0 || f[0] - row[j - 1].f[2] > -STACK_OVERLAP * Math.min(f[2] - f[0], row[j - 1].f[2] - row[j - 1].f[0]));
    const candidates = rows.filter((row) => row.length === columns && sideBySide(row));
    if (candidates.length === 0) return undefined;
    // Rows with fewer cells than the most only set columns where they agree:
    // cell by cell they overlap (set flush left, centred or flush right),
    // around the row most others agree with. Rows each missing a different
    // value would otherwise merge distinct columns.
    const agree = (a: FramedCell[], b: FramedCell[]) => a.every(({ f }, j) => Math.min(f[2], b[j].f[2]) > Math.max(f[0], b[j].f[0]));
    const partners = agreeing ? candidates.map((a) => candidates.filter((b) => agree(a, b)).length) : [];
    const anchor = agreeing ? candidates[partners.indexOf(Math.max(...partners))] : undefined;
    const setting = new Set(anchor ? candidates.filter((row) => agree(anchor, row)) : candidates);
    const spans = Array.from({ length: columns }, () => [Infinity, -Infinity]);
    for (const row of setting) {
        row.forEach(({ f }, j) => {
            spans[j][0] = Math.min(spans[j][0], f[0]);
            spans[j][1] = Math.max(spans[j][1], f[2]);
        });
    }
    return rows.map((row) => {
        if (setting.has(row)) return row.map((_, j) => j);
        const assigned = row.map(({ f }) => {
            const hits = spans.flatMap(([l, r], j) => (Math.min(r, f[2]) > Math.max(l, f[0]) ? [j] : []));
            return hits.length === 1 ? hits[0] : -1;
        });
        const ordered = assigned.every((j, i) => j >= 0 && (i === 0 || j > assigned[i - 1]));
        return row.map((_, i) => (ordered ? assigned[i] : undefined));
    });
}

/**
 * Lines of one cell follow each other at most this many type sizes apart (top
 * to top), or this much more than the table's leading: its tightest line
 * pitch within a column (`LEADING_QUANTILE`), counted only up to
 * `MAX_LEADING` type sizes (a table of one-line rows has no line spacing to
 * learn, only its row spacing).
 */
const WRAP_PITCH = 1.6;
const WRAP_LEADING = 1.25;
const LEADING_QUANTILE = 0.1;
const MAX_LEADING = 2;
/** A wrapped line starts this close (type sizes) to its cell's left edge or centre... */
const WRAP_ALIGN = 0.5;
/** ...or is indented by at most this many type sizes (a hanging indent). */
const WRAP_INDENT = 4;
/**
 * A line is full when the next word would end this close (type sizes) to the
 * column's right edge: cells are set a little narrower than their column.
 */
const WRAP_SLACK = 0.5;
/**
 * A line wraps only when it is full and holds this many words: shorter lines
 * fill a column fitted to them, as the items of a list do.
 */
const FULL_LINE_WORDS = 4;
/** In a column of flowing text (at least this many wraps of long lines), a full line of this many words wraps. */
const FLOWING_WRAPS = 2;
const FLOWING_LINE_WORDS = 2;
const SENTENCE_END_RE = /[.!?;:]["'”’)\]]*$/u;
/** A word space, in type sizes. */
const SPACE = 0.25;
/** Share of a column's longest lines that may run past its right edge. */
const RIGHT_EDGE_OUTLIERS = 0.1;
const WORD_RE = /\p{L}{2,}/u;

/**
 * The type size of two consecutive lines: their font size, unless it is far
 * from their box height (fonts scaled by the text matrix report wrong sizes).
 */
function lineUnit(a: FramedCell, b: FramedCell): number {
    const height = Math.min(a.f[3] - a.f[1], b.f[3] - b.f[1]);
    const size = Math.min(a.cell.size, b.cell.size);
    return size >= 0.5 * height && size <= 2 * height ? size : height;
}

/**
 * How a cell line relates to the line above it in its column, from sure
 * continuation to sure break (`continuation`).
 */
type Continuation = "continues" | "likely" | "maybe" | "starts" | "begins" | "breaks";

/**
 * How `next` relates to cell line `above`, the line before it in its column.
 * It "breaks" from it unless it sits tight under it, starts at its left edge
 * (or indented, or centred under it), and both hold words. Then it
 * "continues" a word broken at the line end, or a full line of running words
 * (the next word would not have fitted before `right`, the column's right
 * edge) when it starts in lower case; after a full line that ended a
 * sentence, a capital is "likely" the cell's next sentence. Any other lower-case start is "maybe":
 * a short line looks the same whether it wrapped or is one item of a list.
 * Any other start (a capital, a digit, a caseless script) "starts" a new
 * sentence or cell after a line that ended one, and otherwise "begins" a new
 * item: a list's entries end without a full stop.
 */
function continuation(above: FramedCell, next: FramedCell, right: number, leading: number, minWords = FULL_LINE_WORDS): Continuation {
    const a = above.f;
    const b = next.f;
    const unit = lineUnit(above, next);
    if (unit <= 0 || b[1] <= a[1] || b[1] - a[1] > Math.max(WRAP_PITCH, WRAP_LEADING * Math.min(leading / unit, MAX_LEADING)) * unit) return "breaks";
    const indent = b[0] - a[0];
    const centred = Math.abs((b[0] + b[2]) / 2 - (a[0] + a[2]) / 2) <= WRAP_ALIGN * unit;
    if (!centred && (indent < -WRAP_ALIGN * unit || indent > WRAP_INDENT * unit)) return "breaks";
    const upper = above.cell.text.trimEnd();
    const lower = next.cell.text.trimStart();
    if (!WORD_RE.test(upper) || !/\p{L}/u.test(lower)) return "breaks";
    if (/\p{L}-$/u.test(upper) && /^\p{L}/u.test(lower)) return "continues";
    const word = /^\S+/.exec(lower)?.[0] ?? lower;
    const wordWidth = next.cell.lead ?? ((b[2] - b[0]) * word.length) / Math.max(1, lower.length);
    const full = upper.split(/\s+/).length >= minWords && a[2] + SPACE * unit + wordWidth > right - WRAP_SLACK * unit;
    // The first letter, past opening quotes and brackets: lower case continues a sentence.
    const first = /^[\p{Ps}\p{Pi}"'*]*(\p{L})/u.exec(lower)?.[1];
    if (first && first !== first.toUpperCase()) return full ? "continues" : "maybe";
    if (!SENTENCE_END_RE.test(upper)) return "begins";
    return full ? "likely" : "starts";
}

/**
 * A visual row joins the row above when none of its cells breaks from the
 * line above it and its cells continue at least as often as they start anew:
 * a new row cannot start mid-sentence in one of its columns, while a cell's
 * next paragraph starts with a capital. A new item (a capital after a line
 * that did not end a sentence) and a new cell in the first column (the row
 * labels) always start a row; so does a new sentence there, unless another
 * cell of the line runs on from the line above. Lower-case lines that may continue the cells
 * above them join when the row is ragged — they fill fewer columns than the
 * line above and none in the first column, as cells of one row ending on
 * different lines do, unlike the one-line rows of a list — or when a lone
 * such line in the first column continues a label that did not end a
 * sentence (a label wrapped onto a line of its own). `kinds` holds each
 * cell's `Continuation`, `columns` its column, `ended` whether the line above
 * it ended a sentence, `above` the number of cells on the line above.
 */
function joinsRowAbove(
    kinds: readonly Continuation[],
    columns: readonly (number | undefined)[],
    ended: readonly boolean[],
    above: number,
    multi: boolean,
): boolean {
    if (kinds.includes("breaks") || kinds.includes("begins") || kinds.some((k, i) => k === "starts" && columns[i] === 0)) return false;
    const count = (kind: Continuation) => kinds.filter((k) => k === kind).length;
    // A new sentence in the first column starts a row unless another cell runs on mid-sentence.
    if (kinds.some((k, i) => k === "likely" && columns[i] === 0) && count("continues") === 0) return false;
    const starts = count("starts");
    if (count("continues") >= Math.max(1, starts) || (count("likely") > 0 && starts === 0)) return true;
    if (starts > 0 || !multi) return false;
    if (columns[0] !== 0) return kinds.length < above;
    return kinds.length === 1 && !ended[0];
}

/** A table's rows, with the visual lines they come from and how many of those hold each column. */
interface TableRows {
    rows: RegionCell[][];
    columns?: number;
    lines: number;
    columnLines: Map<number, number>;
}

/**
 * Table rows of whole cells. Visual lines are grouped into rows by height
 * (`groupRows`), and a cell's text may wrap over several of them: a visual
 * row whose cells continue the cells above them (`continuation`,
 * `joinsRowAbove`), with no rule drawn between them, joins the row above.
 * Each cell's lines become one text, words broken at a line end joined as in
 * prose (`decideLineBreakHyphen`). Each row's cells carry their column when
 * the table has at least two and the row aligns to them.
 */
function tableRows(
    framed: FramedCell[][],
    rules: readonly Rect[],
    verticalRules: readonly Rect[],
    vocabulary?: ReadonlySet<string>,
): TableRows {
    const { columns, of } = assignColumns(framed);
    // The column's right edge: where its lines end, ignoring the few that run
    // past it (a line squeezed wider, a cell reaching into the gutter).
    const ends = new Map<number, number[]>();
    framed.forEach((row, i) =>
        row.forEach(({ f }, k) => {
            const j = of[i][k];
            if (j !== undefined) ends.set(j, [...(ends.get(j) ?? []), f[2]]);
        }),
    );
    const right = new Map<number, number>();
    for (const [j, list] of ends) {
        list.sort((a, b) => b - a);
        right.set(j, list[Math.floor(RIGHT_EDGE_OUTLIERS * list.length)]);
    }
    // The table's leading: the pitch of consecutive lines in a column, at its tightest.
    const pitches: number[] = [];
    for (let i = 1; i < framed.length; i++) {
        framed[i].forEach((cell, k) => {
            const ka = of[i - 1].indexOf(of[i][k]);
            if (of[i][k] !== undefined && ka >= 0) pitches.push(cell.f[1] - framed[i - 1][ka].f[1]);
        });
    }
    pitches.sort((a, b) => a - b);
    const leading = pitches.length ? pitches[Math.floor(LEADING_QUANTILE * pitches.length)] : 0;
    // A column of flowing text (it wraps at least twice in a way a list cannot:
    // a broken word, or a full line of running words) wraps short lines too.
    const wraps = new Map<number, number>();
    for (let i = 1; i < framed.length; i++) {
        framed[i].forEach((cell, k) => {
            const j = of[i][k];
            const ka = j === undefined ? -1 : of[i - 1].indexOf(j);
            if (ka >= 0 && continuation(framed[i - 1][ka], cell, right.get(j!)!, leading) === "continues") {
                wraps.set(j!, (wraps.get(j!) ?? 0) + 1);
            }
        });
    }
    const minWords = (j: number) => ((wraps.get(j) ?? 0) >= FLOWING_WRAPS ? FLOWING_LINE_WORDS : FULL_LINE_WORDS);
    // Row separators in the cells' reading frame: the page's horizontal rules
    // for upright and upside-down tables, its vertical rules for sideways ones.
    // A rotated header or label among the cells does not change the frame.
    const cells = framed.flat().map((c) => c.cell);
    const rot = cells.length ? dominantRotation(cells) : 0;
    const separators = (rot === 0 || rot === 180 ? rules : verticalRules).map((r) => readingFrame(r, rot));
    const ruledBetween = (a: FramedCell, b: FramedCell) =>
        separators.some(
            (r) =>
                (r[1] + r[3]) / 2 > (a.f[1] + a.f[3]) / 2 &&
                (r[1] + r[3]) / 2 < (b.f[1] + b.f[3]) / 2 &&
                Math.min(r[2], a.f[2], b.f[2]) > Math.max(r[0], a.f[0], b.f[0]),
        );

    // Logical rows: per cell, its lines top to bottom and its column.
    const logical: { lines: FramedCell[]; column?: number }[][] = [];
    framed.forEach((row, i) => {
        const prev = i > 0 ? logical[logical.length - 1] : undefined;
        const above = i > 0 ? framed[i - 1] : undefined;
        if (prev && above && of[i].every((j) => j !== undefined) && of[i - 1].every((j) => j !== undefined)) {
            const targets = row.map((cell, k) => prev.find((c) => c.column === of[i][k]));
            const lasts = targets.map((t) => t?.lines[t.lines.length - 1]);
            const kinds = row.map((cell, k): Continuation => {
                const last = lasts[k];
                if (!last || !above.includes(last) || ruledBetween(last, cell)) return "breaks";
                return continuation(last, cell, right.get(of[i][k]!)!, leading, minWords(of[i][k]!));
            });
            const ended = lasts.map((l) => !!l && SENTENCE_END_RE.test(l.cell.text.trimEnd()));
            if (joinsRowAbove(kinds, of[i], ended, above.length, columns >= 2)) {
                row.forEach((cell, k) => targets[k]!.lines.push(cell));
                return;
            }
        }
        logical.push(row.map((cell, k) => ({ lines: [cell], column: of[i][k] })));
    });

    const multi = columns >= 2;
    const columnLines = new Map<number, number>();
    for (const cols of of) for (const j of new Set(cols)) if (j !== undefined) columnLines.set(j, (columnLines.get(j) ?? 0) + 1);
    return {
        lines: framed.length,
        columnLines,
        ...(multi ? { columns } : {}),
        rows: logical.map((row) => {
            const aligned = multi && row.every((c) => c.column !== undefined);
            return row.map(({ lines, column }) => ({
                text: joinCellLines(lines.map((l) => l.cell.text), vocabulary),
                bbox: toBBox(
                    lines.reduce<Rect>(
                        (u, l) => [Math.min(u[0], l.cell.rect[0]), Math.min(u[1], l.cell.rect[1]), Math.max(u[2], l.cell.rect[2]), Math.max(u[3], l.cell.rect[3])],
                        [Infinity, Infinity, -Infinity, -Infinity],
                    ),
                ),
                ...(aligned ? { column } : {}),
            }));
        }),
    };
}

/** The text of a cell's lines, words broken at a line end joined as in prose. */
function joinCellLines(lines: readonly string[], vocabulary?: ReadonlySet<string>): string {
    let text = lines[0] ?? "";
    for (let i = 1; i < lines.length; i++) {
        const next = lines[i];
        const decision = decideLineBreakHyphen(text, next, vocabulary);
        if (decision === "join") text = text.replace(/-\s*$/u, "") + next.trimStart();
        else if (decision === "keep") text = text.trimEnd() + next.trimStart();
        else text = `${text} ${next}`;
    }
    return text;
}

/** Figure label rows without rows of number punctuation alone, capped at `PICTURE_TEXT_MAX_CHARS`. */
function pictureRows(rows: RegionCell[][]): RegionCell[][] {
    const out: RegionCell[][] = [];
    let length = 0;
    for (const row of rows) {
        const text = row.map((c) => c.text).join(" ");
        if (NUMERIC_TEXT_RE.test(text) && !/\p{N}/u.test(text)) continue;
        if (length + text.length > PICTURE_TEXT_MAX_CHARS) break;
        out.push(row);
        length += text.length + 1;
    }
    return out;
}

/** A number in a figure: its value and the centre of its characters on the page. */
interface FigureNumber {
    value: number;
    x: number;
    y: number;
}

/** A number token: sign, currency, digits with grouping or decimal separators, percent. */
const NUMBER_RE = /[-−–]?[$€£]?(?:\d+(?:[.,]\d+)*|[.,]\d+)%?/gu;
/** An axis has at least this many ticks (the second when other numbers share its row or column)... */
const AXIS_MIN_TICKS = 3;
const AXIS_PART_MIN_TICKS = 5;
/** ...each within this share of the tick spacing of where a linear (or logarithmic) scale puts it... */
const AXIS_TOLERANCE = 0.2;
/** ...and lined up with the others within this many type sizes (a row's centre line, a column's edge). */
const AXIS_ALIGN = 0.4;
/** Tick values step evenly to within this share of a step (rounding in their labels). */
const STEP_TOLERANCE = 0.01;
/** Integer ticks this far apart may step unevenly by one (an index axis starting at 1). */
const INDEX_STEP = 20;
/** A word this many type sizes from a row of numbers (or within the row's length) labels it. */
const ROW_LABEL_REACH = 10;
/** Runs of numbers longer than this are tested only as a whole for an axis. */
const AXIS_SEARCH_MAX = 40;

/** The value of a number token; `undefined` when it does not read as one number. */
function numberValue(token: string): number | undefined {
    let s = token.replace(/[−–]/gu, "-").replace(/[$€£%]/gu, "");
    if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(s)) s = s.replace(/,/gu, "");
    else if (/^-?\d*,\d+$/u.test(s)) s = s.replace(",", ".");
    if (!/\d/u.test(s)) return undefined;
    const value = Number(s);
    return Number.isFinite(value) ? value : undefined;
}

/**
 * The numbers of a figure cell made of numbers alone, positioned from their
 * characters (along the piece when it has no character boxes); `undefined` for
 * any other cell, or when a token does not read as a number. A cell of
 * sideways text counts only as one number, at its centre (a rotated tick label).
 */
function figureNumbers(cell: Cell, parts: readonly RegionLine[], numbered: readonly RawLine[]): FigureNumber[] | undefined {
    const text = cell.text;
    if (!NUMERIC_TEXT_RE.test(text) || !/\p{N}/u.test(text)) return undefined;
    const centre = (value: number): FigureNumber[] => [
        { value, x: (cell.rect[0] + cell.rect[2]) / 2, y: (cell.rect[1] + cell.rect[3]) / 2 },
    ];
    // A power of ten whose exponent lost its raise ("10−5"): a log axis label.
    const power = /^\s*10[−–-](\d{1,3})\s*$/u.exec(text);
    if (power) return centre(10 ** -Number(power[1]));
    if (cell.rot !== 0) {
        const tokens = text.match(NUMBER_RE) ?? [];
        const value = tokens.length === 1 ? numberValue(tokens[0]) : undefined;
        return value === undefined ? undefined : centre(value);
    }
    const out: FigureNumber[] = [];
    for (const part of parts) {
        const source = numbered[part.source - 1] as RawLineDetailed | undefined;
        const codepoints = source ? [...source.text] : [];
        const chars = source?.chars?.length === codepoints.length ? source.chars : undefined;
        const piece = chars ? codepoints.slice(part.range[0], part.range[1]).join("") : part.text;
        const y = (part.bbox[1] + part.bbox[3]) / 2;
        for (const match of piece.matchAll(NUMBER_RE)) {
            const value = numberValue(match[0]);
            if (value === undefined) return undefined;
            const a = match.index;
            const b = a + match[0].length;
            let x: number;
            if (chars && piece.length === part.range[1] - part.range[0]) {
                x = (chars[part.range[0] + a].bbox.l + chars[part.range[0] + b - 1].bbox.r) / 2;
            } else {
                x = part.bbox[0] + ((a + b) / 2 / Math.max(1, piece.length)) * (part.bbox[2] - part.bbox[0]);
            }
            out.push({ value, x, y });
        }
    }
    return out.length ? out : undefined;
}

/**
 * Cells of a figure that are axis ticks: every number in them lies on an axis,
 * a run of at least `AXIS_MIN_TICKS` numbers lined up on one row (left to
 * right) or one column edge (top to bottom), strictly increasing or decreasing,
 * whose positions follow their values on a linear or logarithmic scale. Data
 * values (a pie chart's shares, bar and point labels) sit beside their marks
 * and keep their place in the figure text.
 */
function axisTicks(cells: readonly Cell[]): Set<Cell> {
    const numbers = cells.flatMap((cell) => (cell.numbers ?? []).map((n) => ({ ...n, cell })));
    type Placed = (typeof numbers)[number];
    const onAxis = new Set<Placed>();
    const cluster = (list: readonly Placed[], key: (n: Placed) => number): Placed[][] => {
        const groups: Placed[][] = [];
        for (const n of [...list].sort((a, b) => key(a) - key(b))) {
            const group = groups[groups.length - 1];
            if (group && key(n) - key(group[0]) <= AXIS_ALIGN * n.cell.size) group.push(n);
            else groups.push([n]);
        }
        return groups;
    };
    // Runs of numbers along each row (left to right) and column (top to bottom).
    const byX = (n: Placed) => n.x;
    const byY = (n: Placed) => n.y;
    const runs: { run: Placed[]; position: (n: Placed) => number; alone: boolean; values: string }[] = [];
    const addRuns = (line: readonly Placed[], position: (n: Placed) => number) => {
        const sorted = [...line].sort((a, b) => position(a) - position(b));
        for (const run of monotonicRuns(sorted)) {
            runs.push({ run, position, alone: run.length === sorted.length, values: run.map((n) => n.value).join(" ") });
        }
    };
    // A row of numbers led by a label (an upright cell without numbers on its row,
    // ending before the first number, at most the row's own length or
    // `ROW_LABEL_REACH` type sizes before it) is a labelled row of values, never a
    // scale: none of its numbers is a tick, whichever line it also lies on. An axis
    // has its title set apart (below, or sideways) and marks to its right.
    const words = cells.filter((c) => !c.numbers && c.rot === 0);
    const values = new Set<Cell>();
    for (const row of cluster(numbers, byY)) {
        const lo = Math.min(...row.map((n) => n.x));
        const hi = Math.max(...row.map((n) => n.x));
        const y = row.reduce((a, n) => a + n.y, 0) / row.length;
        const reach = Math.max(hi - lo, ROW_LABEL_REACH * row[0].cell.size);
        const first = Math.min(...row.map((n) => n.cell.rect[0]));
        const label = words.some(
            (c) =>
                c.rect[2] <= first + 1 &&
                c.rect[2] >= first - reach &&
                Math.abs((c.rect[1] + c.rect[3]) / 2 - y) <= AXIS_ALIGN * c.size,
        );
        if (label) for (const n of row) values.add(n.cell);
    }
    for (const row of cluster(numbers, byY)) addRuns(row, byX);
    // One number per cell: cells sharing an edge or a centre, along a row (sideways
    // labels of a horizontal axis share their top or bottom) or down a column.
    const single = numbers.filter((n) => n.cell.numbers!.length === 1);
    for (const edge of [(r: Rect) => r[1], (r: Rect) => r[3]]) {
        for (const row of cluster(single, (n) => edge(n.cell.rect))) addRuns(row, byX);
    }
    const edges: ((r: Rect) => number)[] = [(r) => r[0], (r) => r[2], (r) => (r[0] + r[2]) / 2];
    for (const edge of edges) for (const column of cluster(single, (n) => edge(n.cell.rect))) addRuns(column, byY);
    // Panels repeat their axes: the same values, in the same direction, on other cells.
    const repeated = (r: (typeof runs)[number]) =>
        runs.some(
            (o) =>
                o.position === r.position &&
                o.values === r.values &&
                o.run.every((n) => !r.run.some((m) => m.cell === n.cell)),
        );
    // A short axis stands alone on its line or repeats.
    for (const r of runs) for (const n of onScaleStretches(r.run, r.position, r.alone || repeated(r))) onAxis.add(n);
    const ticks = new Set<Cell>();
    for (const cell of cells) {
        if (cell.numbers && !values.has(cell) && numbers.every((n) => n.cell !== cell || onAxis.has(n))) ticks.add(cell);
    }
    return ticks;
}

/**
 * The numbers of `run` on an axis: the whole run when it has at least
 * `AXIS_PART_MIN_TICKS` numbers on one scale (`AXIS_MIN_TICKS` for a `whole`
 * run, the only one on its line or repeated there), else its longest contiguous
 * stretch of at least `AXIS_PART_MIN_TICKS`, then the same in what lies before
 * and after it (a value or another panel's axis next to an axis does not hide
 * it). Sorted data values step evenly now and then for three in a row, rarely
 * for four.
 */
function onScaleStretches<T extends { value: number }>(run: readonly T[], position: (n: T) => number, whole = false): T[] {
    const least = whole ? AXIS_MIN_TICKS : AXIS_PART_MIN_TICKS;
    if (run.length >= least && onScale(run.map(position), run.map((n) => n.value))) return [...run];
    // A long run is judged whole: the search is cubic in its length.
    const shortest = run.length > AXIS_SEARCH_MAX ? run.length : AXIS_PART_MIN_TICKS;
    for (let length = run.length - 1; length >= shortest; length--) {
        for (let start = 0; start + length <= run.length; start++) {
            const stretch = run.slice(start, start + length);
            if (!onScale(stretch.map(position), stretch.map((n) => n.value))) continue;
            return [
                ...onScaleStretches(run.slice(0, start), position),
                ...stretch,
                ...onScaleStretches(run.slice(start + length), position),
            ];
        }
    }
    return [];
}

/**
 * Maximal runs of strictly increasing or strictly decreasing values: an axis
 * lies within one (panels side by side repeat their axes), which keeps the
 * stretch search short.
 */
function monotonicRuns<T extends { value: number }>(sorted: readonly T[]): T[][] {
    const runs: T[][] = [];
    let run: T[] = [];
    for (const n of sorted) {
        const last = run[run.length - 1];
        if (last && n.value === last.value) {
            runs.push(run);
            run = [];
        } else if (run.length >= 2 && n.value - last.value > 0 !== last.value - run[run.length - 2].value > 0) {
            runs.push(run);
            run = [last];
        }
        run.push(n);
    }
    if (run.length) runs.push(run);
    return runs;
}

/**
 * Tick labels: values on a linear scale's grid (equal steps), or round values
 * (one significant digit: 1, 2, 5, 10, 0.01) on a logarithmic scale, whose
 * positions follow that scale. Data values that happen to line up rarely step
 * evenly.
 */
function onScale(positions: readonly number[], values: readonly number[]): boolean {
    const spacing = (Math.max(...positions) - Math.min(...positions)) / (positions.length - 1);
    if (!(spacing > 0)) return false;
    const fits = (xs: readonly number[]) => {
        const n = xs.length;
        const mx = xs.reduce((a, b) => a + b, 0) / n;
        const mp = positions.reduce((a, b) => a + b, 0) / n;
        let sxx = 0;
        let sxp = 0;
        xs.forEach((x, i) => {
            sxx += (x - mx) ** 2;
            sxp += (x - mx) * (positions[i] - mp);
        });
        if (sxx === 0) return false;
        const slope = sxp / sxx;
        return xs.every((x, i) => Math.abs(mp + slope * (x - mx) - positions[i]) <= AXIS_TOLERANCE * spacing);
    };
    const step = values[1] - values[0];
    // An index axis may start at 1 rather than 0 ("1 100 200"): integer steps of 20 or
    // more may differ by one.
    const slack =
        values.every(Number.isInteger) && Math.abs(step) >= INDEX_STEP ? Math.max(1, STEP_TOLERANCE * Math.abs(step)) : STEP_TOLERANCE * Math.abs(step);
    const evenSteps = values.every((v, i) => i === 0 || Math.abs(v - values[i - 1] - step) <= slack);
    const round = (v: number) => {
        const mantissa = v / 10 ** Math.floor(Math.log10(v));
        return Math.abs(mantissa - Math.round(mantissa)) <= STEP_TOLERANCE;
    };
    return (evenSteps && fits(values)) || (values.every((v) => v > 0 && round(v)) && fits(values.map(Math.log)));
}

function toBBox(r: Rect): BoundingBox {
    return { l: r[0], t: r[1], r: r[2], b: r[3], origin: "top-left" };
}

function unionBBox(a: BoundingBox, b: BoundingBox): BoundingBox {
    return { l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b), origin: a.origin };
}

/** The page without `lines`; blocks left empty are dropped and shrunken blocks re-bounded. */
function withoutLines(page: RawPageDataDetailed, lines: ReadonlySet<RawLine>): RawPageDataDetailed {
    if (lines.size === 0) return page;
    const blocks: RawBlockDetailed[] = [];
    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines || !block.lines.some((l) => lines.has(l))) {
            blocks.push(block);
            continue;
        }
        const rest = block.lines.filter((l) => !lines.has(l));
        if (rest.length === 0) continue;
        const bbox = rest.reduce(
            (u, l) => ({
                l: Math.min(u.l, l.bbox.l),
                t: Math.min(u.t, l.bbox.t),
                r: Math.max(u.r, l.bbox.r),
                b: Math.max(u.b, l.bbox.b),
                origin: u.origin,
            }),
            { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity, origin: block.bbox.origin },
        );
        blocks.push({ ...block, bbox, lines: rest });
    }
    return { ...page, blocks };
}

const CELL_SEPARATOR: Record<RegionItemKind, string> = { table: " | ", formula: " ", picture: " " };

/** The page's reading frame: its dominant text rotation and MuPDF-frame size. */
export interface ReadingFrame {
    rotation: RotationAngle;
    sourceWidth: number;
    sourceHeight: number;
}

/**
 * Place region items among a page's text items in reading order and renumber
 * every item (`p<page>:i<index>`). A region goes before the first item below
 * its centre that overlaps it horizontally, else after the last such item above
 * it, else at the end — but never between a sentence and its continuation in
 * the next item. Regions sharing a position keep reading order: one placed
 * after an item comes before one placed before the next item. `sentences` is rebuilt from the items (they share sentence
 * objects); `renamed` maps old item ids to new ones.
 *
 * Item and region boxes are in the MuPDF frame. On a page with sideways text,
 * pass its `frame` so "below" and "horizontally" are judged in the upright
 * reading frame; the output boxes stay in the MuPDF frame.
 */
export function placeRegionItems(
    pageIndex: number,
    items: readonly DocItem[],
    regions: readonly RegionItemDraft[],
    frame?: ReadingFrame,
): { items: DocItem[]; sentences: SentenceItem[]; renamed: Map<string, string> } {
    const upright = (b: BoundingBox): BoundingBox =>
        frame && frame.rotation !== 0 ? rotateBBox(b, frame.rotation, frame.sourceWidth, frame.sourceHeight) : b;
    const cy = (b: BoundingBox) => (b.t + b.b) / 2;
    const overlapsX = (a: BoundingBox, b: BoundingBox) => Math.min(a.r, b.r) > Math.max(a.l, b.l);
    const continues = (item: DocItem) =>
        "sentences" in item && !!item.sentences?.length && !!item.sentences[item.sentences.length - 1].joinWithNext;

    // Position = number of text items before the region.
    const itemBoxes = items.map((item) => upright(item.bbox));
    const placed = regions.map((region, order) => {
        const box = upright(region.bbox);
        const center = cy(box);
        let position = itemBoxes.findIndex((b) => overlapsX(b, box) && cy(b) > center);
        const after = position < 0;
        if (after) {
            let last = -1;
            itemBoxes.forEach((b, i) => {
                if (overlapsX(b, box) && cy(b) <= center) last = i;
            });
            position = last >= 0 ? last + 1 : items.length;
        }
        while (position > 0 && position < items.length && continues(items[position - 1])) position++;
        return { region, top: box.t, position, after, order };
    });
    // At one position, regions that close the preceding item's column come
    // before those that open the next item's column, then top to bottom.
    placed.sort(
        (a, b) => a.position - b.position || Number(b.after) - Number(a.after) || a.top - b.top || a.order - b.order,
    );

    const out: DocItem[] = [];
    const renamed = new Map<string, string>();
    let next = 0;
    const pushRegions = (position: number) => {
        while (next < placed.length && placed[next].position === position) {
            const index = out.length;
            const neighbour = out[index - 1] ?? items[0];
            out.push(regionItem(placed[next++].region, pageIndex, index, neighbour?.columnIndex ?? 0));
        }
    };
    items.forEach((item, i) => {
        pushRegions(i);
        const index = out.length;
        const id = `p${pageIndex}:i${index}`;
        renamed.set(item.id, id);
        out.push({ ...item, id, index });
    });
    pushRegions(items.length);

    const sentences: SentenceItem[] = [];
    for (const item of out) {
        if (!("sentences" in item) || !item.sentences) continue;
        for (const sentence of item.sentences) {
            sentence.parentId = item.id;
            sentences.push(sentence);
        }
    }
    return { items: out, sentences, renamed };
}

/** A row's text; an aligned row leaves an empty slot for each missing column. */
function rowText(row: readonly RegionCell[], separator: string, columns?: number): string {
    if (!columns || row.length === columns || row.some((c) => c.column === undefined)) {
        return row.map((c) => c.text).join(separator);
    }
    const slots = Array.from({ length: columns }, () => "");
    for (const c of row) slots[c.column!] = c.text;
    return slots.map((text) => (text ? ` ${text} ` : " ")).join(separator.trim()).trim();
}

function regionItem(draft: RegionItemDraft, pageIndex: number, index: number, columnIndex: number): DocItem {
    const id = `p${pageIndex}:i${index}`;
    const separator = CELL_SEPARATOR[draft.kind];
    const lines: ItemLine[] = draft.rows.map((row) => ({
        text: rowText(row, separator, draft.columns),
        bbox: row.slice(1).reduce((u, c) => unionBBox(u, c.bbox), row[0].bbox),
    }));
    const base = { id, pageIndex, index, bbox: draft.bbox, columnIndex, text: lines.map((l) => l.text).join("\n"), lines };
    if (draft.kind !== "table") return { ...base, kind: draft.kind };
    const sentences: SentenceItem[] = draft.rows.map((row, i) => ({
        parentId: id,
        index: i,
        text: lines[i].text,
        bboxes: row.map((c) => c.bbox),
    }));
    return { ...base, kind: "table", sentences };
}
