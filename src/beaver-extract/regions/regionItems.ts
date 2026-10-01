/**
 * Region detection → document items (structured extraction, schema presets
 * with `regions`).
 *
 * Text lines routed to a table, figure or display equation leave the prose:
 * they are removed from the page before paragraph detection and become the
 * region item's text instead.
 * - table: one row per line, cells joined by " | "; each row is a sentence. A
 *   row missing cells keeps an empty slot for each, so values stay under their
 *   column.
 * - formula: the equation's rows; an equation number stays at the end of its row.
 * - picture: label rows, not sentences; rows of bare numbers (axis ticks) are
 *   dropped and the text is capped.
 * Lines routed to a decoration are removed without an item. Running text and
 * captions are not routed (`routeLines`), so prose keeps its sentences; only
 * lines on a table's rows join the table whatever their flags.
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
    RawPageDataDetailed,
    SentenceItem,
} from "@beaver/agent-core/extract/types";

import { rotateBBox, type RotationAngle } from "../PageRotationNormalizer";
import type { Rect } from "./geometry";
import type { RegionClass } from "./model";
import { sourceLines, type RegionLine } from "./pageSignals";
import type { RegionDetection } from "./RegionDetector";

export type RegionItemKind = "table" | "picture" | "formula";

/** A region item before it is placed in the page's reading order. */
export interface RegionItemDraft {
    kind: RegionItemKind;
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
    /** The page without the lines regions absorbed (the input page when none are). */
    page: RawPageDataDetailed;
    items: RegionItemDraft[];
}

const ITEM_KINDS: ReadonlySet<RegionClass> = new Set<RegionClass>(["table", "picture", "formula"]);

/** A formula line with this many ordinary words is prose around the equation. */
export const FORMULA_PROSE_WORDS = 5;
/** Figure label text beyond this many characters is cut. */
export const PICTURE_TEXT_MAX_CHARS = 2000;
/** A figure row of numbers alone: axis ticks, scales. */
const NUMERIC_ROW_RE = /^[\s\p{N}.,:;%+\-−–—()[\]/×·^*]*$/u;

/**
 * Items for the regions of one page and the page without the lines they
 * absorb. `detection` must come from `detectRegions(page, …, { route: true })`
 * with a model; a scanned page gets no regions.
 */
export function regionItemsForPage(page: RawPageDataDetailed, detection: RegionDetection): PageRegionItems {
    const routing = detection.routing;
    const regions = detection.candidates;
    const kept = regions.map((r) => r.label !== undefined && r.label !== "other");
    if (!routing || detection.scanned || !kept.some(Boolean)) return { page, items: [] };

    // Each piece with the region its visual line is routed to.
    const pieces: { piece: RegionLine; line: number; route: number }[] = [];
    routing.lines.forEach((line, i) => {
        let route = routing.routes[i];
        if (route >= 0 && regions[route].label === "formula" && line.alphaWords >= FORMULA_PROSE_WORDS) route = -1;
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
        cells.push({ rect, text: parts.map((p) => p.text).join(" "), rot });
        cellsByRegion.set(region, cells);
    }

    const items: RegionItemDraft[] = [];
    regions.forEach((region, k) => {
        if (!kept[k] || !ITEM_KINDS.has(region.label!)) return;
        const kind = region.label as RegionItemKind;
        const framed = groupRows(cellsByRegion.get(k) ?? []);
        const aligned = kind === "table" ? alignColumns(framed) : undefined;
        let rows = aligned?.rows ?? framed.map((row) => row.map(({ cell }) => ({ text: cell.text, bbox: toBBox(cell.rect) })));
        if (kind === "picture") rows = pictureRows(rows);
        // Whole structured-text lines are absorbed, so text can reach past the region.
        const bbox = rows.flat().reduce((u, c) => unionBBox(u, c.bbox), toBBox(region.bbox));
        items.push({ kind, bbox, rows, ...(aligned ? { columns: aligned.columns } : {}) });
    });

    const absorbed = new Set<RawLine>();
    const numbered = sourceLines(page);
    for (const source of destination.keys()) {
        const line = numbered[source - 1];
        if (line) absorbed.add(line);
    }
    return { page: withoutLines(page, absorbed), items };
}

type ReadingRotation = 0 | 90 | 180 | 270;

interface Cell {
    rect: Rect;
    text: string;
    rot: ReadingRotation;
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

/** A cell with its box in the region's reading frame. */
interface FramedCell {
    cell: Cell;
    f: Rect;
}

/**
 * Cells grouped into rows: cells sharing most of their height are one row,
 * rows top to bottom and cells left to right. Vertical and upside-down text is
 * grouped in its own reading frame.
 */
function groupRows(cells: Cell[]): FramedCell[][] {
    if (cells.length === 0) return [];
    const rotCounts = new Map<ReadingRotation, number>();
    for (const c of cells) rotCounts.set(c.rot, (rotCounts.get(c.rot) ?? 0) + 1);
    const rot = [...rotCounts].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
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

/**
 * Table rows with each cell's column. Columns span the cells of the rows with
 * the most cells; a shorter row is aligned when each of its cells overlaps
 * exactly one column and they keep their order. Other rows (a header spanning
 * columns, a cell in a gutter) stay unaligned. `undefined` for a table without
 * at least two columns.
 */
function alignColumns(rows: FramedCell[][]): { rows: RegionCell[][]; columns: number } | undefined {
    const columns = Math.max(0, ...rows.map((row) => row.length));
    if (columns < 2) return undefined;
    const spans = Array.from({ length: columns }, () => [Infinity, -Infinity]);
    for (const row of rows) {
        if (row.length !== columns) continue;
        row.forEach(({ f }, j) => {
            spans[j][0] = Math.min(spans[j][0], f[0]);
            spans[j][1] = Math.max(spans[j][1], f[2]);
        });
    }
    const toCell = ({ cell }: FramedCell, column?: number): RegionCell => ({
        text: cell.text,
        bbox: toBBox(cell.rect),
        ...(column !== undefined ? { column } : {}),
    });
    return {
        columns,
        rows: rows.map((row) => {
            if (row.length === columns) return row.map((c, j) => toCell(c, j));
            const assigned = row.map(({ f }) => {
                const hits = spans.flatMap(([l, r], j) => (Math.min(r, f[2]) > Math.max(l, f[0]) ? [j] : []));
                return hits.length === 1 ? hits[0] : -1;
            });
            const ordered = assigned.every((j, i) => j >= 0 && (i === 0 || j > assigned[i - 1]));
            return row.map((c, i) => toCell(c, ordered ? assigned[i] : undefined));
        }),
    };
}

/** Figure label rows without bare-number rows, capped at `PICTURE_TEXT_MAX_CHARS`. */
function pictureRows(rows: RegionCell[][]): RegionCell[][] {
    const out: RegionCell[][] = [];
    let length = 0;
    for (const row of rows) {
        const text = row.map((c) => c.text).join(" ");
        if (NUMERIC_ROW_RE.test(text)) continue;
        if (length + text.length > PICTURE_TEXT_MAX_CHARS) break;
        out.push(row);
        length += text.length + 1;
    }
    return out;
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
