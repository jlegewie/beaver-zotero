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
 */
import type { Rect } from "./geometry";
import { isCaptionLine, type RegionLine } from "./pageSignals";

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
 * is updated in place. Only upright lines are considered.
 */
export function completeTableRows(input: TableRowInput, routes: number[]): void {
    const { lines, running, caption } = input;
    const rules = joinRules(input.rules);
    const upright = lines.map((_, i) => i).filter((i) => !lines[i].rot);
    if (!upright.length) return;
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

    const tables = [...input.tables].sort(
        (a, b) => (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) - (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]),
    );
    for (const table of tables) {
        const routed = upright.filter((i) => routes[i] === table.index);
        if (routed.length < 3) continue;
        const lineHeight = median(routed.map((i) => height(lines[i].bbox)));
        // The table's rows and extent come from cells of ordinary height; a tall line
        // (a diagonal watermark's box) would stretch them over the page.
        const cells = routed.filter((i) => height(lines[i].bbox) <= TALL_LINE * lineHeight);
        if (cells.length < 3) continue;
        const rowCenters: number[] = [];
        for (const i of [...cells].sort((a, b) => centerY(lines[a].bbox) - centerY(lines[b].bbox))) {
            const cy = centerY(lines[i].bbox);
            if (!rowCenters.length || cy - rowCenters[rowCenters.length - 1] > 0.5 * lineHeight) rowCenters.push(cy);
        }
        const pitch = median(rowCenters.slice(1).map((c, k) => c - rowCenters[k])) || 1.5 * lineHeight;
        let top = Math.min(...cells.map((i) => lines[i].bbox[1]));
        let bottom = Math.max(...cells.map((i) => lines[i].bbox[3]));
        const cellLeft = Math.min(...cells.map((i) => lines[i].bbox[0]));
        const cellRight = Math.max(...cells.map((i) => lines[i].bbox[2]));
        let left = Math.min(cellLeft, table.bbox[0]);
        let right = Math.max(cellRight, table.bbox[2]);
        // A rule spanning paragraph text beside the table's rows (a page-wide rule over a
        // table in one column) is not one of the table's rules.
        const besideText = upright.filter((i) => {
            const b = lines[i].bbox;
            const cx = (b[0] + b[2]) / 2;
            return routes[i] !== table.index && centerY(b) > top && centerY(b) < bottom && (cx < cellLeft || cx > cellRight) && proseLine(i);
        });
        const own = rules.filter(
            (r) =>
                r[1] >= top - RULE_REACH * pitch &&
                r[3] <= bottom + RULE_REACH * pitch &&
                Math.min(r[2], cellRight) - Math.max(r[0], cellLeft) >= 0.5 * (cellRight - cellLeft) &&
                !besideText.some((i) => {
                    const b = lines[i].bbox;
                    return (b[0] + b[2]) / 2 > r[0] && (b[0] + b[2]) / 2 < r[2];
                }),
        );
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
            routes[i] === -1 && !isStart.get(i) && within(i) && height(lines[i].bbox) <= TALL_LINE * lineHeight;
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
        // The table's columns: spans of its cells that overlap horizontally.
        const columns: [number, number][] = [];
        for (const c of [...cells].sort((a, b) => lines[a].bbox[0] - lines[b].bbox[0])) {
            const [x0, , x1] = lines[c].bbox;
            const last = columns[columns.length - 1];
            if (last && x0 < last[1]) last[1] = Math.max(last[1], x1);
            else columns.push([x0, x1]);
        }
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
        for (const dir of [1, -1] as const) {
            // A ruled block with no lines is crossed only upward: above it, a header separator,
            // sit the column headers, which must align with the table's columns. Below the
            // table's bottom border come its notes, never more rows.
            let pastEmpty = false;
            for (;;) {
                const edge = dir > 0 ? bottom : top;
                // The next rule past the edge (each step moves the edge past a rule).
                const rule = spanning
                    .filter((r) => (dir > 0 ? r[3] > edge : r[1] < edge))
                    .sort((a, b) => (dir > 0 ? a[1] - b[1] : b[3] - a[3]))[0];
                if (!rule) break;
                const ruleY = dir > 0 ? Math.max(rule[1], edge) : Math.min(rule[3], edge);
                const block = upright
                    .filter((i) => within(i) && (dir > 0 ? centerY(lines[i].bbox) > edge && centerY(lines[i].bbox) < ruleY : centerY(lines[i].bbox) < edge && centerY(lines[i].bbox) > ruleY))
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
                    if (pastEmpty || dir > 0) break;
                    pastEmpty = true;
                    if (dir > 0) bottom = rule[3];
                    else top = rule[1];
                    continue;
                }
                // Rows hold several cells: the block's rows end at a line alone on its row
                // (a note under the last row), a caption, paragraph text or another region.
                const rowed = [...cells, ...joined];
                let taken = 0;
                for (; taken < block.length; taken++) {
                    const i = block[taken];
                    if (routes[i] !== -1 || isStart.get(i) || proseLine(i) || inParagraph(i)) break;
                    if (height(lines[i].bbox) > TALL_LINE * lineHeight) break;
                    if (pastEmpty && !overColumn(i)) break;
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
                    if (!mates.length || mates.some((j) => routes[j] !== -1 && routes[j] !== table.index)) break;
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
            }
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
            if (column.some((j) => proseLine(j)) || inParagraph(i)) continue;
            if (column.some((j) => running[j] && !isCell.has(j) && (centerY(lines[j].bbox) < top || centerY(lines[j].bbox) > bottom))) continue;
            if (!row) {
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
}
