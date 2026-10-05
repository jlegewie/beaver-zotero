/**
 * Table row completion: lines left in prose that belong to a table's rows.
 *
 * Routing keeps running text and captions in prose, and a table box can stop
 * short of the table. Each strands cells: a long row label reads as running
 * text, a label column set tight under the caption reads as the caption's
 * continuation, and rows below a box that ends early stay outside it. The
 * table's rows then carry bare values and their labels become stray sentences.
 *
 * A table's extent is the box around its routed cells, widened by the
 * horizontal rules that rule those cells: booktabs and grid rules span the
 * whole table, label column included. Within that extent:
 * - rows between the cells and the next rule of the table below (or above)
 *   join, unless that span holds a caption or a prose paragraph;
 * - a line sharing a row with the table's cells joins;
 * - a short band between the table's rows (a group header) joins.
 * A line never joins when it is part of a caption (one set beside the table
 * included), or of a paragraph: the lines stacked at its left edge include
 * prose (a running line nearly as wide as its text column, or a justified line
 * of words) or running text beyond the table's rows. Rules between lines
 * separate them, so a table's notes under its bottom rule stay out.
 *
 * A table framed by its own rules is bounded by them, and holds what stands in
 * its column grid between them however much it reads like prose (a text table's
 * definitions, a column of long labels), unless that text column runs on as the
 * page's paragraphs beyond the table. Lines its box took from beyond the frame
 * go back to their text column, and a fragment of the table that the detector cut
 * off at a band of text or at its ruled rows merges into it.
 */
import type { Rect } from "./geometry";
import { isCaptionLine, wideGaps, type RegionLine } from "./pageSignals";

/** Left edges within this many points are one edge. */
const EDGE_TOLERANCE = 2.5;
/** Lines are stacked when the gap between them is at most this many line heights. */
const STACK_GAP = 1.5;
/** A running line at least this share of its text column's width is paragraph text. */
const PARAGRAPH_WIDTH = 0.7;
/** A paragraph's first-line indent is at most this many line heights. */
const PARAGRAPH_INDENT = 3;
/** A cell taller than this many line heights is not a row of the table. */
const TALL_LINE = 3;
/** A line of words has at least this many real words. */
const MIN_PARAGRAPH_WORDS = 6;
/** Text columns are at least this share of the page's prose width. */
const MIN_COLUMN_WIDTH = 0.4;
/** A rule rules the table when it lies within this many row pitches of the table's rows. */
const RULE_REACH = 1;
/** A rule spanning at least this share of a table's width closes a block of its rows. */
const RULE_SPAN = 0.6;
/** Lines past the table's rows join only when no gap between them exceeds this many row pitches. */
const ROW_GAP = 3;
/** Rule segments this close (in points) are parts of one rule. */
const RULE_JOIN = 2;
/** A header aligns with its column within this many points. */
const COLUMN_ALIGN = 3;
/** A band between rows longer than this many lines is a paragraph, not a group header. */
const MAX_BAND_LINES = 2;
/** A rule through a line, past this share of its height from either edge, strikes it through... */
const STRUCK_MARGIN = 0.25;
/** ...and rules striking lines through this often are a pattern, no table's frame. */
const STRUCK_SHARE = 1 / 3;
/** A table's rules lie within this many line heights of its cells. */
const RULE_NEAR = 3;
/** A sentence ends: terminal punctuation, maybe followed by a closing quote or bracket. */
const SENTENCE_END_RE = /[.!?][\])"'”’]*$/u;
/** The span of most of a table's cells leaves out this share of their edges on each side. */
const CORE_QUANTILE = 0.1;
/** A table with at least this many rules of its own is framed by them. */
const FRAME_RULES = 2;
/** A framed table reaches at most this many line heights past its rules (a label column set outside them). */
const FRAME_REACH = 3;
/** Lines beyond a table's frame belong to a text column there when this many paragraph lines span them. */
const BEYOND_LINES = 2;
/** A list's marker: a number, letter or roman numeral with its punctuation, or a bullet. */
const LIST_MARKER_RE = /^(?:\(?(?:\d{1,4}|[a-zA-Z]|[ivxlcIVXLC]{1,6})[.):]?|[•●○◦▪■►▸‣∙·–—-])$/u;
/** A numbered list counts up by one for at least this share of its steps. */
const LIST_CONSECUTIVE = 0.7;
/** A column of the table's grid holds at least this many of its cells. */
const GRID_MIN_CELLS = 2;
/** A fragment repeating this many of a table's rows of words is a table of its own. */
const REPEATED_HEADER_ROWS = 2;
/** A table merges into another when at least this share of its cells stands in the other's grid. */
const MERGE_FIT = 0.8;
/** A table with at least this many rules spanning it between its rows may draw a rule under its last row too. */
const ROW_RULES = 2;
/** Rows past the rule under a table's rows are set in its type size, within this many points. */
const ROW_SIZE = 1;

export interface TableRowInput {
    lines: readonly RegionLine[];
    /** Per line: running text / caption text (`routeLines` keeps both in prose). */
    running: readonly boolean[];
    caption: readonly boolean[];
    /** Indexes and boxes of the page's table regions. */
    tables: readonly { index: number; bbox: Rect }[];
    /** Horizontal rules on the page. */
    rules: readonly Rect[];
}

const height = (r: Rect) => r[3] - r[1];
const centerY = (r: Rect) => (r[1] + r[3]) / 2;

function quantile(values: number[], q: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const median = (values: number[]) => quantile(values, 0.5);

/** Rules drawn as abutting segments (one per table column) joined into whole rules. */
function joinRules(rules: readonly Rect[]): Rect[] {
    const sorted = [...rules].sort((a, b) => centerY(a) - centerY(b) || a[0] - b[0]);
    const out: Rect[] = [];
    for (const r of sorted) {
        const prev = out.find((o) => Math.abs(centerY(o) - centerY(r)) <= RULE_JOIN && r[0] <= o[2] + RULE_JOIN && r[2] >= o[0] - RULE_JOIN);
        if (prev) {
            prev[0] = Math.min(prev[0], r[0]);
            prev[1] = Math.min(prev[1], r[1]);
            prev[2] = Math.max(prev[2], r[2]);
            prev[3] = Math.max(prev[3], r[3]);
        } else {
            out.push([...r]);
        }
    }
    return out;
}

/** Two lines share a row: they overlap for half the smaller height and not horizontally. */
function sameRow(a: Rect, b: Rect): boolean {
    const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    return overlap >= 0.5 * Math.min(height(a), height(b)) && (a[2] <= b[0] + 1 || b[2] <= a[0] + 1);
}

/**
 * Route prose lines that belong to a table's rows to that table (see the module
 * comment). `routes` holds the region index of each line, or -1 for prose, and
 * is updated in place. Only upright lines are considered. Returns the tables
 * merged into another, by index: their lines are routed to that table now.
 */
export function completeTableRows(input: TableRowInput, routes: number[]): Map<number, number> {
    const { lines, running, caption } = input;
    const rules = joinRules(input.rules);
    const upright = lines.map((_, i) => i).filter((i) => !lines[i].rot);
    if (!upright.length) return new Map();
    const startsCaption = upright.map((i) => caption[i] && isCaptionLine(lines[i]));
    const starts = upright.filter((_, k) => startsCaption[k]);
    // A caption's title can be set apart from its "Table 2" on the same line.
    const isStart = new Map(
        upright.map((i, k) => [
            i,
            startsCaption[k] || (caption[i] && starts.some((j) => sameRow(lines[i].bbox, lines[j].bbox))),
        ]),
    );
    // The line directly above (or below) one: the nearest that overlaps it horizontally.
    const neighbours = new Map<number, number>();
    const neighbour = (i: number, dir: -1 | 1): number => {
        const key = dir * (i + 1);
        const cached = neighbours.get(key);
        if (cached !== undefined) return cached;
        const b = lines[i].bbox;
        let best = -1;
        let bestGap = Infinity;
        for (const j of upright) {
            if (j === i) continue;
            const o = lines[j].bbox;
            if (Math.min(o[2], b[2]) <= Math.max(o[0], b[0])) continue;
            // Stacked, not on one row: at most half a line of vertical overlap.
            const gap = dir < 0 ? b[1] - o[3] : o[1] - b[3];
            if (dir * (centerY(o) - centerY(b)) <= 0 || gap < -0.5 * height(b) || gap >= bestGap) continue;
            best = j;
            bestGap = gap;
        }
        neighbours.set(key, best);
        return best;
    };
    // A rule between two stacked lines separates them (a table's bottom rule above its notes).
    const ruledBetween = (a: Rect, b: Rect): boolean => {
        // Line boxes can overlap the rule between them, so take the span between their centres.
        const [y0, y1] = centerY(a) < centerY(b) ? [centerY(a), centerY(b)] : [centerY(b), centerY(a)];
        const x = (Math.max(a[0], b[0]) + Math.min(a[2], b[2])) / 2;
        return rules.some((r) => r[0] <= x && r[2] >= x && centerY(r) > y0 && centerY(r) < y1);
    };
    // Paragraph text: a running line nearly as wide as the prose lines that share its left
    // edge (its text column), and not narrow for the page's prose (a column of long
    // labels). Widths come from running lines that are not a table's row labels (within
    // the span of its routed cells, on a row with them), so that long labels do not set
    // them. A box reaching into the next column does not make that column's prose labels.
    const cellSpans = input.tables.flatMap((t) => {
        const cells = upright.filter((c) => routes[c] === t.index);
        if (!cells.length) return [];
        const l = Math.min(...cells.map((c) => lines[c].bbox[0]));
        const r = Math.max(...cells.map((c) => lines[c].bbox[2]));
        return [{ cells, l, r }];
    });
    const rowLabel = (i: number) =>
        cellSpans.some(({ cells, l, r }) => {
            const b = lines[i].bbox;
            const cx = (b[0] + b[2]) / 2;
            return cx >= l && cx <= r && cells.some((c) => sameRow(b, lines[c].bbox));
        });
    const runningLines = upright.filter((i) => running[i] && !rowLabel(i));
    // A running line stacked on another, with no rule between: a paragraph's line.
    const stackedRunning = (i: number) =>
        ([-1, 1] as const).some((dir) => {
            const j = neighbour(i, dir);
            if (j < 0 || !running[j]) return false;
            const a = lines[i].bbox;
            const b = lines[j].bbox;
            const gap = dir < 0 ? a[1] - b[3] : b[1] - a[3];
            return gap <= STACK_GAP * Math.max(height(a), height(b)) && !ruledBetween(a, b);
        });
    const widthOf = (i: number) => lines[i].bbox[2] - lines[i].bbox[0];
    const pageWidth = quantile(runningLines.map(widthOf), 0.75);
    const paragraphWidth = new Map<number, boolean>();
    const columnWide = (i: number): boolean => {
        let v = paragraphWidth.get(i);
        if (v === undefined) {
            const x = lines[i].bbox[0];
            const columnWidth = quantile(
                runningLines.filter((j) => Math.abs(lines[j].bbox[0] - x) <= EDGE_TOLERANCE).map(widthOf),
                0.75,
            );
            // No prose at that edge: no text column to belong to.
            v = columnWidth > 0 && widthOf(i) >= PARAGRAPH_WIDTH * columnWidth && widthOf(i) >= MIN_COLUMN_WIDTH * pageWidth;
            paragraphWidth.set(i, v);
        }
        return v;
    };
    const paragraphLine = (i: number): boolean => running[i] && columnWide(i);
    // Prose, whether or not the running-text flags caught it: paragraph text, or a wide
    // line of words justified with the line above or below it (row labels are ragged).
    const proseLine = (i: number): boolean =>
        paragraphLine(i) ||
        (lines[i].alphaWords >= MIN_PARAGRAPH_WORDS &&
            widthOf(i) >= MIN_COLUMN_WIDTH * pageWidth &&
            ([-1, 1] as const).some((dir) => {
                const j = neighbour(i, dir);
                if (j < 0) return false;
                const a = lines[i].bbox;
                const b = lines[j].bbox;
                const gap = dir < 0 ? a[1] - b[3] : b[1] - a[3];
                return (
                    Math.abs(a[0] - b[0]) <= EDGE_TOLERANCE &&
                    Math.abs(a[2] - b[2]) <= EDGE_TOLERANCE &&
                    gap <= STACK_GAP * Math.max(height(a), height(b))
                );
            }));

    // A line set directly above or below a paragraph, within its span: the paragraph's
    // indented first line or its short last line. The paragraph is two prose lines or
    // more, or the line is itself running text (a two-line paragraph).
    const inParagraph = (i: number): boolean =>
        ([-1, 1] as const).some((dir) => {
            const j = neighbour(i, dir);
            if (j < 0 || !proseLine(j)) return false;
            const k = neighbour(j, dir);
            if (!running[i] && (k < 0 || !proseLine(k))) return false;
            const a = lines[i].bbox;
            const b = lines[j].bbox;
            const gap = dir < 0 ? a[1] - b[3] : b[1] - a[3];
            return (
                gap <= STACK_GAP * Math.max(height(a), height(b)) &&
                // Within the span, give or take the paragraph's first-line indent.
                a[0] >= b[0] - PARAGRAPH_INDENT * height(b) &&
                a[2] <= b[2] + EDGE_TOLERANCE &&
                !ruledBetween(a, b)
            );
        });
    // Lines stacked at a line's left edge (a column of labels, or a paragraph), top to
    // bottom, and the caption starts that end the stack.
    const stack = (i: number): { column: number[]; captions: number[] } => {
        const above: number[] = [];
        const below: number[] = [];
        const captions: number[] = [];
        for (const dir of [-1, 1] as const) {
            const out = dir < 0 ? above : below;
            let cur = i;
            for (;;) {
                const next = neighbour(cur, dir);
                if (next < 0) break;
                const a = lines[cur].bbox;
                const b = lines[next].bbox;
                const gap = dir < 0 ? a[1] - b[3] : b[1] - a[3];
                if (gap > STACK_GAP * Math.max(height(a), height(b)) || ruledBetween(a, b)) break;
                // A caption directly above or below ends the stack, aligned or not (a
                // side caption set flush right).
                if (isStart.get(next)) {
                    captions.push(next);
                    break;
                }
                if (Math.abs(a[0] - b[0]) > EDGE_TOLERANCE) break;
                out.push(next);
                cur = next;
            }
        }
        return { column: [...above.reverse(), i, ...below], captions: [...captions, ...captionChain(i)] };
    };
    // The caption start a caption-flagged line continues: reached through stacked caption
    // lines whatever their alignment (a centred or flush-right side caption).
    function captionChain(i: number): number[] {
        if (!caption[i]) return [];
        const found: number[] = [];
        for (const dir of [-1, 1] as const) {
            let cur = i;
            for (;;) {
                const next = neighbour(cur, dir);
                if (next < 0 || !caption[next]) break;
                const a = lines[cur].bbox;
                const b = lines[next].bbox;
                const gap = dir < 0 ? a[1] - b[3] : b[1] - a[3];
                if (gap > STACK_GAP * Math.max(height(a), height(b)) || ruledBetween(a, b)) break;
                if (isStart.get(next)) {
                    found.push(next);
                    break;
                }
                cur = next;
            }
        }
        return found;
    }

    // A line's horizontal spans between its gaps wider than a word space.
    const segments = (i: number): [number, number][] => {
        const out: [number, number][] = [];
        let start = lines[i].bbox[0];
        for (const [g0, g1] of [...wideGaps(lines[i])].sort((a, b) => a[0] - b[0])) {
            out.push([start, g0]);
            start = g1;
        }
        out.push([start, lines[i].bbox[2]]);
        return out;
    };
    // Another line set on the row of lines `i` and `j`, between them.
    const runningBetween = (i: number, j: number): boolean => {
        const a = lines[i].bbox;
        const b = lines[j].bbox;
        return upright.some((k) => k !== i && k !== j && sameRow(a, lines[k].bbox) && lines[k].bbox[0] >= a[2] - EDGE_TOLERANCE && lines[k].bbox[2] <= b[0] + EDGE_TOLERANCE);
    };

    const merged = new Map<number, number>();
    const tables = [...input.tables].sort(
        (a, b) => (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) - (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]),
    );
    // A table's cells, the span of its rows and its own rules: those near its rows that
    // span most of its cells, not ones spanning paragraph text beside them (a page-wide
    // rule over a table in one column).
    const tableFrame = (index: number) => {
        const routed = upright.filter((i) => routes[i] === index);
        if (routed.length < 3) return undefined;
        const lineHeight = median(routed.map((i) => height(lines[i].bbox)));
        // The table's rows and extent come from cells of ordinary height; a tall line
        // (a diagonal watermark's box) would stretch them over the page.
        const cells = routed.filter((i) => height(lines[i].bbox) <= TALL_LINE * lineHeight);
        if (cells.length < 3) return undefined;
        const rowCenters: number[] = [];
        for (const i of [...cells].sort((a, b) => centerY(lines[a].bbox) - centerY(lines[b].bbox))) {
            const cy = centerY(lines[i].bbox);
            if (!rowCenters.length || cy - rowCenters[rowCenters.length - 1] > 0.5 * lineHeight) rowCenters.push(cy);
        }
        const pitch = median(rowCenters.slice(1).map((c, k) => c - rowCenters[k])) || 1.5 * lineHeight;
        const top = Math.min(...cells.map((i) => lines[i].bbox[1]));
        const bottom = Math.max(...cells.map((i) => lines[i].bbox[3]));
        const cellLeft = Math.min(...cells.map((i) => lines[i].bbox[0]));
        const cellRight = Math.max(...cells.map((i) => lines[i].bbox[2]));
        // The span of most cells: a few stray lines the box took beside the table do not widen it.
        const coreLeft = quantile(cells.map((i) => lines[i].bbox[0]), CORE_QUANTILE);
        const coreRight = quantile(cells.map((i) => lines[i].bbox[2]), 1 - CORE_QUANTILE);
        const besideText = upright.filter((i) => {
            const b = lines[i].bbox;
            const cx = (b[0] + b[2]) / 2;
            return routes[i] !== index && centerY(b) > top && centerY(b) < bottom && (cx < cellLeft || cx > cellRight) && proseLine(i);
        });
        const own = rules.filter(
            (r) =>
                r[1] >= top - RULE_REACH * pitch &&
                r[3] <= bottom + RULE_REACH * pitch &&
                Math.min(r[2], coreRight) - Math.max(r[0], coreLeft) >= 0.5 * (coreRight - coreLeft) &&
                !besideText.some((i) => {
                    const b = lines[i].bbox;
                    return (b[0] + b[2]) / 2 > r[0] && (b[0] + b[2]) / 2 < r[2];
                }),
        );
        // The frame: the span of the table's own rules, with the segments of each drawn in
        // line with it within the table's box (a rule broken at the column gaps). A table's
        // rules run between its lines; lines struck through (a hatched background) frame nothing.
        const struck = (r: Rect) =>
            upright.some((i) => {
                const b = lines[i].bbox;
                const y = centerY(r);
                return Math.min(r[2], b[2]) > Math.max(r[0], b[0]) && y > b[1] + STRUCK_MARGIN * height(b) && y < b[3] - STRUCK_MARGIN * height(b);
            });
        const box = input.tables.find((t) => t.index === index)!.bbox;
        const left = Math.min(box[0], cellLeft) - EDGE_TOLERANCE;
        const right = Math.max(box[2], cellRight) + EDGE_TOLERANCE;
        const inLine = rules.filter((r) => r[0] >= left && r[2] <= right && own.some((o) => Math.abs(centerY(o) - centerY(r)) <= RULE_JOIN));
        // Segments extend the frame across the table's column gaps, not across a page gutter
        // to a rule drawn level with one of them (a fraction bar in the next column).
        let span: [number, number] = [Math.min(...own.map((r) => r[0])), Math.max(...own.map((r) => r[2]))];
        for (let grown = own.length > 0; grown; ) {
            grown = false;
            for (const r of inLine) {
                if (r[0] >= span[0] && r[2] <= span[1]) continue;
                if (r[0] > span[1] + FRAME_REACH * lineHeight || r[2] < span[0] - FRAME_REACH * lineHeight) continue;
                span = [Math.min(span[0], r[0]), Math.max(span[1], r[2])];
                grown = true;
            }
        }
        const crossing = own.filter(struck).length;
        const frame: [number, number] | undefined =
            own.length - crossing >= FRAME_RULES && crossing < STRUCK_SHARE * own.length ? span : undefined;
        return { cells, lineHeight, pitch, top, bottom, cellLeft, cellRight, coreLeft, coreRight, own, frame };
    };
    // A table framed by its own rules ends at the frame: lines its box took from a text
    // column beyond the rules go back to that column, which paragraphs show (running
    // lines set wholly beyond the frame, two or more spanning the line). So do the markers
    // of a list there, set before their entries under a hanging indent: each opens a
    // running line on its row in its type size, and numbered ones count up by one.
    // Lines a frame returned to the text column beyond it; no table takes them back.
    const beyondFrame = new Set<number>();
    // A line the box took from beside the table, wholly outside the span of most of its
    // cells, that ends a sentence of the paragraph set directly above it (at its left edge,
    // within its width; not a caption) goes back to that paragraph when its text column
    // runs on beyond the table's rows and no rule of the table spans it: a page
    // paragraph's last line beside a table.
    for (const table of input.tables) {
        const cells = upright.filter((i) => routes[i] === table.index);
        if (cells.length < 3) continue;
        const coreLeft = quantile(cells.map((i) => lines[i].bbox[0]), CORE_QUANTILE);
        const coreRight = quantile(cells.map((i) => lines[i].bbox[2]), 1 - CORE_QUANTILE);
        const cellsTop = Math.min(...cells.map((i) => lines[i].bbox[1]));
        const cellsBottom = Math.max(...cells.map((i) => lines[i].bbox[3]));
        for (const i of cells) {
            const b = lines[i].bbox;
            if (b[0] < coreRight && b[2] > coreLeft) continue;
            const j = neighbour(i, -1);
            if (j < 0 || !running[j] || caption[j] || routes[j] !== -1) continue;
            const a = lines[j].bbox;
            // The page's paragraph: its text column runs on above or below the table's rows
            // (a table column of running text ends with the table).
            const pageColumn = upright.some(
                (k) => running[k] && Math.abs(lines[k].bbox[0] - a[0]) <= EDGE_TOLERANCE && (lines[k].bbox[3] < cellsTop || lines[k].bbox[1] > cellsBottom),
            );
            // A rule of the table drawn across both its cells and the line puts the line inside it.
            const ruledIn = rules.some(
                (r) => r[1] >= cellsTop - RULE_NEAR * height(b) && r[3] <= cellsBottom + RULE_NEAR * height(b) && r[0] <= coreLeft + EDGE_TOLERANCE && r[2] >= b[2] - EDGE_TOLERANCE,
            );
            if (!pageColumn || ruledIn) continue;
            if (
                Math.abs(a[0] - b[0]) <= EDGE_TOLERANCE &&
                b[2] <= a[2] + EDGE_TOLERANCE &&
                b[1] - a[3] <= STACK_GAP * height(a) &&
                !SENTENCE_END_RE.test(lines[j].text.trimEnd())
            ) {
                routes[i] = -1;
                beyondFrame.add(i);
            }
        }
    }
    for (const table of input.tables) {
        const found = tableFrame(table.index);
        if (!found?.frame) continue;
        const [l, r] = found.frame;
        const outside = (j: number) => lines[j].bbox[0] >= r - EDGE_TOLERANCE || lines[j].bbox[2] <= l + EDGE_TOLERANCE;
        // Running text wholly beyond the frame is none of the table's row labels.
        const runningBeyond = upright.filter((j) => running[j] && outside(j));
        const outsideCells = found.cells.filter((i) => {
            const b = lines[i].bbox;
            return !(b[0] < r + EDGE_TOLERANCE && b[2] > l - EDGE_TOLERANCE);
        });
        const markers = outsideCells.filter(
            (i) =>
                LIST_MARKER_RE.test(lines[i].text.trim()) &&
                runningBeyond.some(
                    (j) =>
                        lines[j].bbox[0] >= lines[i].bbox[2] - EDGE_TOLERANCE &&
                        sameRow(lines[i].bbox, lines[j].bbox) &&
                        Math.abs(lines[j].size - lines[i].size) <= 1 &&
                        !runningBetween(i, j),
                ),
        );
        const numbers = markers
            .map((i) => ({ y: lines[i].bbox[1], n: /^\d+/.exec(lines[i].text.trim())?.[0] }))
            .filter((m) => m.n !== undefined)
            .sort((a, b) => a.y - b.y)
            .map((m) => Number(m.n));
        const counted = numbers.length < 2 || numbers.slice(1).filter((n, k) => n === numbers[k] + 1).length >= LIST_CONSECUTIVE * (numbers.length - 1);
        for (const i of outsideCells) {
            const b = lines[i].bbox;
            const spanning = runningBeyond.filter((j) => b[0] >= lines[j].bbox[0] - EDGE_TOLERANCE && b[2] <= lines[j].bbox[2] + EDGE_TOLERANCE);
            if (spanning.length >= BEYOND_LINES || (counted && markers.includes(i))) {
                routes[i] = -1;
                beyondFrame.add(i);
            }
        }
    }

    for (const table of tables) {
        const frame = tableFrame(table.index);
        if (!frame) continue;
        const { cells, lineHeight, pitch, cellLeft, cellRight, coreLeft, coreRight, own } = frame;
        let { top, bottom } = frame;
        // The table reaches as far as its box or its rules; a frame of rules bounds it, give
        // or take a label column set a little outside the rules.
        const framed = frame.frame !== undefined;
        const reach = FRAME_REACH * lineHeight;
        let left = Math.min(cellLeft, frame.frame ? Math.max(table.bbox[0], frame.frame[0] - reach) : table.bbox[0]);
        let right = Math.max(cellRight, frame.frame ? Math.min(table.bbox[2], frame.frame[1] + reach) : table.bbox[2]);
        for (const r of own) {
            left = Math.min(left, r[0]);
            right = Math.max(right, r[2]);
        }
        const within = (i: number) => {
            const b = lines[i].bbox;
            const cx = (b[0] + b[2]) / 2;
            return cx >= left && cx <= right && b[0] >= left - EDGE_TOLERANCE && b[2] <= right + EDGE_TOLERANCE;
        };
        // A tall line (a diagonal watermark's box) is never a row of the table.
        const free = (i: number) =>
            routes[i] === -1 && !isStart.get(i) && !beyondFrame.has(i) && within(i) && height(lines[i].bbox) <= TALL_LINE * lineHeight;
        // A caption starting beside the table's rows (or on its header row), not above or
        // below them, is set at the table's side: the lines under it are that caption.
        const tableTop = top;
        const sideCaption = (captions: number[], onRow: (j: number) => boolean) =>
            captions.some(
                (j) => onRow(j) || (centerY(lines[j].bbox) > tableTop - 0.5 * lineHeight && centerY(lines[j].bbox) < bottom),
            );

        // Ruled blocks of rows past the cells, below and above.
        const spanning = rules.filter((r) => Math.min(r[2], right) - Math.max(r[0], left) >= RULE_SPAN * (right - left));
        const joined: number[] = [];
        // The table's columns: spans of its cells that overlap horizontally. A line split
        // at gaps wider than a word space spans its pieces, so cells of two columns set on
        // one line do not join the columns.
        const columns: [number, number][] = [];
        for (const [x0, x1] of cells.flatMap(segments).sort((a, b) => a[0] - b[0])) {
            const last = columns[columns.length - 1];
            if (last && x0 < last[1]) last[1] = Math.max(last[1], x1);
            else columns.push([x0, x1]);
        }
        // A table framed by its own rules (two or more: top and bottom, or a header rule and
        // the bottom) holds the text in its column grid between them, however much a cell
        // reads like a paragraph: a long row label, a definition set as justified or centred
        // text. The grid's columns are the spans its cells set: two cells or more, or a cell
        // of its first row beside two others (a column header); a single column (a framed
        // listing) is no grid. Text stands in the column nearest its centre when it reaches
        // into no other (cells are set flush left, centred or ragged in their column). The
        // frame bounds the grid: a box reaching past the rules into the next text column
        // takes nothing there.
        const [frameLeft, frameRight] = frame.frame ?? [left, right];
        const headTop = Math.min(...cells.map((c) => centerY(lines[c].bbox)));
        const fullRow = (c: number) =>
            centerY(lines[c].bbox) - headTop < 0.5 * lineHeight &&
            cells.filter((o) => o !== c && sameRow(lines[c].bbox, lines[o].bbox)).length >= 2;
        const gridColumns = columns.filter(([l, r]) => {
            const inside = cells.filter((c) => lines[c].bbox[0] >= l && lines[c].bbox[2] <= r);
            return inside.length >= GRID_MIN_CELLS || inside.some(fullRow);
        });
        // The grid column a span of text stands in, or -1.
        const spanColumn = ([x0, x1]: [number, number]): number => {
            const cx = (x0 + x1) / 2;
            let k = 0;
            while (k + 1 < gridColumns.length && cx > (gridColumns[k][0] + gridColumns[k][1] + gridColumns[k + 1][0] + gridColumns[k + 1][1]) / 4) k++;
            const crosses = gridColumns.some(([l, r], m) => m !== k && Math.min(r, x1) > Math.max(l, x0));
            return crosses ? -1 : k;
        };
        // The grid column of a line (its first, for cells of neighbouring columns set on one
        // line and split at the gutters between them), or -1.
        const gridColumn = (i: number): number => {
            const [x0, , x1] = lines[i].bbox;
            // The grid stands within its frame and most of its cells (a stray line the box
            // took beside the table does not widen it).
            if (!framed || gridColumns.length < 2 || x0 < Math.min(frameLeft, coreLeft) - EDGE_TOLERANCE || x1 > Math.max(frameRight, coreRight) + EDGE_TOLERANCE) return -1;
            const whole = spanColumn([x0, x1]);
            if (whole >= 0) return whole;
            const placed = segments(i).map(spanColumn);
            return placed.every((k, m) => k >= 0 && (m === 0 || k >= placed[m - 1])) ? placed[0] : -1;
        };
        // A paragraph in a grid column (its lines stacked in that column) set beside cells
        // of the grid's other columns is a cell too, however far the rows found so far reach.
        // Cells beside a paragraph can be centred on it, so they share its span rather than
        // one of its lines.
        const tableParagraph = new Map<number, boolean>();
        const inTableParagraph = (j: number): boolean => {
            let v = tableParagraph.get(j);
            if (v === undefined) {
                const column = gridColumn(j);
                let y0 = lines[j].bbox[1];
                let y1 = lines[j].bbox[3];
                for (const dir of [-1, 1] as const) {
                    for (let cur = j; ; ) {
                        const next = neighbour(cur, dir);
                        if (next < 0 || gridColumn(next) !== column) break;
                        const a = lines[cur].bbox;
                        const b = lines[next].bbox;
                        const gap = dir < 0 ? a[1] - b[3] : b[1] - a[3];
                        if (gap > STACK_GAP * Math.max(height(a), height(b)) || ruledBetween(a, b)) break;
                        y0 = Math.min(y0, b[1]);
                        y1 = Math.max(y1, b[3]);
                        cur = next;
                    }
                }
                v =
                    column >= 0 &&
                    upright.some((o) => {
                        const b = lines[o].bbox;
                        return !running[o] && Math.min(y1, b[3]) - Math.max(y0, b[1]) >= 0.5 * height(b) && gridColumn(o) >= 0 && gridColumn(o) !== column;
                    });
                tableParagraph.set(j, v);
            }
            return v;
        };
        // Paragraph text of the page: lines of a paragraph (running lines stacked on another,
        // not a heading or band alone) beyond the table's rows, at the line's left edge, that
        // it is nearly as wide as.
        const bodyText = (i: number): boolean =>
            runningLines.some((j) => {
                const cy = centerY(lines[j].bbox);
                return (
                    j !== i &&
                    (cy < top - lineHeight || cy > bottom + lineHeight) &&
                    Math.abs(lines[j].bbox[0] - lines[i].bbox[0]) <= EDGE_TOLERANCE &&
                    widthOf(i) >= PARAGRAPH_WIDTH * widthOf(j) &&
                    stackedRunning(j) &&
                    !inTableParagraph(j)
                );
            });
        // A line set directly under or over a paragraph line of the page (its short last
        // line, a heading over it) belongs to that paragraph, not to the grid.
        const paragraphTail = (i: number): boolean =>
            ([-1, 1] as const).some((dir) => {
                const j = neighbour(i, dir);
                if (j < 0 || !running[j] || !bodyText(j)) return false;
                const a = lines[i].bbox;
                const b = lines[j].bbox;
                const gap = dir < 0 ? a[1] - b[3] : b[1] - a[3];
                return gap <= STACK_GAP * Math.max(height(a), height(b)) && !ruledBetween(a, b);
            });
        // Per line, while the table's extent stays put (a merge or a block moves it).
        let gridCache = new Map<number, boolean>();
        let cachedFor = "";
        const gridText = (i: number): boolean => {
            const key = `${top}:${bottom}`;
            if (key !== cachedFor) {
                gridCache = new Map();
                cachedFor = key;
            }
            let v = gridCache.get(i);
            if (v === undefined) {
                v = gridColumn(i) >= 0 && !bodyText(i) && !paragraphTail(i);
                gridCache.set(i, v);
            }
            return v;
        };
        // A line directly under (or, going up, over) one of `cellsSoFar` in its grid column.
        const continuesCell = (i: number, cellsSoFar: readonly number[], dir: 1 | -1): boolean => {
            const j = neighbour(i, -dir as 1 | -1);
            if (j < 0 || !cellsSoFar.includes(j) || gridColumn(j) !== gridColumn(i)) return false;
            const a = lines[i].bbox;
            const b = lines[j].bbox;
            const gap = dir > 0 ? a[1] - b[3] : b[1] - a[3];
            return gap <= STACK_GAP * Math.max(height(a), height(b)) && !ruledBetween(a, b);
        };
        // Another table whose cells stand in this table's grid, in two of its columns or
        // more, is a part of it that its rows continue into (a table cut at a band of
        // running text, or at its ruled rows).
        const mergeable = (k: number): boolean => {
            if (k < 0 || k === table.index || merged.has(k) || !input.tables.some((t) => t.index === k)) return false;
            const theirs = upright.filter((i) => routes[i] === k);
            const placed = theirs.map(gridColumn);
            if (
                !theirs.length ||
                placed.filter((c) => c >= 0).length < MERGE_FIT * theirs.length ||
                new Set(placed.filter((c) => c >= 0)).size < 2
            ) {
                return false;
            }
            // Directly above or below this table's rows, with nothing but text of its grid
            // between them (a caption or a paragraph between two tables keeps them apart).
            const between = betweenFragment(theirs);
            if (!between) return false;
            const [inside, reaching, owned] = between;
            // Another region between them (an equation, a figure) keeps them apart, as text does.
            if (owned.length) return false;
            if (inside.some((i) => !gridText(i) || isStart.get(i) || captionChain(i).length > 0)) return false;
            // A caption or paragraph set wider than the table stands between its fragments too;
            // a row wider than the table's estimated sides does not.
            if (reaching.some((i) => caption[i] || running[i])) return false;
            // A fragment that opens with this table's header is a table of its own.
            return !repeatsHeader(theirs);
        };
        // The lines between this table's rows and another fragment of it: free ones within its
        // sides, free ones reaching past them, and those of other regions. Undefined when the
        // fragment is not directly above or below the rows.
        const betweenFragment = (theirs: readonly number[]): [number[], number[], number[]] | undefined => {
            const otherTop = Math.min(...theirs.map((i) => lines[i].bbox[1]));
            const otherBottom = Math.max(...theirs.map((i) => lines[i].bbox[3]));
            const [from, to] = otherTop >= bottom - 1 ? [bottom, otherTop] : otherBottom <= top + 1 ? [otherBottom, top] : [NaN, NaN];
            if (!(to - from <= ROW_GAP * pitch)) return undefined;
            const across = upright.filter(
                (i) => !beyondFrame.has(i) && lines[i].bbox[0] < right && lines[i].bbox[2] > left && centerY(lines[i].bbox) > from && centerY(lines[i].bbox) < to,
            );
            const free = across.filter((i) => routes[i] === -1);
            const fragment = routes[theirs[0]];
            const owned = across.filter((i) => routes[i] >= 0 && routes[i] !== table.index && routes[i] !== fragment);
            return [free.filter(within), free.filter((i) => !within(i)), owned];
        };
        // The texts of the first row of `group`, against this table's first row.
        const firstRow = (group: readonly number[]): string[] => {
            const head = Math.min(...group.map((i) => centerY(lines[i].bbox)));
            return group.filter((i) => centerY(lines[i].bbox) - head < 0.5 * lineHeight).map((i) => lines[i].text.trim().toLowerCase());
        };
        // The rows of words in `group` (rows holding two cells of words or more), as texts.
        const wordRows = (group: readonly number[]): Map<string, number> => {
            const out = new Map<string, number>();
            const sorted = [...group].sort((a, b) => centerY(lines[a].bbox) - centerY(lines[b].bbox));
            for (let k = 0; k < sorted.length; ) {
                const row = [sorted[k]];
                while (++k < sorted.length && centerY(lines[sorted[k]].bbox) - centerY(lines[row[0]].bbox) < 0.5 * lineHeight) row.push(sorted[k]);
                const words = row.filter((i) => /\p{L}{2,}/u.test(lines[i].text)).length;
                if (words < 2) continue;
                const text = row
                    .sort((a, b) => lines[a].bbox[0] - lines[b].bbox[0])
                    .map((i) => lines[i].text.trim().toLowerCase())
                    .join(" | ");
                out.set(text, words);
            }
            return out;
        };
        const ownHead = new Set(firstRow([...cells, ...joined]));
        const ownRows = wordRows([...cells, ...joined]);
        // A table has one header: a fragment that opens with this table's first row, or
        // repeats a block of its rows of words further down (a multi-row header under a
        // diagram's labels), is a table of its own.
        const repeatsHeader = (group: readonly number[]): boolean => {
            const head = firstRow(group);
            if (head.filter((t) => ownHead.has(t)).length >= Math.max(2, 0.5 * head.length)) return true;
            return [...wordRows(group).keys()].filter((text) => ownRows.has(text)).length >= REPEATED_HEADER_ROWS;
        };
        const merge = (k: number) => {
            merged.set(k, table.index);
            const between = betweenFragment(upright.filter((i) => routes[i] === k))?.[0] ?? [];
            for (const i of upright) {
                if (routes[i] !== k && !between.includes(i)) continue;
                routes[i] = table.index;
                joined.push(i);
                top = Math.min(top, lines[i].bbox[1]);
                bottom = Math.max(bottom, lines[i].bbox[3]);
            }
        };
        // Set over one of the table's columns: aligned with it on the left, centre or right,
        // as a column header is. A note's fragment overlaps a column only by chance.
        const overColumn = (i: number) => {
            const [x0, , x1] = lines[i].bbox;
            return columns.some(
                ([l, r]) =>
                    Math.min(r, x1) > Math.max(l, x0) &&
                    (Math.abs(x0 - l) <= COLUMN_ALIGN || Math.abs(x1 - r) <= COLUMN_ALIGN || Math.abs((x0 + x1) / 2 - (l + r) / 2) <= COLUMN_ALIGN),
            );
        };
        // A fragment of this table directly above or below its rows (nothing between them)
        // merges into it.
        for (let found = true; found; ) {
            found = false;
            for (const other of input.tables) {
                if (!mergeable(other.index)) continue;
                merge(other.index);
                found = true;
            }
        }
        // A table with rules between its rows (at least ROW_RULES, not just one under its header)
        // may draw one under the last row found so far too, so that rule need not be the table's
        // bottom border: rows its box missed can follow below it. This does not tell missed rows
        // from text under a true bottom border; the checks on each line below the rule decide.
        // The rows found above can show the rules only after the walk up, so the walk down then
        // runs again.
        const rowRuled = () =>
            spanning.filter((r) => centerY(r) > top + RULE_JOIN && centerY(r) < bottom - RULE_JOIN).length >= ROW_RULES;
        const cellSize = median(cells.map((i) => lines[i].size));
        let heldBelow = false;
        for (const [pass, dir] of ([1, -1, 1] as const).entries()) {
            if (pass === 2 && !(heldBelow && rowRuled())) break;
            // A ruled block with no lines is crossed only upward: above it, a header separator,
            // sit the column headers, which must align with the table's columns. Below the
            // table's bottom border come its notes, never more rows; only the rule directly
            // under the rows of a table with rules between its rows is crossed downward.
            let pastEmpty = false;
            // The first block past the cells, before any rule, may continue their last row.
            let first = true;
            // The table's bottom before it crossed the rule under its rows, and its joined lines then.
            let crossed: { bottom: number; joined: number } | undefined;
            for (;;) {
                const edge = dir > 0 ? bottom : top;
                // The next rule past the edge (each step moves the edge past a rule).
                const rule = spanning
                    .filter((r) => (dir > 0 ? r[3] > edge : r[1] < edge))
                    .sort((a, b) => (dir > 0 ? a[1] - b[1] : b[3] - a[3]))[0];
                if (!rule) break;
                const ruleY = dir > 0 ? Math.max(rule[1], edge) : Math.min(rule[3], edge);
                const block = upright
                    .filter((i) => within(i) && !beyondFrame.has(i) && (dir > 0 ? centerY(lines[i].bbox) > edge && centerY(lines[i].bbox) < ruleY : centerY(lines[i].bbox) < edge && centerY(lines[i].bbox) > ruleY))
                    .sort((a, b) => dir * (lines[a].bbox[1] - lines[b].bbox[1]));
                // Rows are dense: the block starts and ends near the table, without wide gaps.
                let reach = edge;
                let dense = true;
                for (const i of block) {
                    const b = lines[i].bbox;
                    if ((dir > 0 ? b[1] - reach : reach - b[3]) > ROW_GAP * pitch) dense = false;
                    reach = dir > 0 ? Math.max(reach, b[3]) : Math.min(reach, b[1]);
                }
                if (!dense || (dir > 0 ? ruleY - reach : reach - ruleY) > ROW_GAP * pitch) break;
                if (!block.length) {
                    if (dir > 0 && first) {
                        // Nothing at all between the rows and the rule: a caption or paragraph set
                        // wider than the table there is no part of the block, yet ends the table.
                        const clear = !upright.some((i) => {
                            const b = lines[i].bbox;
                            return b[0] < right && b[2] > left && centerY(b) > edge && centerY(b) < ruleY;
                        });
                        if (clear && rowRuled()) {
                            crossed = { bottom, joined: joined.length };
                            bottom = rule[3];
                            first = false;
                            continue;
                        }
                        heldBelow = pass === 0;
                    }
                    if (pastEmpty || dir > 0) break;
                    pastEmpty = true;
                    first = false;
                    if (dir > 0) bottom = rule[3];
                    else top = rule[1];
                    continue;
                }
                // Rows hold several cells: the block's rows end at a line alone on its row
                // (a note under the last row), a caption, paragraph text or another region.
                for (const k of new Set(block.map((i) => routes[i]))) if (mergeable(k)) merge(k);
                const rowed = [...cells, ...joined];
                let taken = 0;
                for (; taken < block.length; taken++) {
                    const i = block[taken];
                    if (routes[i] === table.index) continue;
                    if (routes[i] !== -1 || isStart.get(i)) break;
                    const text = gridText(i);
                    if (!text && (proseLine(i) || inParagraph(i))) break;
                    if (height(lines[i].bbox) > TALL_LINE * lineHeight) break;
                    if (pastEmpty && !overColumn(i)) break;
                    // Past the rule under the table's rows, rows are set in the table's type size
                    // (a section heading under the table's bottom border is not).
                    if (crossed && Math.abs(lines[i].size - cellSize) > ROW_SIZE) break;
                    // Caption text, above the table or beside it, ends the block.
                    if (captionChain(i).length) break;
                    // Its row-mates are this table's or free; a row shared with another region is not this table's.
                    // Cells are a column gap apart; fragments of one sentence (text and inline
                    // math) are a word space apart.
                    const mates = [...rowed, ...block].filter(
                        (j) =>
                            j !== i &&
                            sameRow(lines[i].bbox, lines[j].bbox) &&
                            Math.max(lines[j].bbox[0] - lines[i].bbox[2], lines[i].bbox[0] - lines[j].bbox[2]) >= lineHeight,
                    );
                    if (mates.some((j) => routes[j] !== -1 && routes[j] !== table.index)) break;
                    // A line alone on its row continues a cell when it stands in the grid
                    // under (or over) a line of that cell in its column.
                    if (!mates.length && !(text && (first || continuesCell(i, rowed, dir) || inTableParagraph(i)))) break;
                    rowed.push(i);
                }
                // A row is taken whole: lines on the row of the line that ended the block go too.
                const stop = block[taken];
                const kept = block
                    .slice(0, taken)
                    .filter((i) => stop === undefined || !sameRow(lines[i].bbox, lines[stop].bbox));
                joined.push(...kept);
                if (taken < block.length) {
                    for (const i of kept) {
                        if (dir > 0) bottom = Math.max(bottom, lines[i].bbox[3]);
                        else top = Math.min(top, lines[i].bbox[1]);
                    }
                    break;
                }
                if (dir > 0) bottom = rule[3];
                else top = rule[1];
                first = false;
            }
            // No rows past the rule under the table's rows: that rule was its bottom border after all.
            if (crossed && joined.length === crossed.joined) bottom = crossed.bottom;
        }
        for (const i of joined) routes[i] = table.index;

        // Lines on the table's rows, and short bands between them.
        const rowCells = [...cells, ...joined];
        const isCell = new Set(rowCells);
        const onRow = (i: number) => rowCells.some((c) => sameRow(lines[i].bbox, lines[c].bbox));
        // Horizontal distance from a line to the nearest of `others` on its row.
        const rowGap = (i: number, others: (j: number) => boolean): number => {
            const b = lines[i].bbox;
            let best = Infinity;
            for (const j of upright) {
                if (j === i || !others(j) || !sameRow(b, lines[j].bbox)) continue;
                best = Math.min(best, Math.max(lines[j].bbox[0] - b[2], b[0] - lines[j].bbox[2]));
            }
            return best;
        };
        const accepted: number[] = [];
        for (const i of upright) {
            if (!free(i)) continue;
            const cy = centerY(lines[i].bbox);
            const row = onRow(i);
            if (!row && (cy <= top || cy >= bottom)) continue;
            // A row shared with another region's cells belongs to the region nearer on it
            // (the next table's label column inside this table's box).
            if (row && rowGap(i, (j) => routes[j] >= 0 && routes[j] !== table.index) < rowGap(i, (j) => isCell.has(j))) continue;
            const { column, captions } = stack(i);
            if (sideCaption(captions, onRow)) continue;
            // Caption text continuing a caption start with no rule between (a table's top
            // rule separates its caption from a label column set under it).
            if (captionChain(i).length) continue;
            // Text in a framed table's grid is a cell, on a row or wrapped between rows.
            const text = gridText(i) && column.every((j) => isCell.has(j) || gridText(j));
            if (!text && (column.some((j) => proseLine(j)) || inParagraph(i))) continue;
            if (column.some((j) => running[j] && !isCell.has(j) && (centerY(lines[j].bbox) < top || centerY(lines[j].bbox) > bottom))) continue;
            if (!row && !text) {
                // The band: the lines around this one that are on none of the table's rows.
                const at = column.indexOf(i);
                const inBand = (j: number) => !isCell.has(j) && !onRow(j);
                let a = at;
                let b = at;
                while (a > 0 && inBand(column[a - 1])) a--;
                while (b < column.length - 1 && inBand(column[b + 1])) b++;
                if (b - a + 1 > MAX_BAND_LINES) continue;
            }
            accepted.push(i);
        }
        for (const i of accepted) routes[i] = table.index;
    }
    return merged;
}
