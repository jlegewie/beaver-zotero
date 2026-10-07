/**
 * Compact per-page input for the reference classifier.
 *
 * Built once per page from its draft items, in the upright working frame. It holds everything the classifier's features read, so the
 * same features can be computed in the worker and, from an exported copy, in
 * the training pipeline.
 */

import type { RawStyleRun, StyleProfile } from "@beaver/agent-core/extract/types";
import type { DetectedSpan, PageLine } from "../LineDetector";
import type { DraftPage } from "../pipeline/draftItems";

/** One text line of an item. Coordinates are in the upright page frame. */
export interface RefLine {
    text: string;
    l: number;
    t: number;
    r: number;
    b: number;
    /** Font size most of the line's visible glyphs are set in. */
    size: number;
    /** Hanging-indent role: 0 none, 1 entry start, 2 continuation. */
    role: 0 | 1 | 2;
    /**
     * Size of the line's first visible glyph run relative to `size` when
     * that run is a short marker (a superscript note number); otherwise 1.
     */
    lead: number;
}

export interface RefItem {
    /** The paragraph detector read the item as a heading. */
    header: boolean;
    column: number;
    /** Item text (without the detector's heading marker). */
    text: string;
    lines: RefLine[];
}

export interface RefPage {
    pageIndex: number;
    width: number;
    height: number;
    /** Size of the document's primary body style. */
    bodySize: number;
    items: RefItem[];
}

function visibleLength(text: string): number {
    let n = 0;
    for (const ch of text) if (ch.trim() !== "") n++;
    return n;
}

function styleRuns(span: DetectedSpan): readonly RawStyleRun[] | null {
    return span.styleRuns && span.styleRuns.length > 0 ? span.styleRuns : null;
}

/** Size of the line's opening run when it is a short marker (≤ 4 glyphs). */
function leadMarkerSize(line: PageLine): number | null {
    for (const span of line.spans) {
        const runs = styleRuns(span);
        if (runs) {
            for (const run of runs) {
                if (run.chars === 0) continue;
                return run.chars <= 4 ? (run.exactSize ?? run.font.size) : null;
            }
        } else {
            const n = visibleLength(span.text);
            if (n === 0) continue;
            return n <= 4 && span.size ? span.size : null;
        }
    }
    return null;
}

/** Font size most of a line's visible glyphs are set in. */
function lineSize(line: PageLine): number {
    // Glyph counts per size (to the half point); lines use few sizes.
    const sizes: number[] = [];
    const counts: number[] = [];
    const add = (chars: number, size: number | undefined) => {
        if (chars <= 0) return;
        const key = Math.round((size ?? 0) * 2) / 2;
        const k = sizes.indexOf(key);
        if (k >= 0) counts[k] += chars;
        else {
            sizes.push(key);
            counts.push(chars);
        }
    };
    for (const span of line.spans) {
        const runs = styleRuns(span);
        if (runs) {
            for (const run of runs) {
                add(run.chars, run.exactSize ?? run.font.size);
            }
        } else {
            add(visibleLength(span.text), span.size);
        }
    }
    let size = line.fontSize ?? 0;
    let best = -1;
    for (let k = 0; k < sizes.length; k++) {
        if (counts[k] > best) {
            best = counts[k];
            size = sizes[k];
        }
    }
    return size;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Build the classifier input for one page from its draft items. */
export function buildRefPage(page: DraftPage, styleProfile: StyleProfile): RefPage {
    const items: RefItem[] = page.items.map((item) => {
        const lines = item.lines.map((line, k): RefLine => {
            const size = lineSize(line);
            const role = item.roles[k] ?? null;
            const marker = leadMarkerSize(line);
            return {
                text: line.text,
                l: round2(line.bbox.l),
                t: round2(line.bbox.t),
                r: round2(line.bbox.r),
                b: round2(line.bbox.b),
                size: round2(size),
                role: role === "entry" ? 1 : role === "continuation" ? 2 : 0,
                lead: marker !== null && size > 0 ? round2(Math.min(marker / size, 2)) : 1,
            };
        });
        return {
            header: item.kind === "section_header",
            column: item.columnIndex,
            text: item.text,
            lines,
        };
    });
    return {
        pageIndex: page.pageIndex,
        width: round2(page.width),
        height: round2(page.height),
        bodySize: styleProfile.primaryBodyStyle?.size ?? 0,
        items,
    };
}
