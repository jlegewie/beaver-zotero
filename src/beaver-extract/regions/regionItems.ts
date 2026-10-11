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
import { EQUATION_NUMBER_END_RE, EQUATION_REFERENCE_END_RE, sourceLines, type RegionLine } from "./pageSignals";
import { LINE_CAPTION, LINE_FURNITURE, LINE_GUTTER, LINE_MARGIN, LINE_RUNNING, LINE_SKEWED, type LineRouting, type RegionDetection } from "./RegionDetector";

export type RegionItemKind = "table" | "picture" | "formula";

/** A region item before it is placed in the page's reading order. */
export interface RegionItemDraft {
    kind: RegionItemKind;
    /** Index of the detected region (`RegionDetection.candidates`) the item comes from. */
    region: number;
    /** The region's box, grown to cover the text it absorbed. */
    bbox: BoundingBox;
    /**
     * Where the item sits among the page's columns, for placement, when that
     * is narrower than `bbox`: the box of its body, without a label set in
     * another column's margin (`splitRegionItems`). Defaults to `bbox`.
     */
    anchor?: BoundingBox;
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
    /**
     * Where each absorbed structured-text line went, by `RegionLine.source`: the
     * index of its region in `RegionDetection.candidates`, after the source-line
     * vote and the `readsAsTable` gate. Lines not listed stay on the page.
     */
    destinations?: ReadonlyMap<number, number>;
}

const ITEM_KINDS: ReadonlySet<RegionClass> = new Set<RegionClass>(["table", "picture", "formula"]);

/** A formula row with this many ordinary words is prose around the equation. */
export const FORMULA_PROSE_WORDS = 5;
/** A LaTeX command ("\frac", "\ label"), as in an equation's source kept in the text layer. */
const LATEX_COMMAND_RE = /\\\s?[A-Za-z]{2,}/;
/** A word token: letters only, maybe with an apostrophe or hyphen, and trailing punctuation. */
const TEXT_WORD_RE = /^[\p{L}][\p{L}'’-]{2,}[.,;:!?)]*$/u;
/** A token mixing Greek and Latin letters: a variable's name. */
const MIXED_SCRIPT_RE = /(?=.*\p{Script=Greek})(?=.*\p{Script=Latin})/u;
/** Names of mathematical operators, set upright in text fonts. */
const MATH_OPERATORS = new Set([
    "arg", "cos", "cosh", "cot", "coth", "csc", "deg", "det", "dim", "exp", "gcd", "hom", "inf", "ker", "lim", "liminf",
    "limsup", "log", "max", "min", "mod", "sec", "sin", "sinh", "sup", "tan", "tanh", "var", "cov", "corr", "diag", "sign",
    "tr", "rank", "argmax", "argmin", "softmax", "relu", "erf", "logit",
]);
/** A piece with at most this share of math characters is text. */
const FORMULA_TEXT_MATH = 0.2;
/** A formula row beside a running line of this many words is that line's inline math... */
const FORMULA_RUNNING_WORDS = 3;
/** ...set at most this many typical piece heights from it (a word space, not a column gutter). */
const FORMULA_INLINE_GAP = 1;
/** A column gutter has at least this many running lines on each side... */
const GUTTER_SIDE_LINES = 5;
/** ...and is crossed by at most this share of the fewer of them (a title, an abstract). */
const GUTTER_CROSSING = 0.2;
/** A justified prose line starts at most this many typical piece heights inside its column (an indent). */
const FORMULA_INDENT = 2.5;
/** A formula row's text reaches through gaps of at most this many typical piece heights. */
const FORMULA_ROW_GAP = 2;
/** Formula pieces taller than this many times a typical one (upper quartile) belong to no row. */
const FORMULA_ROW_HEIGHT = 1.5;
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
    const prose = formulaProseRows(routing, regions);
    const pieces: { piece: RegionLine; line: number; route: number }[] = [];
    routing.lines.forEach((line, i) => {
        let route = routing.routes[i];
        if (route >= 0 && regions[route].label === "formula" && (line.alphaWords >= FORMULA_PROSE_WORDS || prose.has(i))) route = -1;
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
        const segments = parts.flatMap((p) => pieceSegments(p, numbered[p.source - 1]));
        const cell: Cell = { rect, text, rot, size, ...(lead !== undefined ? { lead } : {}), ...(segments.length > 1 ? { segments } : {}) };
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
        if (table && table.rows.length && !readsAsTable(table, tableLeak(k, routing, lineDestination, table), runningShare(k, routing, lineDestination))) {
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
        // A table or equation whose text all went back to the prose is no item. A figure
        // without text (a photo, a raster chart) still is, and so is a table or equation that
        // never had a text layer (a raster table, an equation drawn as paths).
        else if (!rows.length && hadText(region.bbox, routing)) return;
        // Whole structured-text lines are absorbed, so text can reach past the region. An
        // equation's box ends where lines it took from the prose above or below it went back.
        const cells = rows.flat();
        const box = kind === "formula" && cells.length ? withoutReturnedProse(toBBox(region.bbox), cells, routing) : toBBox(region.bbox);
        const bbox = cells.reduce((u, c) => unionBBox(u, c.bbox), box);
        items.push({ kind, region: k, bbox, rows, ...(table?.columns ? { columns: table.columns } : {}) });
    });

    const absorbed = new Set<RawLine>(furniture);
    for (const source of destination.keys()) {
        const line = numbered[source - 1];
        if (line) absorbed.add(line);
    }
    return { page: withoutLines(page, absorbed), items, margin, destinations: destination };
}

/** Whether text lines of the page (other than furniture) stand in `rect`, centre inside. */
function hadText(rect: Rect, routing: LineRouting): boolean {
    return routing.lines.some((l, i) => {
        if (routing.flags[i] & (LINE_FURNITURE | LINE_MARGIN)) return false;
        const cx = (l.bbox[0] + l.bbox[2]) / 2;
        const cy = (l.bbox[1] + l.bbox[3]) / 2;
        return cx >= rect[0] && cx <= rect[2] && cy >= rect[1] && cy <= rect[3];
    });
}

/** A lead-in beside an equation's top starts at most this many of its heights below the equation's text. */
const LEAD_IN_ROW = 0.5;

/**
 * An equation's box without the prose it took above or below its own lines, or
 * before its first row: its top moves below the lines inside it over the
 * equation's text (they went elsewhere), and its bottom above those under it.
 * Rules, radicals and delimiters drawn as paths keep the rest of the box. A
 * lead-in left of the equation's text, level with its top (words of a sentence
 * ending beside the top of tall brackets or a numerator, starting at the text
 * column's margin as the running lines do), moves the box's left edge in to the
 * equation's text and rules. A display's own text that went to the prose starts
 * further in, and keeps the box. Text beside the equation lower down, or right
 * of it, is left alone: it is usually another column's, and the box's reach
 * across the gutter is what splits an equation box merged across columns.
 */
function withoutReturnedProse(box: BoundingBox, cells: readonly { bbox: BoundingBox }[], routing: LineRouting): BoundingBox {
    const top = Math.min(...cells.map((c) => c.bbox.t));
    const bottom = Math.max(...cells.map((c) => c.bbox.b));
    const left = Math.min(...cells.map((c) => c.bbox.l));
    const inside = (r: Rect) => {
        const cx = (r[0] + r[2]) / 2;
        const cy = (r[1] + r[3]) / 2;
        return cx >= box.l && cx <= box.r && cy >= box.t && cy <= box.b;
    };
    // Where the equation starts across: its text and the rules drawn in its box.
    const rules = [...(routing.rules ?? []), ...(routing.verticalRules ?? [])].filter(inside);
    const from = Math.min(left, ...rules.map((r) => r[0]));
    const running = routing.lines.filter((l, i) => routing.flags[i] & LINE_RUNNING && !l.rot);
    const leadIn = (l: RegionLine) =>
        l.bbox[2] <= left &&
        l.bbox[1] <= top + LEAD_IN_ROW * (l.bbox[3] - l.bbox[1]) &&
        l.mathChars <= FORMULA_TEXT_MATH * l.inkChars &&
        running.some((r) => Math.abs(r.bbox[0] - l.bbox[0]) <= 2 && r.bbox[2] > l.bbox[2]);
    let { l: x0, t, b } = box;
    routing.lines.forEach((l) => {
        if (!inside(l.bbox)) return;
        if (l.bbox[3] <= top) t = Math.max(t, l.bbox[3]);
        else if (l.bbox[1] >= bottom) b = Math.min(b, l.bbox[1]);
        else if (leadIn(l)) x0 = Math.max(x0, from);
    });
    return { ...box, l: x0, t, b };
}

/**
 * Lines routed to a formula that are prose around it, beyond single lines of words
 * (`FORMULA_PROSE_WORDS`): pieces on a row of the formula's box that holds that many
 * words of text and runs across its text column as justified prose does, or that sits
 * a word space from a running line of words (the pieces are its inline math). A row is
 * judged whole within its text column: justified prose with inline math is split into
 * pieces at its wide word gaps and around the math, each too short to judge alone.
 */
function formulaProseRows(routing: LineRouting, regions: RegionDetection["candidates"]): Set<number> {
    const prose = new Set<number>();
    if (!regions.some((r) => r.label === "formula")) return prose;
    const height = (i: number) => routing.lines[i].bbox[3] - routing.lines[i].bbox[1];
    // The page's column gutters: places few running lines cross, with running lines on both
    // sides. A row of prose stays in its column.
    const running = routing.lines.filter((l, i) => routing.flags[i] & LINE_RUNNING && !l.rot);
    const gutters: number[] = [];
    if (running.length >= 2 * GUTTER_SIDE_LINES) {
        const x0 = Math.min(...running.map((l) => l.bbox[0]));
        const x1 = Math.max(...running.map((l) => l.bbox[2]));
        let open: number | undefined;
        for (let x = x0; x <= x1; x += 1) {
            const crossing = running.filter((l) => l.bbox[0] < x && l.bbox[2] > x).length;
            const left = running.filter((l) => l.bbox[2] <= x).length;
            const right = running.filter((l) => l.bbox[0] >= x).length;
            const gutter = left >= GUTTER_SIDE_LINES && right >= GUTTER_SIDE_LINES && crossing <= GUTTER_CROSSING * Math.min(left, right);
            if (gutter && open === undefined) open = x;
            if (!gutter && open !== undefined) {
                gutters.push((open + x) / 2);
                open = undefined;
            }
        }
    }
    regions.forEach((region, k) => {
        if (region.label !== "formula") return;
        const members = routing.routes.flatMap((route, i) => (route === k ? [i] : []));
        if (!members.length) return;
        // Tall pieces (brackets, stacked fractions) span several rows and belong to none.
        const heights = members.map(height).sort((a, b) => a - b);
        const typical = heights[Math.floor(0.75 * heights.length)];
        const [x0, y0, x1, y1] = region.bbox;
        const side = (i: number) => {
            const cx = (routing.lines[i].bbox[0] + routing.lines[i].bbox[2]) / 2;
            return gutters.filter((g) => g < cx).length;
        };
        const inBox = routing.lines.flatMap((l, i) => {
            const cx = (l.bbox[0] + l.bbox[2]) / 2;
            const cy = (l.bbox[1] + l.bbox[3]) / 2;
            const inside = cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1 && !l.rot;
            const member = routing.routes[i] === k || (routing.routes[i] < 0 && (routing.flags[i] & LINE_RUNNING) !== 0);
            return inside && member && height(i) <= FORMULA_ROW_HEIGHT * typical ? [i] : [];
        });
        inBox.sort((a, b) => routing.lines[a].bbox[1] - routing.lines[b].bbox[1]);
        for (const i of leadIn(routing, inBox.filter((i) => routing.routes[i] === k), running)) prose.add(i);
        if (paragraphLine(routing, members, running)) for (const i of members) prose.add(i);
        let row: number[] = [];
        let top = 0;
        let bottom = 0;
        const close = () => {
            for (const column of new Set(row.map(side))) {
                // The row's text around the formula's pieces: what they reach through gaps of
                // at most a few word spaces, set beside them rather than stacked over them.
                const gap = (i: number, j: number) => Math.max(routing.lines[j].bbox[0] - routing.lines[i].bbox[2], routing.lines[i].bbox[0] - routing.lines[j].bbox[2]);
                const pieces = row.filter((i) => side(i) === column && routing.routes[i] === k);
                const part = [...pieces];
                for (let grew = true; grew; ) {
                    grew = false;
                    for (const i of row) {
                        if (part.includes(i) || side(i) !== column) continue;
                        if (!pieces.every((j) => gap(i, j) >= 0) || !part.some((j) => gap(i, j) <= FORMULA_ROW_GAP * typical)) continue;
                        part.push(i);
                        grew = true;
                    }
                }
                // Words of text, not the variable names of an equation set in a math font.
                const words = part.reduce((n, i) => n + textWords(routing.lines[i]), 0);
                // A running line a word space from the pieces, directly or through other text
                // a word space apart: the pieces are its inline math.
                const inline = [...pieces];
                for (let grew = true; grew; ) {
                    grew = false;
                    for (const i of part) {
                        if (inline.includes(i) || !inline.some((j) => gap(i, j) <= FORMULA_INLINE_GAP * typical)) continue;
                        inline.push(i);
                        grew = true;
                    }
                }
                const beside = inline.some((i) => routing.flags[i] & LINE_RUNNING && routing.lines[i].alphaWords >= FORMULA_RUNNING_WORDS);
                // Words alone do not make prose (an equation's variables can read as words):
                // the row must also run across its text column as a justified line does.
                const body = part.filter((i) => !routing.lines[i].eqNumber);
                const x0 = Math.min(...body.map((i) => routing.lines[i].bbox[0]));
                const x1 = Math.max(...body.map((i) => routing.lines[i].bbox[2]));
                const spans = running.some((r) => x0 >= r.bbox[0] - 2 && x0 <= r.bbox[0] + FORMULA_INDENT * typical && Math.abs(x1 - r.bbox[2]) <= 3);
                if (!(words >= FORMULA_PROSE_WORDS && spans) && !beside) continue;
                for (const i of part) if (routing.routes[i] === k) prose.add(i);
            }
        };
        for (const i of inBox) {
            const [, a, , b] = routing.lines[i].bbox;
            if (row.length && Math.min(bottom, b) - Math.max(top, a) >= 0.5 * Math.min(bottom - top, b - a)) {
                row.push(i);
                top = Math.min(top, a);
                bottom = Math.max(bottom, b);
                continue;
            }
            close();
            row = [i];
            top = a;
            bottom = b;
        }
        close();
    });
    return prose;
}

/** A line that closes its sentence or introduces what follows: no paragraph continues past it. */
const SENTENCE_CLOSED_RE = /[.!?:][\])"'”’]*$/u;
/** Lines of a paragraph sit at most this many line heights apart. */
const PARAGRAPH_LEADING = 0.8;

/**
 * A formula of one row that is a line of its paragraph, set with inline math:
 * it runs from its text column's margin to its right edge, between full lines
 * of the paragraph at the paragraph's leading, and the line before it leaves its
 * sentence open. A display equation is centred or indented and set off by display
 * space, and the text before it ends short of the margin, introduces it (":") or
 * ends its sentence (an equation standing between sentences).
 */
function paragraphLine(routing: LineRouting, members: readonly number[], running: readonly RegionLine[]): boolean {
    // An equation number marks a display.
    if (!members.length || members.some((i) => routing.lines[i].eqNumber || EQUATION_NUMBER_END_RE.test(routing.lines[i].text))) return false;
    const boxes = members.map((i) => routing.lines[i].bbox);
    const y0 = Math.min(...boxes.map((b) => b[1]));
    const y1 = Math.max(...boxes.map((b) => b[3]));
    // One row: every piece overlaps the row's middle band.
    const mid = (y0 + y1) / 2;
    if (boxes.some((b) => b[1] > mid || b[3] < mid)) return false;
    const x0 = Math.min(...boxes.map((b) => b[0]));
    const x1 = Math.max(...boxes.map((b) => b[2]));
    const size = Math.max(1, ...members.map((i) => routing.lines[i].size));
    const neighbour = (up: boolean) => {
        let best: RegionLine | undefined;
        let bestGap = Infinity;
        for (const r of running) {
            if (r.rot || r.bbox[2] <= x0 || r.bbox[0] >= x1) continue;
            const gap = up ? y0 - r.bbox[3] : r.bbox[1] - y1;
            const h = r.bbox[3] - r.bbox[1];
            if (gap < -0.5 * h || gap >= bestGap || (up ? r.bbox[1] >= y0 : r.bbox[3] <= y1)) continue;
            best = r;
            bestGap = gap;
        }
        return best && bestGap <= PARAGRAPH_LEADING * (best.bbox[3] - best.bbox[1]) ? best : undefined;
    };
    const above = neighbour(true);
    const below = neighbour(false);
    if (!above || !below) return false;
    const indent = 2.5 * size;
    return (
        Math.abs(above.bbox[2] - x1) <= 3 &&
        x0 >= above.bbox[0] - 2 - indent &&
        x0 <= Math.min(above.bbox[0], below.bbox[0]) + indent &&
        !SENTENCE_CLOSED_RE.test(above.text) &&
        Math.abs(below.bbox[0] - above.bbox[0]) <= indent
    );
}

/** A lead-in holds at least this many words of text... */
const LEAD_IN_WORDS = 2;
/** ...and the display under it starts at least this many ems of its type further right. */
const LEAD_IN_INDENT = 1;
const LEAD_IN_RELATION_RE = /[=≤≥<>≈≡∝≠≃≅∼]/u;
/** Set relations and arrows, which prose also sets inline ("there exists D ∈ L with"). */
const LEAD_IN_SET_RELATION_RE = /[∈∉∋⊂⊃⊆⊇⊄⊊⊋≺≻⪯⪰→←↔⇒⇐⇔↦⟹⟺⊢⊨]/u;
/** Function words of a sentence; a display row of word-valued terms has (almost) none. */
const FUNCTION_WORDS = new Set([
    "a", "an", "the", "is", "are", "was", "be", "been", "and", "or", "of", "to", "in", "on", "at", "for", "with", "by",
    "as", "from", "that", "which", "where", "when", "then", "there", "this", "these", "between", "into", "its", "it",
    "we", "let", "if", "case", "such", "given", "exists",
]);
/** A display row that continues the row above: it opens with a relation sign or an operator. */
const LEAD_IN_CONTINUES_RE = /^\s*[=≤≥<>≈≡∝≠≃≅∼∈∉∋⊂⊃⊆⊇≺≻→⇒⇔↦+−\-×·÷/∪∩∖⊕⊗∘∧∨]/u;

/**
 * The top row of a formula when it is the sentence leading into the display
 * ("b) Select next feature using", "T being defined as"): words of text without a
 * relation sign, starting at its text column's margin, over a display row set
 * further right (centred or indented). `members` are the formula's lines, top to
 * bottom.
 */
function leadIn(routing: LineRouting, members: readonly number[], running: readonly RegionLine[]): number[] {
    if (members.length < 2) return [];
    const box = (i: number) => routing.lines[i].bbox;
    const first = box(members[0]);
    const row = members.filter((i) => Math.min(box(i)[3], first[3]) - Math.max(box(i)[1], first[1]) >= 0.5 * Math.min(box(i)[3] - box(i)[1], first[3] - first[1]));
    const rest = members.filter((i) => !row.includes(i));
    if (!rest.length) return [];
    const lines = row.map((i) => routing.lines[i]);
    // An equation number, its own piece or ending the row's text, marks a display row;
    // a sentence that refers to an equation ("given by Eq. (8)", "(70) and (71).") does not.
    const numbered = (l: RegionLine) => EQUATION_NUMBER_END_RE.test(l.text) && !EQUATION_REFERENCE_END_RE.test(l.text);
    if (lines.some((l) => l.eqNumber || numbered(l) || LEAD_IN_RELATION_RE.test(l.text) || l.mathChars > FORMULA_TEXT_MATH * l.inkChars)) return [];
    // A set relation or arrow marks a display row unless the row reads as a sentence.
    const sentence = (l: RegionLine) => l.text.toLowerCase().split(/[^\p{L}]+/u).filter((w) => FUNCTION_WORDS.has(w)).length >= 2;
    if (lines.some((l) => LEAD_IN_SET_RELATION_RE.test(l.text) && !sentence(l))) return [];
    if (lines.reduce((n, l) => n + textWords(l), 0) < LEAD_IN_WORDS) return [];
    const x0 = Math.min(...lines.map((l) => l.bbox[0]));
    const x1 = Math.max(...lines.map((l) => l.bbox[2]));
    const atMargin = running.some((r) => Math.abs(r.bbox[0] - x0) <= 2 && r.bbox[2] > x1);
    // The display it introduces: the row directly under it.
    const display = rest.filter((i) => !routing.lines[i].eqNumber);
    if (!display.length) return [];
    const top = box(display[0]);
    const next = display.filter((i) => Math.min(box(i)[3], top[3]) - Math.max(box(i)[1], top[1]) >= 0.5 * Math.min(box(i)[3] - box(i)[1], top[3] - top[1]));
    // A row that opens with a relation sign or an operator continues the top row: the top
    // row is the equation's first term, wrapped before it, unless it introduces the
    // display (":").
    const leftmost = [...next].sort((a, b) => box(a)[0] - box(b)[0])[0];
    const introduces = lines.some((l) => /:\s*$/u.test(l.text));
    if (!introduces && LEAD_IN_CONTINUES_RE.test(routing.lines[leftmost].text)) return [];
    // A rule between the two rows is a fraction bar: the top row is a numerator.
    const y0 = Math.max(...row.map((i) => box(i)[3])) - 1;
    const y1 = Math.min(...next.map((i) => box(i)[1])) + 1;
    const bar = (routing.rules ?? []).some((r) => r[1] >= y0 && r[3] <= y1 && Math.min(r[2], x1) - Math.max(r[0], x0) > 0);
    if (bar) return [];
    const below = Math.min(...next.map((i) => box(i)[0]));
    const em = Math.max(...lines.map((l) => l.size));
    return atMargin && below >= x0 + LEAD_IN_INDENT * em ? row : [];
}

/**
 * Words of text on a formula piece: tokens of three letters or more, other than the
 * names of mathematical operators ("log", "exp", "max") and variable names mixing
 * Greek and Latin letters ("εit"), on a piece set mostly outside math fonts (an
 * equation's variables are not words) and holding no LaTeX commands (an equation's
 * source kept in the text layer).
 */
function textWords(line: RegionLine): number {
    if (line.mathChars > FORMULA_TEXT_MATH * line.inkChars || LATEX_COMMAND_RE.test(line.text)) return 0;
    return line.text.split(/\s+/).filter((w) => TEXT_WORD_RE.test(w) && !MIXED_SCRIPT_RE.test(w) && !MATH_OPERATORS.has(w.replace(/[^\p{L}]/gu, "").toLowerCase())).length;
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
    /**
     * The line's text split at its gaps wider than a word space (`RegionLine.gaps`),
     * when there are any: the cells MuPDF may have set on one line.
     */
    segments?: { text: string; rect: Rect }[];
}

/**
 * `piece`'s text split at its gaps wider than a word space, from its source line's
 * character boxes; the whole piece when it has none.
 */
function pieceSegments(piece: RegionLine, source: RawLine | undefined): { text: string; rect: Rect }[] {
    const chars = (source as RawLineDetailed | undefined)?.chars;
    if (!piece.gaps?.length || !chars) return [{ text: piece.text, rect: piece.bbox }];
    const out: { text: string; rect: Rect }[] = [];
    let text = "";
    let rect: Rect | undefined;
    let prevRight = -Infinity;
    const flush = () => {
        if (rect && text.trim()) out.push({ text: text.trim(), rect });
        text = "";
        rect = undefined;
    };
    for (let i = piece.range[0]; i < Math.min(piece.range[1], chars.length); i++) {
        const c = chars[i];
        if (/\s/.test(c.c)) {
            text += c.c;
            continue;
        }
        const b = c.bbox;
        if (piece.gaps.some(([g0, g1]) => prevRight <= g0 + 0.01 && b.l >= g1 - 0.01)) flush();
        text += c.c;
        rect = rect ? [Math.min(rect[0], b.l), Math.min(rect[1], b.t), Math.max(rect[2], b.r), Math.max(rect[3], b.b)] : [b.l, b.t, b.r, b.b];
        prevRight = Math.max(prevRight, b.r);
    }
    flush();
    return out.length ? out : [{ text: piece.text, rect: piece.bbox }];
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
function readsAsTable(table: TableRows, leak: number, running = 0): boolean {
    if (leak >= TABLE_MAX_LEAK || table.listed) return false;
    // A table of running text must read row by row, not in fragments of its cells' sentences.
    // Rules between its rows separate them: each is whole, whatever case its cells start in.
    const rows = table.judged;
    if (!table.ruled && running >= TEXT_TABLE_RUNNING && fragmentRows(rows) > TEXT_TABLE_FRAGMENTS * rows.length) return false;

    if (!table.columns) return rows.every((row) => row.length === 1) && rows.length >= LIST_MIN_ROWS && leak < LIST_MAX_LEAK;
    const aligned = rows.filter((row) => row.length >= 2 && row.every((c) => c.column !== undefined)).length;
    return aligned >= TABLE_MIN_ALIGNED_ROWS * rows.length;
}

/** A table with at least this share of its text on running lines is a table of running text... */
const TEXT_TABLE_RUNNING = 0.25;
/** ...which reads row by row only while at most this share of its rows are fragments. */
const TEXT_TABLE_FRAGMENTS = 0.15;

/** Share of region `k`'s text (ink) on lines flagged as running text. */
function runningShare(k: number, routing: LineRouting, destination: readonly number[]): number {
    let all = 0;
    let running = 0;
    routing.lines.forEach((line, i) => {
        if (destination[i] !== k) return;
        all += line.inkChars;
        if (routing.flags[i] & LINE_RUNNING) running += line.inkChars;
    });
    return all ? running / all : 0;
}

/**
 * Rows that are fragments of the rows around them: every cell goes on with a sentence
 * (starts in lower case), as the wrapped lines of cells left as rows of their own do.
 */
function fragmentRows(rows: readonly RegionCell[][]): number {
    return rows.filter((row) =>
        row.every((cell) => {
            const first = /^[\p{Ps}\p{Pi}"'*]*(\p{L})/u.exec(cell.text.trimStart())?.[1];
            return !!first && first !== first.toUpperCase();
        }),
    ).length;
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
    const rows = table.judged;
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
        if (destination[i] !== -1 || routing.flags[i] & (LINE_CAPTION | LINE_FURNITURE | LINE_SKEWED | LINE_GUTTER | LINE_MARGIN)) return;
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

/**
 * Pieces of one cell, split at a justified line's wide word gaps, joined: in a row
 * left unaligned (`assignColumns`) whose pieces each stand in exactly one column, in
 * order, the pieces sharing a column are one cell. Rows otherwise stay as they are.
 */
function joinSplitCells(
    rows: FramedCell[][],
    assigned: { columns: number; of: (number | undefined)[][] },
): { columns: number; of: (number | undefined)[][]; framed: FramedCell[][] } {
    const { columns } = assigned;
    const framed = [...rows];
    const of = [...assigned.of];
    if (columns < 2) return { columns, of, framed };
    const spans = new Map<number, [number, number]>();
    rows.forEach((row, i) =>
        row.forEach(({ f }, k) => {
            const j = of[i][k];
            if (j === undefined) return;
            const span = spans.get(j);
            spans.set(j, span ? [Math.min(span[0], f[0]), Math.max(span[1], f[2])] : [f[0], f[2]]);
        }),
    );
    rows.forEach((row, i) => {
        if (of[i].every((j) => j !== undefined)) return;
        const hits = row.map(({ f }) => {
            const inside = [...spans].filter(([, [l, r]]) => Math.min(r, f[2]) > Math.max(l, f[0]));
            return inside.length === 1 ? inside[0][0] : -1;
        });
        if (!hits.every((j, k) => j >= 0 && (k === 0 || j >= hits[k - 1])) || new Set(hits).size === hits.length) return;
        const cells: FramedCell[] = [];
        const columnsOf: number[] = [];
        row.forEach((c, k) => {
            if (k === 0 || hits[k] !== hits[k - 1]) {
                cells.push(c);
                columnsOf.push(hits[k]);
                return;
            }
            const a = cells[cells.length - 1];
            const union = (x: Rect, y: Rect): Rect => [Math.min(x[0], y[0]), Math.min(x[1], y[1]), Math.max(x[2], y[2]), Math.max(x[3], y[3])];
            cells[cells.length - 1] = {
                cell: { ...a.cell, rect: union(a.cell.rect, c.cell.rect), text: `${a.cell.text} ${c.cell.text}`, size: Math.max(a.cell.size, c.cell.size) },
                f: union(a.f, c.f),
            };
        });
        framed[i] = cells;
        of[i] = columnsOf;
    });
    return { columns, of, framed };
}

/**
 * Cells of neighbouring columns that MuPDF set on one line, split: in a row left
 * unaligned, a cell standing in two columns or more whose pieces between its wide gaps
 * (`Cell.segments`) each stand in exactly one column becomes one cell per column, so
 * the gaps it splits at lie in the gutters between them, when each holds a word or a
 * number (not a letter of letter-spaced text). The row is then aligned anew.
 */
function splitJoinedCells(assigned: { columns: number; of: (number | undefined)[][]; framed: FramedCell[][] }): {
    columns: number;
    of: (number | undefined)[][];
    framed: FramedCell[][];
} {
    const { columns } = assigned;
    if (columns < 2) return assigned;
    const framed = [...assigned.framed];
    const of = [...assigned.of];
    const spans = new Map<number, [number, number]>();
    framed.forEach((row, i) => {
        if (!of[i].every((j) => j !== undefined)) return;
        row.forEach(({ f }, k) => {
            const j = of[i][k]!;
            const span = spans.get(j);
            spans.set(j, span ? [Math.min(span[0], f[0]), Math.max(span[1], f[2])] : [f[0], f[2]]);
        });
    });
    const rot = dominantRotation(framed.flat().map((c) => c.cell));
    const columnOf = (f: Rect): number => {
        const hits = [...spans].filter(([, [l, r]]) => Math.min(r, f[2]) > Math.max(l, f[0]));
        return hits.length === 1 ? hits[0][0] : -1;
    };
    framed.forEach((row, i) => {
        if (of[i].every((j) => j !== undefined)) return;
        let split = false;
        const cells = row.flatMap((c) => {
            if (!c.cell.segments || columnOf(c.f) !== -1) return [c];
            const parts = c.cell.segments.map((g) => ({ ...g, f: readingFrame(g.rect, rot) })).sort((a, b) => a.f[0] - b.f[0]);
            const placed = parts.map((g) => columnOf(g.f));
            if (placed.some((j) => j < 0) || new Set(placed).size < 2 || placed.some((j, k) => k > 0 && j < placed[k - 1])) return [c];
            const groups = [...new Set(placed)].map((j) => parts.filter((_, k) => placed[k] === j));
            // Cells hold words or numbers; single letters a gap apart are letter-spaced text.
            if (groups.some((mine) => mine.map((g) => g.text).join("").replace(/\s/gu, "").length < 2)) return [c];
            split = true;
            return groups.map((mine) => {
                const rect = mine.reduce<Rect>((u, g) => [Math.min(u[0], g.rect[0]), Math.min(u[1], g.rect[1]), Math.max(u[2], g.rect[2]), Math.max(u[3], g.rect[3])], [Infinity, Infinity, -Infinity, -Infinity]);
                const { lead: _lead, segments: _segments, ...rest } = c.cell;
                return { cell: { ...rest, rect, text: mine.map((g) => g.text).join(" ") }, f: readingFrame(rect, rot) };
            });
        });
        if (!split) return;
        const assignedTo = cells.map(({ f }) => columnOf(f));
        const ordered = assignedTo.every((j, k) => j >= 0 && (k === 0 || j > assignedTo[k - 1]));
        framed[i] = cells;
        of[i] = cells.map((_, k) => (ordered ? assignedTo[k] : undefined));
    });
    return { columns, of, framed };
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
/**
 * A line ending on a word or sign that leaves its phrase open ("of", "and", "×", a comma, a
 * spaced dash): the cell's text runs on to the next line, whatever case that starts in.
 * Lower case only: "OR" (an odds ratio) or "IN" (a state) end a label.
 */
const OPEN_END_RE = /(?:\s(?:and|or|of|in|the|with|for|to|by|vs\.|versus|per|at|on|from|among|into|between|than|via|without|within)|[×+&/,]|\s[–—-])$/u;
/** A value: a number with its sign, marks or a footnote letter, and no words. */
const VALUE_RE = /^[^\p{L}]*\p{N}[^\p{L}]*\p{L}?$/u;
/**
 * A statistic set under a value: a bracketed number or interval (a standard error, a t value,
 * a confidence interval, a percentage under its count), maybe with marks or a footnote letter.
 */
const SECONDARY_RE = /^[([][^\p{L}()[\]]*\p{N}[^\p{L}()[\]]*[)\]][^\p{L}\p{N}]*\p{L}?$/u;
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

/** `next` follows `above` at the spacing of a cell's lines (`WRAP_PITCH`, or the table's leading). */
function stacked(above: FramedCell, next: FramedCell, leading: number): boolean {
    const unit = lineUnit(above, next);
    const pitch = next.f[1] - above.f[1];
    return unit > 0 && pitch > 0 && pitch <= Math.max(WRAP_PITCH, WRAP_LEADING * Math.min(leading / unit, MAX_LEADING)) * unit;
}

/**
 * `next` is a statistic of the value `above` it (a standard error, a confidence interval):
 * a bracketed number set directly under a value, at a cell's line spacing.
 */
function secondary(above: FramedCell, next: FramedCell, leading: number): boolean {
    return SECONDARY_RE.test(next.cell.text.trim()) && VALUE_RE.test(above.cell.text.trim()) && stacked(above, next, leading);
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
 * "continues" a word broken at the line end, a bracket it left open, a phrase
 * left open (`OPEN_END_RE`: "Prop. Black ×", "District of"), or a full
 * line of running words
 * (the next word would not have fitted before `right`, the column's right
 * edge) when it starts in lower case; after a full line that ended a
 * sentence, a capital is "likely" the cell's next sentence. Any other lower-case start is "maybe":
 * a short line looks the same whether it wrapped or is one item of a list.
 * Any other start (a capital, a digit, a caseless script) "starts" a new
 * sentence or cell after a line that ended one, and otherwise "begins" a new
 * item: a list's entries end without a full stop. With `anyPitch`, lines
 * further apart than a cell's line spacing are judged too (lines of one ruled
 * band, set apart to centre them); without `openEnds`, an open phrase is no
 * evidence. A line `minWords` long is a full line of running words.
 */
function continuation(
    above: FramedCell,
    next: FramedCell,
    right: number,
    leading: number,
    { minWords = FULL_LINE_WORDS, anyPitch = false, openEnds = true }: { minWords?: number; anyPitch?: boolean; openEnds?: boolean } = {},
): Continuation {
    const a = above.f;
    const b = next.f;
    const unit = lineUnit(above, next);
    if (unit <= 0 || b[1] <= a[1] || (!anyPitch && !stacked(above, next, leading))) return "breaks";
    const indent = b[0] - a[0];
    const centred = Math.abs((b[0] + b[2]) / 2 - (a[0] + a[2]) / 2) <= WRAP_ALIGN * unit;
    if (!centred && (indent < -WRAP_ALIGN * unit || indent > WRAP_INDENT * unit)) return "breaks";
    const upper = above.cell.text.trimEnd();
    const lower = next.cell.text.trimStart();
    if (!WORD_RE.test(upper) || !/\p{L}/u.test(lower)) return "breaks";
    if (/\p{L}-$/u.test(upper) && /^\p{L}/u.test(lower)) return "continues";
    // A bracket left open runs on to the line that closes it.
    if (opensBracket(upper) && closesBracket(lower)) return "continues";
    if (openEnds && OPEN_END_RE.test(upper)) return "continues";
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
    /**
     * The rows as read without the column header, statistics and open phrases joined (the
     * plain reading of `tableRows`): whether a region reads as a table is judged on these
     * (`readsAsTable`, `tableLeak`), so those joins change how a table reads, not whether.
     */
    judged: RegionCell[][];
    columns?: number;
    lines: number;
    columnLines: Map<number, number>;
    /** The columns hold one list read down them, not rows read across (`listedDown`). */
    listed: boolean;
    /** Rules across the table separate each of its rows, in the plain reading (`joinRuledBands`). */
    ruled: boolean;
}

/** A table's row labels stand in the first column holding cells on at least this share of its lines. */
const LABEL_COLUMN_LINES = 0.3;
/** A table's column header has at most this many lines... */
const HEADER_MAX_LINES = 6;
/** ...and at most this share of the table's lines. */
const HEADER_MAX_SHARE = 0.5;
/** Header lines start right of most row labels (this share of them; a long one may reach further)... */
const HEADER_LABEL_QUANTILE = 0.9;
/** ...give or take this many points. */
const HEADER_LABEL_SLACK = 2;
/** A header line and the row under it overlapping by this share of the shorter one's height stand side by side. */
const HEADER_INTERLEAVE = 0.2;

/** The table's row-label column: the first column holding cells on `LABEL_COLUMN_LINES` of its lines. */
function labelColumn(of: readonly (number | undefined)[][]): number | undefined {
    const lines = new Map<number, number>();
    for (const cols of of) for (const j of new Set(cols)) if (j !== undefined) lines.set(j, (lines.get(j) ?? 0) + 1);
    return [...lines.keys()].sort((a, b) => a - b).find((j) => lines.get(j)! >= LABEL_COLUMN_LINES * of.length);
}

/**
 * The lines of a table's column header, as blocks of lines that read as one row: the lines
 * above its first row label, and the line of that label when it heads the label column (no
 * values, and the header's rule under it or `readWithAbove` it), when there are two or more and at most
 * `HEADER_MAX_LINES` and `HEADER_MAX_SHARE` of the table. Each line above the labels stands
 * right of them, over the values (a title or caption set across the labels is no header line),
 * and a rule across the table, label column included, between two of them starts a new block
 * (a rule under a header spanning some columns does not). A block of one line is an ordinary row.
 */
function headerBlocks(
    framed: FramedCell[][],
    of: readonly (number | undefined)[][],
    label: number | undefined,
    separators: readonly Rect[],
    readWithAbove: (i: number) => boolean,
): number[][] {
    if (label === undefined) return [];
    const first = of.findIndex((cols) => cols.includes(label));
    if (first < 1) return [];
    const ends = framed.flatMap((row, i) => row.filter((_, k) => of[i][k] === label).map((c) => c.f[2])).sort((a, b) => a - b);
    const labelsEnd = ends[Math.floor(HEADER_LABEL_QUANTILE * (ends.length - 1))];
    if (framed.slice(0, first).some((row) => row.some((c) => c.f[0] < labelsEnd - HEADER_LABEL_SLACK))) return [];
    const cells = framed.flat();
    const x0 = Math.min(...cells.map((c) => c.f[0]));
    const x1 = Math.max(...cells.map((c) => c.f[2]));
    const centre = (row: FramedCell[]) => (Math.min(...row.map((c) => c.f[1])) + Math.max(...row.map((c) => c.f[3]))) / 2;
    // A rule across the table, label column included, between line `i` and the next; a rule
    // drawn as one segment per column counts whole.
    const across = (i: number) => {
        if (i + 1 >= framed.length) return false;
        const between = separators.filter((r) => (r[1] + r[3]) / 2 > centre(framed[i]) && (r[1] + r[3]) / 2 < centre(framed[i + 1]));
        return between.some((r) => {
            const level = between.filter((o) => Math.abs((o[1] + o[3]) / 2 - (r[1] + r[3]) / 2) <= 1);
            let covered = 0;
            let end = x0;
            for (const [a, , b] of [...level].sort((p, q) => p[0] - q[0])) {
                covered += Math.max(0, Math.min(b, x1) - Math.max(a, end));
                end = Math.max(end, Math.min(b, x1));
            }
            return Math.min(...level.map((o) => o[0])) < labelsEnd && covered >= RULED_ROWS_SPAN * (x1 - x0);
        });
    };
    // The line of the first label ends the header when it holds no values and the rule under the
    // header runs under it, or the plain reading reads it with the line above: the label
    // column's own heading ("Characteristic | (n = 2074)").
    const heading =
        framed[first].every((c) => !VALUE_RE.test(c.cell.text.trim())) && ((!across(first - 1) && across(first)) || readWithAbove(first));
    const count = heading ? first + 1 : first;
    if (count < 2 || count > HEADER_MAX_LINES || count > HEADER_MAX_SHARE * framed.length) return [];
    const blocks: number[][] = [[0]];
    for (let i = 1; i < count; i++) {
        if (across(i - 1)) blocks.push([i]);
        else blocks[blocks.length - 1].push(i);
    }
    return blocks.filter((block) => block.length >= 2);
}

/**
 * One row of a header block's lines: a cell per column, its lines top to bottom ("Model" over
 * "(1)" reads "Model (1)"). A header spanning several columns is a cell of its own, with the
 * lines its text wraps onto, ahead of the columns' cells: a line that overlaps no single column,
 * or one ruled off from the lines below by a rule under it across two columns or more.
 */
function headerRow(
    framed: FramedCell[][],
    of: readonly (number | undefined)[][],
    block: readonly number[],
    separators: readonly Rect[],
): { lines: FramedCell[]; column?: number }[] {
    const spans = new Map<number, [number, number]>();
    framed.forEach((row, i) =>
        row.forEach(({ f }, k) => {
            const j = of[i][k];
            if (j === undefined || block.includes(i)) return;
            const span = spans.get(j);
            spans.set(j, span ? [Math.min(span[0], f[0]), Math.max(span[1], f[2])] : [f[0], f[2]]);
        }),
    );
    const byColumn = new Map<number, FramedCell[]>();
    const spanning: FramedCell[][] = [];
    const centre = (row: FramedCell[]) => (Math.min(...row.map((c) => c.f[1])) + Math.max(...row.map((c) => c.f[3]))) / 2;
    // A rule under the cell, above the block's next line, across two columns or more.
    const spansColumns = (cell: FramedCell, n: number) =>
        n + 1 < block.length &&
        separators.some((r) => {
            const y = (r[1] + r[3]) / 2;
            if (y <= centre(framed[block[n]]) || y >= centre(framed[block[n + 1]]) || Math.min(r[2], cell.f[2]) <= Math.max(r[0], cell.f[0])) return false;
            return [...spans.values()].filter(([l, h]) => Math.min(r[2], h) - Math.max(r[0], l) >= 0.5 * (h - l)).length >= 2;
        });
    for (const [n, i] of block.entries()) {
        framed[i].forEach((cell, k) => {
            const hits = [...spans].filter(([, [l, r]]) => Math.min(r, cell.f[2]) > Math.max(l, cell.f[0]));
            const j = spansColumns(cell, n) ? undefined : (of[i][k] ?? (hits.length === 1 ? hits[0][0] : undefined));
            if (j !== undefined) {
                byColumn.set(j, [...(byColumn.get(j) ?? []), cell]);
                return;
            }
            // A spanning header's next line wraps its text: it starts in lower case, or the
            // line above leaves a phrase or word open ("Model 1: Current" / "travel time").
            const over = spanning.find((lines) => {
                const last = lines[lines.length - 1];
                const upper = last.cell.text.trimEnd();
                const wraps = /^[\p{Ll}(]/u.test(cell.cell.text.trimStart()) || OPEN_END_RE.test(upper) || /\p{L}-$/u.test(upper);
                return wraps && Math.min(last.f[2], cell.f[2]) > Math.max(last.f[0], cell.f[0]);
            });
            if (over) over.push(cell);
            else spanning.push([cell]);
        });
    }
    return [
        ...spanning.map((lines) => ({ lines })),
        ...[...byColumn].sort((a, b) => a[0] - b[0]).map(([column, lines]) => ({ lines, column })),
    ];
}

/**
 * Table rows of whole cells. Visual lines are grouped into rows by height
 * (`groupRows`), and a cell's text may wrap over several of them: a visual
 * row whose cells continue the cells above them (`continuation`,
 * `joinsRowAbove`), with no rule drawn between them, joins the row above. So
 * does a line of statistics under its values (standard errors, intervals),
 * and the lines of the column header are one row (`headerBlocks`). Bands of a
 * table that rules its rows can join further (`joinRuledBands`).
 * Each cell's lines become one text, words broken at a line end joined as in
 * prose (`decideLineBreakHyphen`). Each row's cells carry their column when
 * the table has at least two and the row aligns to them.
 */
function tableRows(
    visual: FramedCell[][],
    rules: readonly Rect[],
    verticalRules: readonly Rect[],
    vocabulary?: ReadonlySet<string>,
): TableRows {
    const { columns, of, framed } = splitJoinedCells(joinSplitCells(visual, assignColumns(visual)));
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
            if (ka >= 0 && continuation(framed[i - 1][ka], cell, right.get(j!)!, leading, { openEnds: false }) === "continues") {
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

    // Logical rows: per cell, its lines top to bottom and its column. The full reading also
    // takes the column header as one row (`headerBlocks`), statistics with the values above
    // them, and lines going on from a phrase left open. Ruled bands are judged on the plain
    // reading (`joinRuledBands`): the rows the full one joins would hide steps that show a band
    // runs on.
    const label = columns >= 2 ? labelColumn(of) : undefined;
    const header = new Map<number, number[]>();
    const assemble = (full: boolean) => {
        const logical: { lines: FramedCell[]; column?: number }[][] = [];
        framed.forEach((row, i) => {
            const block = full ? header.get(i) : undefined;
            if (block) {
                if (i === block[0]) logical.push(headerRow(framed, of, block, separators));
                return;
            }
            const prev = i > 0 ? logical[logical.length - 1] : undefined;
            const above = i > 0 ? framed[i - 1] : undefined;
            if (prev && above && of[i].every((j) => j !== undefined) && of[i - 1].every((j) => j !== undefined)) {
                const targets = row.map((cell, k) => prev.find((c) => c.column === of[i][k]));
                const lasts = targets.map((t) => t?.lines[t.lines.length - 1]);
                const kinds = row.map((cell, k): Continuation => {
                    const last = lasts[k];
                    if (!last || !above.includes(last) || ruledBetween(last, cell)) return "breaks";
                    return continuation(last, cell, right.get(of[i][k]!)!, leading, { minWords: minWords(of[i][k]!), openEnds: full });
                });
                // Statistics set under the values above them (standard errors, intervals) belong to
                // their row, beside a label running on to this line ("Prop. Black ×" / "Boundary value").
                const statistic = (k: number) => {
                    const last = lasts[k];
                    return full && !!last && above.includes(last) && !ruledBetween(last, row[k]) && secondary(last, row[k], leading);
                };
                if (row.some((_, k) => statistic(k)) && row.every((_, k) => statistic(k) || kinds[k] === "continues")) {
                    row.forEach((cell, k) => targets[k]!.lines.push(cell));
                    return;
                }
                const ended = lasts.map((l) => !!l && SENTENCE_END_RE.test(l.cell.text.trimEnd()));
                // A row cannot start while a cell beside it runs on mid-sentence: a new list
                // item there is the next item of its own cell (lists set side by side in one row).
                const items =
                    kinds.includes("continues") &&
                    row.every((cell, k) => kinds[k] === "continues" || (!!lasts[k] && !ruledBetween(lasts[k]!, cell) && nextItem(lasts[k]!, cell, leading)));
                if (items || joinsRowAbove(kinds, of[i], ended, above.length, columns >= 2)) {
                    row.forEach((cell, k) => targets[k]!.lines.push(cell));
                    return;
                }
            }
            logical.push(row.map((cell, k) => ({ lines: [cell], column: of[i][k] })));
        });
        return logical;
    };
    const plain = assemble(false);
    const continues = (openEnds: boolean) => (above: FramedCell, next: FramedCell, j: number) =>
        continuation(above, next, right.get(j)!, leading, { minWords: minWords(j), openEnds });
    // The plain reading, for judging the region (`TableRows.judged`).
    const { rows: judged, ruled } =
        columns >= 2 ? joinRuledBands(plain, plain, framed, separators, continues(false), () => "breaks", label) : { rows: plain, ruled: false };
    const judgedRow = new Map<FramedCell, number>();
    judged.forEach((row, n) => row.forEach((c) => c.lines.forEach((l) => judgedRow.set(l, n))));
    // The plain reading reads line `i` in one row with the line above it.
    const readWithAbove = (i: number) => i > 0 && framed[i].some((a) => framed[i - 1].some((b) => judgedRow.get(a) === judgedRow.get(b)));
    for (const block of headerBlocks(framed, of, label, separators, readWithAbove)) {
        // A last line running on into the row under it (a table cut mid-row above its labels),
        // or set beside that row's label (a label centred on the lines of its record), is no
        // header.
        const last = framed[block[block.length - 1]];
        const under = framed[block[block.length - 1] + 1] ?? [];
        const runsInto = last.some((a) =>
            under.some((b) => b.f[0] < a.f[2] && b.f[2] > a.f[0] && continuation(a, b, Infinity, leading) === "continues"),
        );
        const beside = under.some((b) => last.some((a) => Math.min(a.f[3], b.f[3]) - Math.max(a.f[1], b.f[1]) > HEADER_INTERLEAVE * Math.min(a.f[3] - a.f[1], b.f[3] - b.f[1])));
        if (!runsInto && !beside) for (const i of block) header.set(i, block);
    }
    const logical = assemble(true);

    const { rows } =
        columns >= 2
            ? joinRuledBands(
                  logical,
                  plain,
                  framed,
                  separators,
                  continues(false),
                  (above, next, j) =>
                      SECONDARY_RE.test(next.cell.text.trim()) && VALUE_RE.test(above.cell.text.trim())
                          ? "secondary"
                          : continuation(above, next, right.get(j)!, leading, { minWords: minWords(j), anyPitch: true }),
                  label,
              )
            : { rows: logical };

    const multi = columns >= 2;
    const columnLines = new Map<number, number>();
    for (const cols of of) for (const j of new Set(cols)) if (j !== undefined) columnLines.set(j, (columnLines.get(j) ?? 0) + 1);
    return {
        lines: framed.length,
        columnLines,
        // Rules under every row make rows of it, however its columns happen to run.
        listed: !ruled && listedDown(framed),
        ruled,
        ...(multi ? { columns } : {}),
        rows: regionCells(rows, multi, vocabulary),
        judged: regionCells(judged, multi, vocabulary),
    };
}

/** Logical rows as cells: each cell's lines as one text; aligned rows keep their columns. */
function regionCells(rows: { lines: FramedCell[]; column?: number }[][], multi: boolean, vocabulary?: ReadonlySet<string>): RegionCell[][] {
    return rows.map((row) => {
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
    });
}

/** A table rules its rows when at least this many rules across it separate its lines. */
const RULED_ROWS_MIN = 3;
/** A rule inside a band divides a column when it spans at least this share of the column. */
const LOCAL_RULE_SPAN = 0.5;
/** A rule across a table spans at least this share of its width. */
const RULED_ROWS_SPAN = 0.6;
/** Bands of complete rows with no step either way, at least this many, make a table of sectioned records. */
const SECTION_BANDS = 2;

/**
 * Logical rows of a table that rules its rows (rules across it between many of its
 * lines), joined per ruled band: the lines between two rules are one row when their
 * cells run on from line to line (most steps down a column continue a cell, or start
 * its next sentence), as the wrapped cells of a text table do. A band of separate
 * values (one-line rows of numbers or items under a section rule) stays as it is. So is a
 * band whose later rows clearly go on with its first: no row label of their own (but the
 * label's next line), and the first column they fill goes on too (statistics under their
 * values, a cell's next line or sentence). A lower-case line alone is no such evidence: one-line
 * records read the same.
 * Bands are judged on the `plain` reading of the rows, and a band that joins reads as there;
 * the others keep the rows of `logical`, the full reading (`tableRows`), unless their rows
 * clearly go on (above).
 * `continues` judges a step down a column; `step` a step down a column between a band's lines,
 * however far apart, or tells a statistic under its value. `label` is the row-label column.
 * `ruled` tells whether
 * rules separate each row (every band reads as one row), not just the head and foot of the table.
 */
function joinRuledBands(
    logical: { lines: FramedCell[]; column?: number }[][],
    plain: { lines: FramedCell[]; column?: number }[][],
    framed: FramedCell[][],
    separators: readonly Rect[],
    continues: (above: FramedCell, next: FramedCell, column: number) => Continuation,
    step: (above: FramedCell, next: FramedCell, column: number) => Continuation | "secondary",
    label: number | undefined,
): { rows: { lines: FramedCell[]; column?: number }[][]; ruled: boolean } {
    const cells = framed.flat();
    if (!cells.length) return { rows: logical, ruled: false };
    const x0 = Math.min(...cells.map((c) => c.f[0]));
    const x1 = Math.max(...cells.map((c) => c.f[2]));
    const y0 = Math.min(...cells.map((c) => c.f[1]));
    const y1 = Math.max(...cells.map((c) => c.f[3]));
    // Rules drawn as one segment per column count together: what they cover of the table's width.
    const byLine = new Map<number, [number, number][]>();
    for (const r of separators) {
        const y = Math.round((r[1] + r[3]) / 2);
        const [a, b] = [Math.max(r[0], x0), Math.min(r[2], x1)];
        // A rule beside the table (another column's) covers none of it.
        if (y <= y0 || y >= y1 || b <= a) continue;
        byLine.set(y, [...(byLine.get(y) ?? []), [a, b]]);
    }
    const covered = (parts: [number, number][]) => {
        let total = 0;
        let end = -Infinity;
        for (const [a, b] of [...parts].sort((p, q) => p[0] - q[0])) {
            if (b <= end) continue;
            total += b - Math.max(a, end);
            end = b;
        }
        return total;
    };
    const cuts = [...byLine]
        .filter(([, parts]) => covered(parts) >= RULED_ROWS_SPAN * (x1 - x0))
        .map(([y]) => y)
        .sort((a, b) => a - b);
    const bands = cuts.filter((y, k) => k === 0 || y - cuts[k - 1] > 2);
    if (bands.length < RULED_ROWS_MIN) return { rows: logical, ruled: false };
    // Cells left unaligned (a row of fewer cells) take the column their lines overlap most.
    const spans = new Map<number, [number, number]>();
    for (const row of plain) {
        for (const c of row) {
            if (c.column === undefined) continue;
            const span = spans.get(c.column);
            const l = Math.min(...c.lines.map((x) => x.f[0]));
            const r = Math.max(...c.lines.map((x) => x.f[2]));
            spans.set(c.column, span ? [Math.min(span[0], l), Math.max(span[1], r)] : [l, r]);
        }
    }
    const columnOf = (c: { lines: FramedCell[]; column?: number }): number | undefined => {
        if (c.column !== undefined) return c.column;
        const l = Math.min(...c.lines.map((x) => x.f[0]));
        const r = Math.max(...c.lines.map((x) => x.f[2]));
        const hits = [...spans].filter(([, [a, b]]) => Math.min(b, r) > Math.max(a, l));
        return hits.length === 1 ? hits[0][0] : undefined;
    };
    // The column of each cell for judging and joining a band; rows left as they are keep theirs.
    const placed = new Map([...plain, ...logical].map((row) => [row, row.map((c) => ({ ...c, column: columnOf(c) }))]));
    const band = (row: { lines: FramedCell[] }[]) => {
        const cy = (row[0].lines[0].f[1] + row[0].lines[0].f[3]) / 2;
        return bands.filter((y) => y < cy).length;
    };
    // Rules inside a band that divide one column only: a cell boundary with no counterpart
    // in the other columns, whose text runs on across it (sections of a form side by side).
    const localRules = [...byLine]
        .filter(([y, parts]) => !cuts.includes(y) && covered(parts) < RULED_ROWS_SPAN * (x1 - x0))
        .flatMap(([y, parts]) => {
            const hits = [...spans].filter(([, [a, b]]) => parts.some(([l, r]) => Math.min(r, b) - Math.max(l, a) >= LOCAL_RULE_SPAN * (b - a)));
            return hits.length === 1 ? [{ y, column: hits[0][0] }] : [];
        });
    const sectioned = (cells: { lines: FramedCell[]; column?: number }[][]) =>
        localRules.some(({ y, column }) => {
            const lines = cells.flatMap((row) => row.filter((c) => c.column !== column).flatMap((c) => c.lines));
            return lines.some((l) => l.f[3] < y) && lines.some((l) => l.f[1] > y) && cells.flat().some((c) => c.column === column && c.lines.some((l) => l.f[1] > y));
        });
    // Rows of a band after its first that clearly go on with it: no row label but one running
    // on from the label above, a first value that goes on from the line above it, and no rule
    // of their own.
    const continuing = (cells: { lines: FramedCell[]; column?: number }[][]) => {
        if (cells.some((row) => row.some((c) => c.column === undefined))) return false;
        // A rule inside the band across two of its columns or more rules off a row of its own.
        const lines = cells.flat().flatMap((c) => c.lines);
        const top = Math.min(...lines.map((l) => l.f[1]));
        const bottom = Math.max(...lines.map((l) => l.f[3]));
        const divided = separators.some((r) => {
            const y = (r[1] + r[3]) / 2;
            return y > top && y < bottom && [...spans.values()].filter(([a, b]) => Math.min(r[2], b) - Math.max(r[0], a) >= LOCAL_RULE_SPAN * (b - a)).length >= 2;
        });
        if (divided) return false;
        const last = new Map<number, FramedCell>();
        for (const [n, row] of cells.entries()) {
            if (n > 0) {
                const sorted = [...row].sort((a, b) => a.column! - b.column!);
                const name = sorted.find((c) => c.column === label);
                const above = (c: { lines: FramedCell[]; column?: number }) => last.get(c.column!);
                if (name && (!above(name) || step(above(name)!, name.lines[0], name.column!) !== "continues")) return false;
                const lead = sorted.find((c) => c.column !== label);
                if (lead && (!above(lead) || !["continues", "likely", "secondary"].includes(step(above(lead)!, lead.lines[0], lead.column!)))) return false;
            }
            for (const c of row) for (const line of c.lines) last.set(c.column!, line);
        }
        return true;
    };
    // Each band's rows, in both readings. Bands whose rows of the plain reading a row of the
    // full reading joins (a header over a rule under its spanning cells) are one, read in full.
    const plainBand = new Map<FramedCell, number>();
    for (const row of plain) for (const c of row) for (const l of c.lines) plainBand.set(l, band(row));
    const merged = new Map<number, number>();
    for (const row of logical) {
        const ks = row.flatMap((c) => c.lines.map((l) => plainBand.get(l) ?? band(row)));
        for (let k = Math.min(...ks); k <= Math.max(...ks); k++) merged.set(k, Math.min(...ks, merged.get(k) ?? Infinity));
    }
    const banded = (rows: { lines: FramedCell[]; column?: number }[][]) => {
        const out = new Map<number, { lines: FramedCell[]; column?: number }[][]>();
        for (const row of rows) {
            const k = merged.get(band(row)) ?? band(row);
            out.set(k, [...(out.get(k) ?? []), row]);
        }
        return out;
    };
    const plainBands = banded(plain);
    const fullBands = banded(logical);
    const keys = [...plainBands.keys()].sort((a, b) => a - b);
    const crossed = (k: number) => [...merged].some(([j, m]) => m === k && j !== k);
    const groups = keys.map((k) => plainBands.get(k)!);
    const verdicts = groups.map((group, k) => (group.length > 1 && !crossed(keys[k]) ? runsOn(group.map((row) => placed.get(row)!), continues, spans.size) : false));
    // A band of complete rows that neither run on nor break is one row wrapped evenly in every
    // column, unless the table's bands repeat that shape: sections of one-line records.
    const records = verdicts.filter((v) => v === "unclear").length >= SECTION_BANDS;
    const out: { lines: FramedCell[]; column?: number }[][] = [];
    // Whether the rules separate each row: every band reads as one row.
    let separated = true;
    // A band's lines joined into one row, each column's lines top to bottom, whichever rows
    // they were first grouped in.
    const joined = (cells: { lines: FramedCell[]; column?: number }[][]) => {
        const byColumn = new Map<number, FramedCell[]>();
        for (const row of cells) for (const c of row) byColumn.set(c.column!, [...(byColumn.get(c.column!) ?? []), ...c.lines]);
        return [...byColumn].sort((a, b) => a[0] - b[0]).map(([column, lines]) => ({ lines: lines.sort((p, q) => p.f[1] - q.f[1]), column }));
    };
    groups.forEach((group, k) => {
        const cells = group.map((row) => placed.get(row)!);
        const full = fullBands.get(keys[k])!;
        const verdict = verdicts[k];
        if (group.length > 1 && (verdict === true || (verdict === "unclear" && !records) || sectioned(cells))) {
            out.push(joined(cells));
        } else if (full.length > 1 && continuing(full.map((row) => placed.get(row)!))) {
            out.push(joined(full.map((row) => placed.get(row)!)));
        } else {
            if (full.length > 1) separated = false;
            out.push(...full);
        }
    });
    return { rows: out, ruled: separated };
}

/**
 * Whether the rows of one ruled band run on: each cell has a column, and no step down a
 * column across the rows starts a new cell, or such steps are outweighed by steps that
 * continue one (clearly, when two of the rows fill every column). "unclear" when every
 * row fills every column of the table (`tableColumns`) and no step continues or breaks a
 * cell.
 */
function runsOn(
    group: { lines: FramedCell[]; column?: number }[][],
    continues: (above: FramedCell, next: FramedCell, column: number) => Continuation,
    tableColumns: number,
): boolean | "unclear" {
    if (group.some((row) => row.some((c) => c.column === undefined))) return false;
    let on = 0;
    let off = 0;
    // Steps across the rows' boundaries: a cell's first line under the last line of its
    // column in the rows above (steps within a cell are part of that row already).
    const last = new Map<number, FramedCell>();
    for (const row of group) {
        for (const c of row) {
            for (const [n, line] of c.lines.entries()) {
                const above = last.get(c.column!);
                if (above && n === 0) {
                    // A line running on (a broken word, a full line, the next sentence after a
                    // full line) joins its cell; a break or a new item does not; the rest says nothing.
                    const kind = continues(above, line, c.column!);
                    if (kind === "breaks" || kind === "begins") off++;
                    else if (kind === "continues" || kind === "likely") on++;
                }
                last.set(c.column!, line);
            }
        }
    }
    // Rows that each fill every column are rows of their own unless the cells clearly run on.
    const columns = new Set(group.flatMap((row) => row.map((c) => c.column)));
    const full = group.filter((row) => new Set(row.map((c) => c.column)).size === columns.size).length;
    // A cell wrapped over its lines leaves rows short of one of the table's columns. Rows that
    // all fill every column with no step either way are either one row wrapped evenly or
    // one-line records: the caller decides from the table's other bands.
    const complete = group.filter((row) => new Set(row.map((c) => c.column)).size >= tableColumns).length;
    if (off === 0) return on > 0 || complete < group.length || "unclear";
    return on > 0 && (full >= 2 ? on > off : on >= off);
}

/** A column takes part in the list test with at least this many entries. */
const LIST_MIN_ENTRIES = 4;
/** Numbered entries: at least this share of a column's entries. */
const LIST_KEYED = 0.8;
/** At least this share of a column's entries are distinct (an author can head several references). */
const LIST_DISTINCT = 0.5;
/** Read down the columns, at least this share of neighbouring entries are in order... */
const LIST_ORDERED_DOWN = 0.85;
/** ...and at most this share read across the rows. */
const LIST_ORDERED_ACROSS = 0.7;

/**
 * Whether the region's text is one ordered list set in columns (an index, a glossary,
 * a keyword or reference list) rather than rows: its entries, read down each column
 * and on into the next, are in alphabetical or numerical order (each column starting
 * after the one before ends), while read across the rows they are not. Columns are the spans of text between vertical gutters; a
 * column's entries are its lines, or under a hanging indent the lines at its left
 * edge. Every column of entries must take part: a column of values or repeated
 * categories beside them pairs records across the rows, as a table does. Such text
 * reads down the columns, as the prose does.
 */
function listedDown(framed: FramedCell[][]): boolean {
    const cells = framed.flatMap((row, i) => row.map((cell) => ({ row: i, cell })));
    const spans: [number, number][] = [];
    for (const { cell } of [...cells].sort((a, b) => a.cell.f[0] - b.cell.f[0])) {
        const last = spans[spans.length - 1];
        if (last && cell.f[0] < last[1]) last[1] = Math.max(last[1], cell.f[2]);
        else spans.push([cell.f[0], cell.f[2]]);
    }
    const entries: { row: number; column: number; key: string | number }[] = [];
    const ranges: [string | number, string | number][] = [];
    let columns = 0;
    let records = false;
    spans.forEach(([l, r], j) => {
        const inColumn = cells.filter((c) => c.cell.f[0] >= l && c.cell.f[2] <= r);
        const unit = Math.max(1, Math.min(...inColumn.map((c) => c.cell.cell.size)));
        const hanging = inColumn.some((c) => c.cell.f[0] - l > WRAP_ALIGN * unit);
        const heads = hanging ? inColumn.filter((c) => c.cell.f[0] - l <= WRAP_ALIGN * unit) : inColumn;
        const keyed = heads.map((c) => ({ row: c.row, column: j, key: entryKey(c.cell.cell.text) }));
        // Entries keyed by words, past any numbered ones among them; or numbered entries.
        const words = keyed.filter((e): e is { row: number; column: number; key: string } => typeof e.key === "string");
        const numbers = keyed.filter((e): e is { row: number; column: number; key: number } => typeof e.key === "number");
        const use = words.length >= LIST_MIN_ENTRIES ? words : numbers.length >= LIST_KEYED * heads.length ? numbers : [];
        // A list's entries differ; a column repeating a few values (a category, "Yes") is no list.
        if (use.length < LIST_MIN_ENTRIES || new Set(use.map((e) => e.key)).size < LIST_DISTINCT * use.length) {
            if (heads.length >= LIST_MIN_ENTRIES) records = true;
            return;
        }
        columns++;
        entries.push(...use);
        ranges.push([use[0].key, use[use.length - 1].key]);
    });
    if (columns < 2 || records || new Set(entries.map((e) => typeof e.key)).size !== 1) return false;
    // The list runs on from one column into the next: each column's first entry comes
    // after the last of the column before.
    if (ranges.some((r, j) => j > 0 && compareKeys(ranges[j - 1][1], r[0]) > 0)) return false;
    const across = [...entries].sort((a, b) => a.row - b.row || a.column - b.column);
    return ordered(entries) >= LIST_ORDERED_DOWN && ordered(across) <= LIST_ORDERED_ACROSS;
}

/**
 * An entry's sort key: the number of a numbered entry ("12.", "3)", "[3]"), or its
 * first word in lower case when it starts with one. Bare numbers (a table's values,
 * a year under a reference's authors) key nothing.
 */
function entryKey(text: string): string | number | undefined {
    const number = /^\s*(?:\[(\d{1,4})\]|\(?(\d{1,4})[.)])(?:\s|$)/.exec(text);
    if (number) return Number(number[1] ?? number[2]);
    const word = /^[\s"'“‘([]*(\p{L}+)/u.exec(text);
    return word ? word[1].toLocaleLowerCase() : undefined;
}

/** Order of two entry keys: numerically, or alphabetically. */
function compareKeys(a: string | number, b: string | number): number {
    return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
}

/** Share of neighbouring entries in ascending order. */
function ordered(entries: readonly { key: string | number }[]): number {
    let up = 0;
    for (let i = 1; i < entries.length; i++) if (compareKeys(entries[i - 1].key, entries[i].key) <= 0) up++;
    return entries.length > 1 ? up / (entries.length - 1) : 0;
}

/**
 * A list item's marker: a bullet, or a dash, number or letter (closed by "." or ")")
 * followed by a space (not a negative number or a decimal).
 */
const ITEM_MARKER_RE = /^\s*(?:[•●○◦▪■►▸‣∙·]\s*|(?:[–—-]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s+)\S/u;

/** `next` is the next item of a list after `above`, set at the list's line spacing. */
function nextItem(above: FramedCell, next: FramedCell, leading: number): boolean {
    return ITEM_MARKER_RE.test(next.cell.text) && stacked(above, next, leading);
}

/** The text leaves a round or square bracket open. */
function opensBracket(text: string): boolean {
    let depth = 0;
    for (const ch of text) {
        if (ch === "(" || ch === "[") depth++;
        else if ((ch === ")" || ch === "]") && depth > 0) depth--;
    }
    return depth > 0;
}

/** The text closes a bracket it did not open. */
function closesBracket(text: string): boolean {
    let depth = 0;
    for (const ch of text) {
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") {
            if (depth === 0) return true;
            depth--;
        }
    }
    return false;
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

/**
 * Region items as column detection laid them out (`ColumnDetectionResult.regionPieces`:
 * pieces as indices into the region's cells in reading order). A region split
 * into pieces becomes one item per piece, each keeping its cells' rows, with
 * their union as its box: an equation box that merged one equation from each
 * column becomes an equation in each column. Every piece is placed by its body
 * (`RegionItemDraft.anchor`), so a label in another column's margin, or a box
 * reaching past the text, does not move the equation out of its column.
 */
export function splitRegionItems(
    drafts: readonly RegionItemDraft[],
    pieces: readonly (readonly { members: readonly number[]; body: readonly number[] }[] | undefined)[] | undefined,
): RegionItemDraft[] {
    return drafts.flatMap((draft, k) => {
        const split = pieces?.[k];
        if (!split?.length) return [draft];
        const cells = draft.rows.flat();
        const index = new Map<RegionCell, number>(cells.map((cell, i) => [cell, i]));
        const union = (indices: readonly number[]) =>
            indices.map((i) => cells[i].bbox).reduce((u, b) => unionBBox(u, b));
        if (split.length === 1) return [{ ...draft, anchor: union(split[0].body) }];
        return split.map(({ members, body }) => {
            const keep = new Set(members);
            const rows = draft.rows
                .map((row) => row.filter((cell) => keep.has(index.get(cell)!)))
                .filter((row) => row.length > 0);
            return { ...draft, rows, bbox: union(members), anchor: union(body) };
        });
    });
}

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
 * it, else at the end. A table or figure never goes between a sentence and its
 * continuation in the next item; a display equation may, as it is part of the
 * sentence around it. Regions sharing a position keep reading order: one placed
 * after an item comes before one placed before the next item, then rows top to
 * bottom, left to right within a row. `sentences` is rebuilt from the items
 * (they share sentence objects); `renamed` maps old item ids to new ones.
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
        const box = upright(region.anchor ?? region.bbox);
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
        if (region.kind !== "formula") {
            while (position > 0 && position < items.length && continues(items[position - 1])) position++;
        }
        return { region, box, position, after, order };
    });
    // At one position, regions that close the preceding item's column come
    // before those that open the next item's column, then in rows: top to
    // bottom, and left to right within a row (side-by-side panels).
    placed.sort(
        (a, b) => a.position - b.position || Number(b.after) - Number(a.after) || a.box.t - b.box.t || a.order - b.order,
    );
    for (let start = 0; start < placed.length; ) {
        let end = start;
        while (end < placed.length && placed[end].position === placed[start].position && placed[end].after === placed[start].after) end++;
        placed.splice(start, end - start, ...inRows(placed.slice(start, end)));
        start = end;
    }

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

/**
 * Boxes sorted top to bottom, regrouped into rows read left to right: a box
 * joins the row of the box above it when it stands beside every box of the
 * row (no horizontal overlap) and overlaps the first by half the shorter
 * one's height. Stacked boxes stay top to bottom.
 */
function inRows<T extends { box: BoundingBox }>(sorted: readonly T[]): T[] {
    const rows: T[][] = [];
    for (const entry of sorted) {
        const row = rows[rows.length - 1];
        const first = row?.[0].box;
        const overlap = first ? Math.min(first.b, entry.box.b) - Math.max(first.t, entry.box.t) : 0;
        const beside = row?.every(({ box }) => box.r <= entry.box.l || entry.box.r <= box.l);
        if (row && beside && overlap >= 0.5 * Math.min(first!.b - first!.t, entry.box.b - entry.box.t)) row.push(entry);
        else rows.push([entry]);
    }
    return rows.flatMap((row) => [...row].sort((a, b) => a.box.l - b.box.l));
}

/** A row's text; an aligned row (one cell per column) leaves an empty slot for each missing column. */
function rowText(row: readonly RegionCell[], separator: string, columns?: number): string {
    if (!columns || row.length === columns || row.some((c) => c.column === undefined) || new Set(row.map((c) => c.column)).size < row.length) {
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
