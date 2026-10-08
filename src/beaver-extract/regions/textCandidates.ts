/**
 * Text-cluster candidates: groups of text lines that are not running text —
 * table bodies, display equations, figure labels, lists of numbers. Graphics
 * clusters miss both tables without rules and equations set as text, so these
 * are generated from line geometry alone and classified like any candidate.
 *
 * Lines join when they are stacked closely (overlapping horizontally) or sit
 * on one row within a column. A group holding several equation numbers is
 * split into one group per number: each number marks its own formula. A
 * parenthesized number in a table layout (a standard error under its
 * coefficient) is a table cell, not an equation number.
 */
import { UnionFind } from "./cluster";
import { hgap, overlapFrac, unionRect, vgap, type Rect } from "./geometry";
import { NUMERIC_RE, inkSizeOf, isProse, type Primitive, type RegionLine } from "./pageSignals";

/** Stacked lines join across at most this many body sizes of vertical space. */
const STACK_GAP = 1.0;
/** Same-row lines always join within this many body sizes. */
const ROW_GAP_NEAR = 3;
/** Same-row lines join up to this share of the page width apart when no column gutter lies between. */
const ROW_GAP_FAR = 0.45;
/** Groups this close (in body sizes) that share column edges merge (table header and body). */
const ALIGNED_GAP = 3;
/** Column edges within this many points are shared. */
const EDGE_TOLERANCE = 3;
/** Relation signs that start a separate equation on a new row. */
const RELATION_RE = /[=≤≥<>≈≡∝≠≃≅∼]/;
/** A row opening with a relation (":=" included) continues the row above. */
const LEADING_RELATION_RE = /^(?::=|[=≤≥<>≈≡∝≠≃≅∼])/;
/** A number, maybe signed, in scientific notation, or a percentage: "1.25", "−3", "1.2e−3", "1.2 × 10⁻³", "12%". */
const VALUE = String.raw`[−–-]?(?:\d[\d.,]*|\.\d+)(?:\s*[eE][−–+-]?\d+|\s*[×x·]\s*10[⁻⁺]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+|\s*[×x·]\s*10\^?[−–+-]?\d+)?\s*%?`;
/** A unit; one letter only as an SI symbol, so that "2 x" stays a term of an equation. */
const UNIT = String.raw`(?:[%‰]|°\s*[CFK]?|[gmsKLVAWJNT]|[A-Za-zµμΩ][A-Za-zµμΩ/·²³\d]{1,7})`;
/**
 * A measurement: a value, maybe given as a bound or with its uncertainty, maybe with a
 * unit ("1.25 kg", "<0.05", "≥ 10 kg", "5 ± 2", "5 ± 2 kg", "0.4 +/- 0.1", "37 °C").
 */
const MEASURE_RE = new RegExp(String.raw`^\s*(?:[<>≤≥]\s*)?${VALUE}(?:\s*(?:±|∓|\+\s*/\s*[−–-])\s*${VALUE})?\s*${UNIT}?\s*$`, "u");
/** A numeric table cell such as "0.45", "−1.2***" or "12,345". */
const NUMBER_CELL_RE = /^[−–-]?(?:\d[\d.,]*|\.\d+)[*†‡]*$/;
/** A bare integer of up to four digits: a manuscript line number, or a table value. */
const BARE_INTEGER_RE = /^\d{1,4}$/;
/** Rules this close (in body sizes) above or below a group join it (table rules). */
const RULE_REACH = 0.8;

export interface TextGroup {
    bbox: Rect;
    lines: RegionLine[];
}

/** A line of words: at least four real words, a third of its tokens, and not mostly math. */
function isWordy(l: RegionLine): boolean {
    return !l.rot && !l.eqNumber && l.alphaWords >= 4 && l.alphaWords >= 0.3 * l.words && l.mathChars < 0.5 * l.inkChars;
}

/**
 * Running text: prose lines of words, or wide lines of words at any size (notes,
 * footnotes). A structured-text line split at one wide gap (justified prose, a
 * manuscript line number) is judged as a whole; lines split into more pieces are
 * rows of cells and judged piece by piece.
 */
export function runningTextLines(lines: readonly RegionLine[], bs: number): Set<RegionLine> {
    const units: RegionLine[] = [];
    const bySource = new Map<number, RegionLine[]>();
    for (const l of lines) {
        if (l.pieces === 2) {
            const parts = bySource.get(l.source);
            if (parts) parts.push(l);
            else bySource.set(l.source, [l]);
        } else {
            units.push(l);
        }
    }
    const members = new Map<RegionLine, RegionLine[]>();
    for (const parts of bySource.values()) {
        const whole = joinPieces(parts);
        units.push(whole);
        members.set(whole, parts);
    }
    const prose = units.filter((l) => isWordy(l) && isProse(l, bs));
    const widths = prose.map((l) => l.bbox[2] - l.bbox[0]).sort((a, b) => a - b);
    const proseWidth = widths.length ? widths[Math.floor(widths.length / 2)] : Infinity;
    const proseSet = new Set(prose);
    const justified = justifiedParagraphs(units);
    const running = new Set<RegionLine>();
    for (const l of units) {
        if (!proseSet.has(l) && !justified.has(l) && !(isWordy(l) && l.bbox[2] - l.bbox[0] >= 0.7 * proseWidth)) continue;
        for (const piece of members.get(l) ?? [l]) running.add(piece);
    }
    extendParagraphs(lines, running, bs);
    return running;
}

/** Justified edges agree within this many em (hyphens and kerning shift them a little). */
const JUSTIFY_TOLERANCE = 0.25;
/** A justified paragraph has at least this many lines sharing both edges. */
const JUSTIFIED_LINES = 3;
/** Stacked lines of a paragraph are at most this many line heights apart. */
const PARAGRAPH_LEADING = 0.8;
/** Inline math on a prose line's row sits at most this many body sizes from its words. */
const INLINE_GAP = 0.6;
/** ...and is set at most this many times the line's type size. */
const INLINE_SIZE = 1.5;
/** A text column runs through a row when running lines within this many body sizes above and below span it. */
const COLUMN_REACH = 8;
/** A table of symbols beside measurements shows its row pattern on at least this many rows. */
const SYMBOL_TABLE_ROWS = 3;
/** Lines of one text column start within this many body sizes of each other (a paragraph indent). */
const COLUMN_INDENT = 2.5;
/** A line that ends a sentence (or a clause before a display: "…, yielding:"). */
const SENTENCE_END_RE = /[.!?][\])"'”’]*$/u;
const CLAUSE_END_RE = /[.!?:;,][\])"'”’]*$/u;

/**
 * A line of ordinary words: several words, most of them made of letters, not
 * mostly math and without a relation sign (aligned display equations share
 * both edges too, in a math font or not).
 */
function isTextLine(l: RegionLine): boolean {
    return (
        !l.rot &&
        !l.eqNumber &&
        !RELATION_RE.test(l.text) &&
        l.words >= 4 &&
        l.alphaWords >= 2 &&
        l.alphaWords >= 0.4 * l.words &&
        l.mathChars < 0.5 * l.inkChars &&
        !NUMERIC_RE.test(l.text)
    );
}

/**
 * Lines of justified paragraphs: runs of stacked lines of words, closely set,
 * that start and end at the same x. Judged from geometry alone, so prose is
 * found whatever its size relative to the page's body text, its column width,
 * or its fonts. A run needs `JUSTIFIED_LINES` distinct lines; ragged table
 * cells rarely align on both edges, and the justified cells of a text table
 * sit side by side, line for line, in one type size. Prose at body size beside
 * another column is found as prose anyway.
 */
function justifiedParagraphs(units: readonly RegionLine[]): Set<RegionLine> {
    const text = units.filter(isTextLine).sort((a, b) => a.bbox[1] - b.bbox[1]);
    // The line directly below each one, if it continues a justified paragraph.
    const next = new Map<RegionLine, RegionLine>();
    for (let i = 0; i < text.length; i++) {
        const a = text[i];
        const h = a.bbox[3] - a.bbox[1];
        for (let j = i + 1; j < text.length; j++) {
            const b = text[j];
            const gap = b.bbox[1] - a.bbox[3];
            if (gap > PARAGRAPH_LEADING * h) break;
            if (gap < -0.5 * h) continue;
            const tolerance = JUSTIFY_TOLERANCE * Math.max(a.size, b.size, 1);
            if (
                Math.abs(a.bbox[0] - b.bbox[0]) <= tolerance &&
                Math.abs(a.bbox[2] - b.bbox[2]) <= tolerance &&
                Math.abs(a.size - b.size) <= 0.5
            ) {
                next.set(a, b);
                break;
            }
        }
    }
    const below = new Set(next.values());
    // Text beside a line on its line, in its type size: the cells of a table row.
    // A narrow column beside a table differs in size or lines up only by chance.
    const sharesLine = (l: RegionLine) => {
        const h = l.bbox[3] - l.bbox[1];
        return units.some(
            (o) =>
                o !== l &&
                !o.rot &&
                (o.bbox[0] >= l.bbox[2] || o.bbox[2] <= l.bbox[0]) &&
                Math.abs(o.size - l.size) <= 0.5 &&
                Math.abs(o.bbox[3] - l.bbox[3]) <= ROW_ALIGN * Math.min(h, o.bbox[3] - o.bbox[1]),
        );
    };
    const out = new Set<RegionLine>();
    for (const start of text) {
        if (below.has(start)) continue;
        const run = [start];
        for (let l = next.get(start); l; l = next.get(l)) run.push(l);
        // A column of repeated cell values lines up too; paragraph lines differ. The
        // cells of a text table stand side by side, line for line.
        if (new Set(run.map((l) => l.text)).size < JUSTIFIED_LINES) continue;
        if (run.filter(sharesLine).length > 0.5 * run.length) continue;
        for (const l of run) out.add(l);
    }
    return out;
}

/**
 * The line runs from a column's left margin (or a paragraph indent after it) to
 * its right margin, as justified prose does; columns are taken from `column`
 * lines (running text).
 */
export function spansColumn(l: RegionLine, column: readonly RegionLine[], indent: number): boolean {
    return column.some(
        (r) =>
            Math.abs(l.bbox[2] - r.bbox[2]) <= 3 &&
            l.bbox[0] >= r.bbox[0] - 2 &&
            l.bbox[0] <= r.bbox[0] + indent &&
            r.bbox[2] - r.bbox[0] > 0,
    );
}

/**
 * The nearest running line within `COLUMN_REACH` body sizes above (`up`) or below
 * `o` that spans its x-extent (or, with `overlap`, only overlaps it): the text
 * column `o` stands in at that side.
 */
function nearestSpanning(running: Iterable<RegionLine>, o: RegionLine, up: boolean, bs: number, overlap = false): RegionLine | undefined {
    let best: RegionLine | undefined;
    let bestGap = COLUMN_REACH * bs;
    for (const r of running) {
        if (r.rot) continue;
        if (overlap ? r.bbox[0] >= o.bbox[2] || r.bbox[2] <= o.bbox[0] : r.bbox[0] > o.bbox[0] + 2 || r.bbox[2] < o.bbox[2] - 2) continue;
        const gap = up ? o.bbox[1] - r.bbox[3] : r.bbox[1] - o.bbox[3];
        if (gap < -0.5 * (o.bbox[3] - o.bbox[1]) || gap > bestGap) continue;
        best = r;
        bestGap = gap;
    }
    return best;
}

/** Mostly words of letters, without a relation sign or much math: a line of text or a text cell. */
function plainWords(l: RegionLine): boolean {
    return l.alphaWords >= 1 && l.alphaWords >= 0.5 * l.words && !RELATION_RE.test(l.text) && l.mathChars < 0.2 * l.inkChars;
}

/** A table cell: words of text or a number (with significance marks), without a relation sign or much math. */
function tableCell(l: RegionLine): boolean {
    const text = l.text.replace(/[*†‡§]+\s*$/u, "");
    // A measurement is a value, bounds ("<0.05", "≥ 10 kg") included; other relations are equations.
    if (MEASURE_RE.test(text)) return true;
    if (!NUMERIC_RE.test(text)) return plainWords(l);
    return !RELATION_RE.test(text) && l.mathChars < 0.2 * l.inkChars;
}

/** Pieces of one line read as a single line: their union box, text and counts. */
function joinPieces(parts: readonly RegionLine[]): RegionLine {
    return parts.reduce((a, b) => ({
        ...a,
        bbox: unionRect(a.bbox, b.bbox),
        text: `${a.text} ${b.text}`,
        words: a.words + b.words,
        nchar: a.nchar + b.nchar + 1,
        alphaWords: a.alphaWords + b.alphaWords,
        mathChars: a.mathChars + b.mathChars,
        inkChars: a.inkChars + b.inkChars,
        eqNumber: false,
    }));
}

/**
 * Upright pieces grouped into runs that read as one line: on one row (sharing
 * most of their height) and at most `INLINE_GAP` body sizes apart, left to
 * right. Equation numbers stand alone.
 */
function inlineRuns(upright: readonly RegionLine[], bs: number): RegionLine[][] {
    const uf = new UnionFind(upright.length);
    for (let i = 0; i < upright.length; i++) {
        const a = upright[i];
        if (a.eqNumber) continue;
        for (let j = i + 1; j < upright.length && upright[j].bbox[1] < a.bbox[3]; j++) {
            const b = upright[j];
            if (b.eqNumber) continue;
            const overlap = Math.min(a.bbox[3], b.bbox[3]) - Math.max(a.bbox[1], b.bbox[1]);
            if (overlap <= 0.5 * Math.min(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1])) continue;
            if (hgap(a.bbox, b.bbox) <= INLINE_GAP * bs) uf.union(i, j);
        }
    }
    const runs = new Map<number, RegionLine[]>();
    upright.forEach((l, i) => {
        const root = uf.find(i);
        const run = runs.get(root);
        if (run) run.push(l);
        else runs.set(root, [l]);
    });
    return [...runs.values()].map((run) => run.sort((a, b) => a.bbox[0] - b.bbox[0]));
}

/**
 * Pieces of a paragraph that are too short to judge alone: a word run split off
 * a prose line by inline math, the math itself, a paragraph's short last line
 * ("… is given by", "[84, 85]."), a heading. They join running text when they
 * continue a running line on its row, or start at a running line's left edge
 * directly below it and continue its sentence; a line that inline math splits
 * into pieces joins when, read whole, it spans its column; short lines of words
 * at a column's left edge join too. Lines that are mostly math join only as
 * inline math on a running line's row.
 */
function extendParagraphs(lines: readonly RegionLine[], running: Set<RegionLine>, bs: number): void {
    const upright = lines.filter((l) => !l.rot).sort((a, b) => a.bbox[1] - b.bbox[1]);
    // Row-mates: other pieces on a line's row. A line sharing its row with pieces
    // that are not running text is a table cell, not a paragraph line (equation
    // numbers and manuscript line numbers do not count). A manuscript line number
    // stands alone in the margin: two or more bare integers past the line on its
    // row are a table row's values (counts, years), and do count.
    const rowMates = new Map<RegionLine, RegionLine[]>();
    // Every piece on a line's row, numbers included: values of a table row.
    const rowCells = new Map<RegionLine, RegionLine[]>();
    const add = (map: Map<RegionLine, RegionLine[]>, x: RegionLine, y: RegionLine) => {
        const list = map.get(x);
        if (list) list.push(y);
        else map.set(x, [y]);
    };
    for (let i = 0; i < upright.length; i++) {
        const a = upright[i];
        for (let j = i + 1; j < upright.length && upright[j].bbox[1] < a.bbox[3]; j++) {
            const b = upright[j];
            const overlap = Math.min(a.bbox[3], b.bbox[3]) - Math.max(a.bbox[1], b.bbox[1]);
            if (overlap <= 0.5 * Math.min(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1])) continue;
            for (const [x, y] of [[a, b], [b, a]] as const) {
                if (y.eqNumber) continue;
                add(rowCells, x, y);
                if (!BARE_INTEGER_RE.test(y.text)) add(rowMates, x, y);
            }
        }
    }
    for (const [x, cells] of rowCells) {
        const values = cells.filter((o) => BARE_INTEGER_RE.test(o.text) && o.bbox[0] >= x.bbox[2]);
        if (values.length >= 2) for (const o of values) add(rowMates, x, o);
    }
    // Alone on its row up to the right edge `x1` of its text column, when a
    // paragraph establishes one: lines past that edge (the next column, a table
    // beside the paragraph) do not count.
    // A line wholly to its left counts unless it is set in another type size and
    // off the line's baseline: cells of one table row (labels to the left of a
    // column of descriptions, a label centred on a wrapped cell) share a size,
    // while text in the column to the left lines up only by chance. Boxes end at
    // the font's descender line, which differs little between fonts, while their
    // tops differ with each font's ascent.
    // An equation in another column is not on the line's row: it does not make a
    // heading beside it a table cell. A text column runs through the row there: the
    // nearest running lines above and below the equation both span it and end before
    // the line starts. Words always count, as the cells of a text table stand in such
    // columns too.
    const sameSize = (a: RegionLine, b: RegionLine) => Math.abs(a.size - b.size) <= 0.5;
    const aligned = (a: RegionLine, b: RegionLine) =>
        Math.abs(a.bbox[3] - b.bbox[3]) <= ROW_ALIGN * Math.min(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1]);
    const inOtherColumn = (l: RegionLine, o: RegionLine) => {
        if (o.bbox[2] > l.bbox[0]) return false;
        if (/\p{L}{2}/u.test(o.text) && !RELATION_RE.test(o.text) && o.mathChars < 0.5 * o.inkChars) return false;
        const up = nearestSpanning(running, o, true, bs);
        const down = nearestSpanning(running, o, false, bs);
        return !!up && !!down && up.bbox[2] < l.bbox[0] && down.bbox[2] < l.bbox[0];
    };
    // Within a paragraph, pieces of one line split by inline math are not each
    // other's row-mates (`ownLine`).
    const runs = inlineRuns(upright, bs);
    const runOf = new Map<RegionLine, RegionLine[]>();
    for (const run of runs) for (const l of run) runOf.set(l, run);
    const aloneOnRow = (l: RegionLine, x1 = Infinity, ownLine = false) =>
        (rowMates.get(l) ?? []).every(
            (o) =>
                running.has(o) ||
                (ownLine && runOf.has(l) && runOf.get(o) === runOf.get(l)) ||
                o.bbox[0] >= x1 ||
                (o.bbox[2] <= l.bbox[0] && !aligned(l, o) && !sameSize(l, o)) ||
                inOtherColumn(l, o),
        );
    // No text past the line's right edge shares its line in its type size, as a
    // table's row label does with its row's values. A lone number past the line
    // is a manuscript line number in the margin, not a row's values.
    const independent = (r: RegionLine) => {
        const past = (rowCells.get(r) ?? []).filter(
            (o) => !running.has(o) && o.bbox[0] >= r.bbox[2] && !(runOf.has(r) && runOf.get(o) === runOf.get(r)),
        );
        if (past.length === 1 && BARE_INTEGER_RE.test(past[0].text)) return true;
        return past.every((o) => !aligned(r, o) || !sameSize(r, o));
    };
    // Alone up to the right edge `x1` of the paragraph it continues, and not a row
    // label: prose beside a table lines up with its rows only by chance, and rarely
    // in their type size, while a label read as running text (a long one) must not
    // carry the labels below it into the paragraph.
    const aloneInColumn = (l: RegionLine, x1: number) => aloneOnRow(l, x1, true) && (x1 === Infinity || independent(l));
    // Running lines indexed by vertical band, so only nearby ones are compared.
    const band = 2 * bs;
    const index = new Map<number, RegionLine[]>();
    const addToIndex = (r: RegionLine) => {
        for (let k = Math.floor(r.bbox[1] / band); k <= Math.floor(r.bbox[3] / band); k++) {
            const list = index.get(k);
            if (list) list.push(r);
            else index.set(k, [r]);
        }
    };
    const markRunning = (l: RegionLine) => {
        running.add(l);
        addToIndex(l);
    };
    for (const r of running) if (!r.rot) addToIndex(r);

    // Justified prose spans its column: a line with a few real words that ends at a
    // running line's right margin and starts at its left margin (or within a
    // paragraph indent) is prose however much inline math it holds. Display
    // equations are centred or indented within the column. A line that inline math
    // splits into pieces (a word space apart on one row) is judged as a whole when
    // one piece is a run of words; an equation's pieces hold symbols, names and
    // relations.
    const columnLines = [...running].filter((r) => !r.rot);
    for (const run of runs) {
        if (run.some((l) => running.has(l))) continue;
        if (run.length > 1 && !run.some((l) => l.alphaWords >= 3 && l.mathChars < 0.5 * l.inkChars && !RELATION_RE.test(l.text))) {
            continue;
        }
        const whole = run.length === 1 ? run[0] : joinPieces(run);
        if (whole.alphaWords < 3) continue;
        const indent = 2.5 * Math.max(whole.size, 1);
        if (spansColumn(whole, columnLines, indent)) for (const l of run) markRunning(l);
    }
    // Short lines of words starting at a text column's left edge ("reveals a
    // trivial fixed point", "as well as:") separate display equations.
    const margins = [...running].filter((r) => !r.rot);
    for (const l of upright) {
        if (l.eqNumber || running.has(l)) continue;
        // Display equations are centred or indented, so a line of words starting at the
        // margin ("where Z(N)(α) and Q(N)(α) are given by …") is prose even with inline math.
        const wordy = l.alphaWords >= 3 || (l.alphaWords >= 2 && l.alphaWords >= 0.6 * l.words && l.mathChars <= 0.2 * l.inkChars);
        if (!wordy) continue;
        if (margins.some((r) => Math.abs(r.bbox[0] - l.bbox[0]) <= 2) && aloneOnRow(l)) markRunning(l);
    }
    // Pieces without words join only as part of a running line: inline math set
    // a word space from it on its row, or a sentence's last words ("[84, 85].")
    // stacked under a running line whose sentence they complete.
    const hasWords = (l: RegionLine) => l.alphaWords >= 1 && l.mathChars < 0.5 * l.inkChars;
    const tail = (l: RegionLine) =>
        !hasWords(l) && CLAUSE_END_RE.test(l.text) && !RELATION_RE.test(l.text) && l.mathChars < 0.5 * l.inkChars;
    const eligible = upright.filter((l) => !l.eqNumber && !running.has(l));
    for (let round = 0; round < 3; round++) {
        let added = false;
        for (const l of eligible) {
            if (running.has(l)) continue;
            const h = l.bbox[3] - l.bbox[1];
            const words = hasWords(l);
            const ends = tail(l);
            const seen = new Set<RegionLine>();
            let found = false;
            for (let k = Math.floor((l.bbox[1] - bs) / band); k <= Math.floor(l.bbox[3] / band) && !found; k++) {
                for (const r of index.get(k) ?? []) {
                    if (seen.has(r)) continue;
                    seen.add(r);
                    const vOverlap = Math.min(l.bbox[3], r.bbox[3]) - Math.max(l.bbox[1], r.bbox[1]);
                    // Inline math sits beside a running line's words (no equation's own
                    // relation), not stacked over them, in their type size; it does not
                    // reach the line through other pieces of math.
                    const sameRow =
                        vOverlap > 0.5 * Math.min(h, r.bbox[3] - r.bbox[1]) &&
                        (words
                            ? hgap(l.bbox, r.bbox) <= 1.5 * bs
                            : hasWords(r) &&
                              !RELATION_RE.test(r.text) &&
                              Math.max(l.size, l.maxSize) <= INLINE_SIZE * r.size &&
                              (l.bbox[0] >= r.bbox[2] - 1 || l.bbox[2] <= r.bbox[0] + 1) &&
                              hgap(l.bbox, r.bbox) <= INLINE_GAP * bs);
                    const below =
                        (words || (ends && !SENTENCE_END_RE.test(r.text))) &&
                        l.bbox[1] >= r.bbox[1] &&
                        l.bbox[1] - r.bbox[3] <= 0.6 * bs &&
                        Math.abs(l.bbox[0] - r.bbox[0]) <= 2 &&
                        Math.abs(l.size - r.size) <= 1 &&
                        aloneInColumn(l, r.bbox[2]);
                    if (sameRow || below) {
                        found = true;
                        break;
                    }
                }
            }
            if (found) {
                markRunning(l);
                added = true;
            }
        }
        if (!added) break;
    }
    markHeadings(upright, running, aloneInColumn);
}

/** Cells of one table row end within this many line heights of each other. */
const ROW_ALIGN = 0.2;
/** A paragraph a heading sits on has at least this many running lines. */
const HEADED_LINES = 3;
/** A heading has at most this many words. */
const HEADING_WORDS = 12;
/** A heading has at most this share of math characters. */
const HEADING_MATH = 0.3;

/**
 * Headings of paragraphs: a short line set directly above a paragraph (a stack
 * of running lines), within its span — flush with its left edge or indented
 * like its first line — alone on its row within that span, and set apart in
 * type (larger, or in another font). A heading over several lines is followed
 * upward. A heading belongs to the text column, so it never joins a table or
 * figure set beside the column.
 */
function markHeadings(
    upright: readonly RegionLine[],
    running: Set<RegionLine>,
    aloneInColumn: (l: RegionLine, x1: number) => boolean,
): void {
    const height = (l: RegionLine) => l.bbox[3] - l.bbox[1];
    const overlapsX = (a: RegionLine, b: RegionLine) => Math.min(a.bbox[2], b.bbox[2]) > Math.max(a.bbox[0], b.bbox[0]);
    // The nearest line directly above one, overlapping it horizontally, within the
    // reach of a heading's gap (lines further up are never stacked on it).
    const byBottom = [...upright].sort((a, b) => a.bbox[3] - b.bbox[3]);
    const reach = 3 * Math.max(1, ...upright.map(height));
    const above = (l: RegionLine): RegionLine | undefined => {
        const cy = (l.bbox[1] + l.bbox[3]) / 2;
        // First line whose bottom lies below the centre of `l`: candidates end before it.
        let lo = 0;
        let hi = byBottom.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (byBottom[mid].bbox[3] < cy + 0.5 * height(l)) lo = mid + 1;
            else hi = mid;
        }
        for (let k = lo - 1; k >= 0 && byBottom[k].bbox[3] >= l.bbox[1] - reach; k--) {
            const o = byBottom[k];
            if (o === l || !overlapsX(o, l) || (o.bbox[1] + o.bbox[3]) / 2 >= cy) continue;
            if (l.bbox[1] - o.bbox[3] < -0.5 * height(l)) continue;
            return o; // the highest bottom first
        }
        return undefined;
    };
    const stacked = (a: RegionLine, b: RegionLine) =>
        b.bbox[1] - a.bbox[3] <= PARAGRAPH_LEADING * Math.max(height(a), height(b)) &&
        Math.abs(a.bbox[0] - b.bbox[0]) <= 3 * Math.max(a.size, b.size, 1);
    // Paragraph tops: running lines with no running line stacked above them and
    // HEADED_LINES running lines stacked from them down.
    const below = new Map<RegionLine, RegionLine>();
    for (const l of upright) {
        if (!running.has(l)) continue;
        const a = above(l);
        if (a && running.has(a) && stacked(a, l) && !below.has(a)) below.set(a, l);
    }
    const hasAbove = new Set(below.values());
    for (const top of upright) {
        if (!running.has(top) || hasAbove.has(top)) continue;
        const paragraph = [top];
        for (let l = below.get(top); l && paragraph.length < HEADED_LINES; l = below.get(l)) paragraph.push(l);
        if (paragraph.length < HEADED_LINES) continue;
        const left = Math.min(...paragraph.map((l) => l.bbox[0]));
        const right = Math.max(...paragraph.map((l) => l.bbox[2]));
        // A heading is set apart from its paragraph's type: larger, or in another font
        // (bold, small caps). A table's labels share the type of the cells below them.
        const fonts = new Map<string | undefined, number>();
        for (const l of paragraph) fonts.set(l.font, (fonts.get(l.font) ?? 0) + 1);
        const paragraphFont = [...fonts].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
        const paragraphSize = Math.max(...paragraph.map((l) => l.size));
        const distinct = (h: RegionLine) =>
            h.size >= paragraphSize + 0.5 || (h.font !== undefined && paragraphFont !== undefined && h.font !== paragraphFont);
        let cur = top;
        for (;;) {
            const h = above(cur);
            if (!h || running.has(h) || h.eqNumber || h.alphaWords < 1 || h.words > HEADING_WORDS || !distinct(h)) break;
            // A display equation over its explanation is set apart too, in a math font.
            if (RELATION_RE.test(h.text) || h.mathChars > HEADING_MATH * h.inkChars) break;
            const indent = 3 * Math.max(cur.size, 1);
            if (h.bbox[0] < left - 2 || h.bbox[0] > left + indent || h.bbox[2] > right + 2) break;
            if (h.bbox[1] > cur.bbox[1] || cur.bbox[1] - h.bbox[3] > 1.2 * Math.max(height(h), height(cur))) break;
            if (!aloneInColumn(h, right)) break;
            running.add(h);
            cur = h;
        }
    }
}

/** X-intervals covered by running text near `y`, merged (text columns). */
function columnsNear(running: readonly RegionLine[], y: number, reach: number): Rect[] {
    const spans = running
        .filter((l) => Math.abs((l.bbox[1] + l.bbox[3]) / 2 - y) <= reach)
        .map((l): Rect => [l.bbox[0], 0, l.bbox[2], 0])
        .sort((a, b) => a[0] - b[0]);
    const out: Rect[] = [];
    for (const s of spans) {
        const last = out[out.length - 1];
        if (last && s[0] <= last[2]) last[2] = Math.max(last[2], s[2]);
        else out.push([...s]);
    }
    return out;
}

/** True when a column gutter (space between two text columns) lies inside [x0, x1]. */
function gutterBetween(columns: readonly Rect[], x0: number, x1: number): boolean {
    for (let i = 0; i + 1 < columns.length; i++) {
        const g0 = columns[i][2];
        const g1 = columns[i + 1][0];
        if (g0 >= x0 - 1 && g1 <= x1 + 1) return true;
    }
    return false;
}

export function textGroups(
    lines: readonly RegionLine[],
    excluded: ReadonlySet<RegionLine>,
    running: ReadonlySet<RegionLine>,
    captions: ReadonlySet<RegionLine>,
    prims: readonly Primitive[],
    bs: number,
    W: number,
): TextGroup[] {
    const pool = lines.filter((l) => !l.rot && !running.has(l) && !excluded.has(l) && l.inkChars > 0);
    if (!pool.length) return [];
    pool.sort((a, b) => a.bbox[1] - b.bbox[1]);
    const runningList = [...running];
    // Text columns near a row, cached per row position.
    const columnCache = new Map<number, Rect[]>();
    const columnsAt = (y: number) => {
        const key = Math.round(y);
        let cols = columnCache.get(key);
        if (!cols) {
            cols = columnsNear(runningList, key, 20 * bs);
            columnCache.set(key, cols);
        }
        return cols;
    };
    const sameRow = (a: RegionLine, b: RegionLine) => {
        const vOverlap = Math.min(a.bbox[3], b.bbox[3]) - Math.max(a.bbox[1], b.bbox[1]);
        return vOverlap > 0.3 * Math.min(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1]);
    };
    // Same-row lines: near cells always join; far ones unless a column gutter lies between.
    const rowJoins = (a: RegionLine, b: RegionLine) => {
        const gapX = hgap(a.bbox, b.bbox);
        if (gapX <= ROW_GAP_NEAR * bs) return true;
        if (gapX > ROW_GAP_FAR * W) return false;
        const y = (a.bbox[1] + a.bbox[3]) / 2;
        return !gutterBetween(columnsAt(y), Math.min(a.bbox[2], b.bbox[2]), Math.max(a.bbox[0], b.bbox[0]));
    };
    // Lines on either side of a column gutter stand in different text columns when
    // each one's column runs through their row: the nearest running lines above and
    // below each line, over it, stay on its side of the gap and share a left margin
    // (up to a paragraph indent). A display equation and a line of the next column
    // (a heading, inline math, words the running-text test missed) then never form
    // one group, however narrow the gutter, and a full-width block further away (a
    // figure's notes) does not hide the gutter.
    // Within one column, its full lines reach across both lines; centred cells of a
    // text table that read as prose keep no margin. Two lines of plain words are
    // never set apart: left-aligned cells of a text table whose columns hold prose
    // look exactly like two text columns.
    const columnEnds = new Map<RegionLine, [RegionLine | undefined, RegionLine | undefined]>();
    const columnOf = (l: RegionLine) => {
        let ends = columnEnds.get(l);
        if (!ends) {
            ends = [nearestSpanning(runningList, l, true, bs, true), nearestSpanning(runningList, l, false, bs, true)];
            columnEnds.set(l, ends);
        }
        return ends;
    };
    const apart = (a: RegionLine, b: RegionLine) => {
        if (plainWords(a) && plainWords(b)) return false;
        const [left, right] = a.bbox[0] <= b.bbox[0] ? [a, b] : [b, a];
        if (left.bbox[2] > right.bbox[0]) return false;
        const [lu, ld] = columnOf(left);
        const [ru, rd] = columnOf(right);
        if (!lu || !ld || !ru || !rd) return false;
        const indent = COLUMN_INDENT * bs;
        return (
            lu.bbox[2] <= right.bbox[0] && ld.bbox[2] <= right.bbox[0] &&
            ru.bbox[0] >= left.bbox[2] && rd.bbox[0] >= left.bbox[2] &&
            Math.abs(lu.bbox[0] - ld.bbox[0]) <= indent && Math.abs(ru.bbox[0] - rd.bbox[0]) <= indent &&
            !rowRepeats(left, right)
        );
    };
    // Cells of a table across the gutter (a wide table between two-column prose) repeat
    // their row: another row nearby holds lines over both, on one baseline. Cells hold
    // words or numbers; the rows of equations set side by side in two columns hold math.
    // A column of symbols (parameter names) beside a column of measurements is a table
    // too when the pattern holds over at least `SYMBOL_TABLE_ROWS` rows.
    const overX = (a: RegionLine, b: RegionLine) => Math.min(a.bbox[2], b.bbox[2]) - Math.max(a.bbox[0], b.bbox[0]) > 0;
    const measure = (l: RegionLine) => MEASURE_RE.test(l.text.replace(/[*†‡§]+\s*$/u, ""));
    const rowRepeats = (left: RegionLine, right: RegionLine) => {
        const cells = tableCell(left) && tableCell(right);
        const leftValue = !cells && measure(left);
        const rightValue = !cells && measure(right);
        if (!cells && !leftValue && !rightValue) return false;
        // Rows as far apart as `mergeAligned` takes a table's rows to be (over two rows when
        // looking for a symbols-and-values table's third row).
        const reach = (cells ? 1 : SYMBOL_TABLE_ROWS - 1) * ALIGNED_GAP * bs;
        const fits = (l: RegionLine, cell: boolean, value: boolean) =>
            (cells ? cell && tableCell(l) : !value || measure(l)) && vgap(l.bbox, left.bbox) <= reach;
        const lefts = pool.filter((l) => l !== left && fits(l, true, leftValue) && overX(l, left) && !sameRow(l, left));
        const rights = pool.filter((l) => l !== right && fits(l, true, rightValue) && overX(l, right) && !sameRow(l, right));
        const rows = lefts.filter((l) => rights.some((r) => sameRow(l, r)));
        return rows.length >= (cells ? 1 : SYMBOL_TABLE_ROWS - 1);
    };
    const eqNumbers = equationNumbers(pool, bs, (a, b) => sameRow(a, b) && rowJoins(a, b) && !apart(a, b));

    const uf = new UnionFind(pool.length);
    const numbers: number[] = [];
    for (let i = 0; i < pool.length; i++) {
        const a = pool[i];
        if (eqNumbers.has(a)) numbers.push(i);
        for (let j = i + 1; j < pool.length; j++) {
            const b = pool[j];
            if (b.bbox[1] > a.bbox[3] + STACK_GAP * bs) break;
            if (eqNumbers.has(a) || eqNumbers.has(b)) continue; // numbers attach below
            if (sameRow(a, b)) {
                if (rowJoins(a, b) && !apart(a, b)) uf.union(i, j);
            } else if (vgap(a.bbox, b.bbox) <= STACK_GAP * bs && hgap(a.bbox, b.bbox) <= 1.5 * bs && !apart(a, b)) {
                uf.union(i, j);
            }
        }
    }
    // An equation number joins the nearest line on its row to its left.
    for (const n of numbers) {
        const nb = pool[n].bbox;
        let best = -1;
        let bestGap = Infinity;
        for (let j = 0; j < pool.length; j++) {
            const b = pool[j].bbox;
            if (j === n || eqNumbers.has(pool[j]) || b[2] > nb[0] + 1 || apart(pool[j], pool[n])) continue;
            const vOverlap = Math.min(b[3], nb[3]) - Math.max(b[1], nb[1]);
            if (vOverlap <= 0.3 * Math.min(b[3] - b[1], nb[3] - nb[1]) && vgap(b, nb) > 0.5 * bs) continue;
            const gap = nb[0] - b[2];
            if (gap < bestGap && gap <= 0.6 * W) {
                bestGap = gap;
                best = j;
            }
        }
        if (best >= 0) uf.union(n, best);
    }

    const groups = new Map<number, RegionLine[]>();
    pool.forEach((l, i) => {
        const r = uf.find(i);
        const g = groups.get(r);
        if (g) g.push(l);
        else groups.set(r, [l]);
    });
    const out: TextGroup[] = [];
    const barriers = lines.filter((l) => captions.has(l) || running.has(l));
    for (const g of mergeAligned([...groups.values()], barriers, running, bs)) {
        for (const numbered of splitAtNumbers(g, eqNumbers)) {
            for (const part of splitAtRelations(numbered, eqNumbers)) {
                if (part.reduce((n, l) => n + l.inkChars, 0) < 3) continue;
                out.push({ bbox: withRules(part, prims, bs), lines: part });
            }
        }
    }
    return out;
}

/**
 * Lines that are equation numbers here. Standard errors in a regression table
 * read like equation numbers ("(0.12)"), but sit directly under or over a
 * numeric cell, or share their row with another parenthesized number; either
 * layout makes them table cells.
 */
function equationNumbers(
    pool: readonly RegionLine[],
    bs: number,
    rowMates: (a: RegionLine, b: RegionLine) => boolean,
): Set<RegionLine> {
    const candidates = pool.filter((l) => l.eqNumber);
    const cells = pool.filter((l) => NUMBER_CELL_RE.test(l.text.trim()));
    const stackedOnCell = (n: RegionLine) =>
        cells.some(
            (c) =>
                vgap(c.bbox, n.bbox) <= STACK_GAP * bs &&
                Math.min(c.bbox[2], n.bbox[2]) - Math.max(c.bbox[0], n.bbox[0]) > 0 &&
                (c.bbox[3] <= n.bbox[1] + 1 || c.bbox[1] >= n.bbox[3] - 1),
        );
    const inNumberRow = (n: RegionLine) => candidates.some((o) => o !== n && rowMates(n, o));
    return new Set(candidates.filter((n) => !stackedOnCell(n) && !inNumberRow(n)));
}

function groupBox(lines: readonly RegionLine[]): Rect {
    let bbox = lines[0].bbox;
    for (const l of lines) bbox = unionRect(bbox, l.bbox);
    return bbox;
}

/**
 * Merge vertically adjacent groups that share at least two column edges (left
 * or right edges of their lines): a table header and its body, or table rows
 * set further apart than stacked lines. A caption, note or prose line between
 * them keeps two stacked tables apart.
 */
function mergeAligned(
    groups: RegionLine[][],
    barriers: readonly RegionLine[],
    running: ReadonlySet<RegionLine>,
    bs: number,
): RegionLine[][] {
    const edges = (g: readonly RegionLine[]) => {
        const out: number[] = [];
        for (const l of g) out.push(l.bbox[0], -l.bbox[2] - 1e4); // right edges kept apart from left edges
        return out;
    };
    const shared = (a: number[], b: number[]) => {
        const hits: number[] = [];
        for (const x of a) {
            if (b.some((y) => Math.abs(x - y) <= EDGE_TOLERANCE) && !hits.some((h) => Math.abs(h - x) <= EDGE_TOLERANCE)) hits.push(x);
        }
        return hits.length;
    };
    let merged = true;
    while (merged) {
        merged = false;
        outer: for (let i = 0; i < groups.length; i++) {
            if (groups[i].length < 2) continue;
            for (let j = i + 1; j < groups.length; j++) {
                if (groups[j].length < 2) continue;
                const a = groupBox(groups[i]);
                const b = groupBox(groups[j]);
                if (vgap(a, b) > ALIGNED_GAP * bs || hgap(a, b) > 0) continue;
                if (shared(edges(groups[i]), edges(groups[j])) < 2) continue;
                // A caption or note between them, or a prose line spanning most of their
                // width, separates two tables (a long text cell is narrower).
                const top = a[3] <= b[1] ? a : b;
                const bottom = top === a ? b : a;
                const both = unionRect(a, b);
                const separated = barriers.some(
                    (l) =>
                        l.bbox[1] >= top[3] - 1 &&
                        l.bbox[3] <= bottom[1] + 1 &&
                        hgap(l.bbox, both) === 0 &&
                        (!running.has(l) || l.bbox[2] - l.bbox[0] >= 0.6 * (both[2] - both[0])),
                );
                if (separated) continue;
                groups[i] = groups[i].concat(groups[j]);
                groups.splice(j, 1);
                merged = true;
                break outer;
            }
        }
    }
    return groups;
}

/** A relation sign set below this share of the type size around it is in a script. */
const SCRIPT_RELATION = 0.85;
/** Limits sit at most this many of their line heights above or below what they attach to (a tall ∏'s box is its text line's). */
const LIMIT_REACH = 2;
/** A limit's centre lies within this many points of the span of what it attaches to... */
const LIMIT_CENTRE_TOLERANCE = 1;
/** ...and it is at most this many times as wide ("i=m+1" under a ∑). */
const LIMIT_WIDTH = 3;

/**
 * In a group of math, each row holding its own relation sign
 * is a separate equation (b₂ = …, −θ = …); a row starting with a relation
 * ("= …", "≤ …") or without one continues the previous row. A relation set in
 * script size (a sum's limits, "i=1" under a ∑) belongs to the term it sits
 * under and splits nothing.
 */
function splitAtRelations(group: RegionLine[], eqNumbers: ReadonlySet<RegionLine>): RegionLine[][] {
    const ink = group.reduce((n, l) => n + l.inkChars, 0);
    const math = group.reduce((n, l) => n + l.mathChars, 0);
    if (group.some((l) => eqNumbers.has(l)) || math < 0.25 * ink) return [group];
    const sorted = [...group].sort((a, b) => a.bbox[1] - b.bbox[1]);
    const rows: RegionLine[][] = [];
    for (const l of sorted) {
        const row = rows[rows.length - 1];
        const cy = (l.bbox[1] + l.bbox[3]) / 2;
        if (row && row.some((r) => cy >= r.bbox[1] && cy <= r.bbox[3])) row.push(l);
        else rows.push([l]);
    }
    const text = (row: RegionLine[]) =>
        [...row]
            .sort((a, b) => a.bbox[0] - b.bbox[0])
            .map((l) => l.text)
            .join(" ")
            .trim();
    // A relation is a script's when set small for the text of its row (a limit beside the
    // operator), or small for the group's text on a row of limits: a row set in script size
    // under or over an operator (∑, ∫, lim, sup, ...) or under or over another such row
    // (limits stacked under "lim sup"). A whole equation set smaller than its neighbour hangs
    // on no operator.
    const mainSize = inkSizeOf(group);
    const smallRow = (row: readonly RegionLine[]) => inkSizeOf(row) < SCRIPT_RELATION * mainSize;
    // What limits attach to: the spans of the operators on the group's lines, then the
    // limit rows found under or over them (limits stacked on limits).
    const anchors: { line: RegionLine; spans: [number, number][] }[] = group
        .filter((l) => l.limitSpans?.length)
        .map((l) => ({ line: l, spans: l.limitSpans! }));
    // A limit is centred under or over its operator, close to its line, and narrow beside it.
    const attached = (l: RegionLine) =>
        anchors.some(({ line, spans }) => {
            if (line === l) return false;
            const h = Math.max(l.bbox[3] - l.bbox[1], line.bbox[3] - line.bbox[1]);
            if (Math.max(l.bbox[1] - line.bbox[3], line.bbox[1] - l.bbox[3]) > LIMIT_REACH * h) return false;
            const cx = (l.bbox[0] + l.bbox[2]) / 2;
            return spans.some(
                ([x0, x1]) =>
                    cx >= x0 - LIMIT_CENTRE_TOLERANCE &&
                    cx <= x1 + LIMIT_CENTRE_TOLERANCE &&
                    l.bbox[2] - l.bbox[0] <= LIMIT_WIDTH * (x1 - x0) + LIMIT_CENTRE_TOLERANCE,
            );
        });
    const limitRows = new Set<RegionLine[]>();
    for (let grown = true; grown; ) {
        grown = false;
        for (const row of rows) {
            if (limitRows.has(row) || !smallRow(row) || !row.some(attached)) continue;
            limitRows.add(row);
            for (const l of row) anchors.push({ line: l, spans: [[l.bbox[0], l.bbox[2]]] });
            grown = true;
        }
    }
    const fullSize = (l: RegionLine, row: RegionLine[]) => {
        const size = l.relationSize ?? 0;
        if (!size || size < SCRIPT_RELATION * inkSizeOf(row)) return false;
        return size >= SCRIPT_RELATION * mainSize || !limitRows.has(row);
    };
    const relation = (row: RegionLine[]) => row.some((l) => fullSize(l, row));
    const ownRelation = (row: RegionLine[]) => {
        const t = text(row);
        return relation(row) && RELATION_RE.test(t.slice(1)) && !LEADING_RELATION_RE.test(t);
    };
    const parts: RegionLine[][] = [];
    let current: RegionLine[] = [];
    let currentHasRelation = false;
    for (const row of rows) {
        const own = ownRelation(row);
        if (currentHasRelation && own) {
            parts.push(current);
            current = [];
            currentHasRelation = false;
        }
        current.push(...row);
        currentHasRelation ||= own || relation(row);
    }
    parts.push(current);
    return parts;
}

/** One group per equation number when a group holds several (each line goes to the nearest number row). */
function splitAtNumbers(group: RegionLine[], eqNumbers: ReadonlySet<RegionLine>): RegionLine[][] {
    const numbers = group.filter((l) => eqNumbers.has(l));
    if (numbers.length < 2) return [group];
    const parts = numbers.map((n) => [n]);
    for (const l of group) {
        if (eqNumbers.has(l)) continue;
        const cy = (l.bbox[1] + l.bbox[3]) / 2;
        let best = 0;
        let bestDist = Infinity;
        numbers.forEach((n, k) => {
            const d = cy < n.bbox[1] ? n.bbox[1] - cy : cy > n.bbox[3] ? cy - n.bbox[3] : 0;
            if (d < bestDist) {
                bestDist = d;
                best = k;
            }
        });
        parts[best].push(l);
    }
    return parts;
}

/** Group bbox extended over rules just above or below it (table top, header and bottom rules). */
function withRules(lines: readonly RegionLine[], prims: readonly Primitive[], bs: number): Rect {
    let bbox = lines[0].bbox;
    for (const l of lines) bbox = unionRect(bbox, l.bbox);
    const reach = RULE_REACH * bs;
    let out = bbox;
    for (const p of prims) {
        if (p.kind !== "hrule") continue;
        const r = p.bbox;
        const overlap = Math.min(r[2], bbox[2]) - Math.max(r[0], bbox[0]);
        if (overlap < 0.5 * (r[2] - r[0]) || overlap < 0.5 * (bbox[2] - bbox[0])) continue;
        if (r[1] >= bbox[1] - reach && r[3] <= bbox[3] + reach && overlapFrac(r, bbox) < 1) out = unionRect(out, r);
    }
    return out;
}
