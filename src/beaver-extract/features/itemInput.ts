/**
 * Compact per-page model input: the draft items of a page with the line
 * geometry, sizes and hanging roles the item models read.
 *
 * Built once per page from its draft items, in the upright working frame.
 * Features are pure functions of it, so the worker and, from an exported
 * copy, the training pipeline compute the same values (the reference line
 * model's export, `references export`, writes it as is).
 */

import type { StyleProfile } from "@beaver/agent-core/extract/types";
import type { DraftPage } from "../pipeline/draftItems";
import { leadMarkerSize, lineSize } from "./style";

/** One text line of an item. Coordinates are in the upright page frame. */
export interface InputLine {
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

export interface InputItem {
    /** The paragraph detector read the item as a heading. */
    header: boolean;
    /** Block (column) of the item's first line. */
    column: number;
    /**
     * Block of the item's last line, set only when it differs from `column`
     * (an item joined across stacked blocks, `DraftItem.endColumnIndex`).
     */
    endColumn?: number;
    /** Item text (without the detector's heading marker). */
    text: string;
    lines: InputLine[];
}

export interface InputPage {
    pageIndex: number;
    width: number;
    height: number;
    /** Size of the document's primary body style. */
    bodySize: number;
    items: InputItem[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Build the model input for one page from its draft items. */
export function buildInputPage(page: DraftPage, styleProfile: StyleProfile): InputPage {
    const items: InputItem[] = page.items.map((item) => {
        const lines = item.lines.map((line, k): InputLine => {
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
            ...(item.endColumnIndex !== undefined ? { endColumn: item.endColumnIndex } : {}),
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
