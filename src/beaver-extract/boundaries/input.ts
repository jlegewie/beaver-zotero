/**
 * Input of the item-boundary features: a page's blocks as the paragraph
 * detector sees them, before it groups their lines into items. Plain data
 * (boxes, text, typography, glyph metrics, the heuristic's per-line
 * decision), so the features are a pure function of it and a parity fixture
 * can pin them.
 *
 * Coordinates are in the upright working frame the detector runs in.
 */

import type { HangingRole } from "../ParagraphDetector";
import type { PageLine } from "../LineDetector";
import { isBoldFont, isItalicFont } from "../StyleAnalyzer";
import { leadMarkerSize, lineFace, lineGeometry, lineSize, visibleLength } from "../features/style";
import type { StartRule, StartTrace } from "./rules";

/** Style of a line's first or last visible glyph run. */
export interface GlyphStyle {
    font: string;
    size: number;
    bold: boolean;
    italic: boolean;
}

/** One line of a block. */
export interface BoundaryLine {
    l: number;
    t: number;
    r: number;
    b: number;
    text: string;
    /** Size and font most visible glyphs are set in (`lineSize`, `lineFace`). */
    size: number;
    font: string;
    /** Shares of visible glyphs set bold and italic, 0–1. */
    bold: number;
    italic: number;
    /** Style the line opens and closes in. */
    first: GlyphStyle | null;
    last: GlyphStyle | null;
    /** Size of a short opening marker run (`leadMarkerSize`). */
    lead: number | null;
    /** Baseline and core of the dominant-size glyphs (`lineGeometry`); null without glyph metrics. */
    baseline: number | null;
    coreTop: number | null;
    coreBottom: number | null;
    /** The paragraph detector's decision: the line starts an item. */
    start: boolean;
    /** Its rule, signals and vetoes (`StartTrace`). */
    rule: StartRule;
    signals: number;
    vetoes: number;
    /** Hanging-indent role: 0 none, 1 entry start, 2 continuation. */
    role: 0 | 1 | 2;
    /** `isHeaderStyle` of the line on its own (no gap context). */
    headerStyle: boolean;
    /** Part of an isolated heading run (`ColumnThresholds.isolatedHeading`). */
    isolatedHeading: boolean;
}

/** The thresholds the paragraph detector computed for a block (`ColumnThresholds`). */
export interface BlockThresholds {
    leftEdgeMode: number;
    rightEdgeMode: number;
    leftEdgeMad: number;
    rightEdgeMad: number;
    maxRightEdge: number;
    indentExcessThreshold: number;
    earlyEndExcessThreshold: number;
    gapExcessThreshold: number;
    medianGap: number;
}

/** A layout block ("column" in the detector): its lines top to bottom. */
export interface BoundaryBlock {
    /** The block's column index. */
    index: number;
    lines: BoundaryLine[];
    thresholds: BlockThresholds;
}

/** A page's blocks in reading order with page and document context. */
export interface BoundaryPage {
    pageIndex: number;
    width: number;
    height: number;
    /** The document's body style (the page's measured body size when known); null without one. */
    body: { size: number; font: string; bold: boolean; italic: boolean } | null;
    /** Page-wide median line height and gap threshold (`PageThresholds`). */
    medianHeight: number;
    gapExcessThreshold: number;
    /** Region items (figures, tables, equations) as [l, t, r, b]. */
    regions: [number, number, number, number][];
    blocks: BoundaryBlock[];
}

/** What the paragraph detector decided about one line, beside the line itself. */
export interface LineDecision {
    start: boolean;
    trace: StartTrace;
    role: HangingRole;
    headerStyle: boolean;
    isolatedHeading: boolean;
}

function glyphStyle(name: string | undefined, weight: string | undefined, style: string | undefined, size: number): GlyphStyle {
    const font = name ?? "";
    return { font, size, bold: isBoldFont(font, weight), italic: isItalicFont(font, style) };
}

/** Style of the line's first (`fromEnd` false) or last visible glyph run. */
function edgeStyle(line: PageLine, fromEnd: boolean): GlyphStyle | null {
    const spans = line.spans;
    for (let s = 0; s < spans.length; s++) {
        const span = spans[fromEnd ? spans.length - 1 - s : s];
        const runs = span.styleRuns;
        if (runs && runs.length > 0) {
            for (let k = 0; k < runs.length; k++) {
                const run = runs[fromEnd ? runs.length - 1 - k : k];
                if (run.chars > 0) return glyphStyle(run.font.name, run.font.weight, run.font.style, run.exactSize ?? run.font.size);
            }
        } else if (visibleLength(span.text) > 0) {
            return glyphStyle(span.fontName, span.fontWeight, span.fontStyle, span.size ?? 0);
        }
    }
    return null;
}

/** The boundary input of a detected line and the detector's decision on it. */
export function boundaryLine(line: PageLine, decision: LineDecision): BoundaryLine {
    const face = lineFace(line);
    const size = lineSize(line);
    const geometry = lineGeometry(line, size);
    return {
        l: line.bbox.l,
        t: line.bbox.t,
        r: line.bbox.r,
        b: line.bbox.b,
        text: line.text,
        size,
        font: face.font,
        bold: face.bold,
        italic: face.italic,
        first: edgeStyle(line, false),
        last: edgeStyle(line, true),
        lead: leadMarkerSize(line),
        baseline: geometry?.baseline ?? null,
        coreTop: geometry?.coreTop ?? null,
        coreBottom: geometry?.coreBottom ?? null,
        start: decision.start,
        rule: decision.trace.rule,
        signals: decision.trace.signals,
        vetoes: decision.trace.vetoes,
        role: decision.role === "entry" ? 1 : decision.role === "continuation" ? 2 : 0,
        headerStyle: decision.headerStyle,
        isolatedHeading: decision.isolatedHeading,
    };
}
