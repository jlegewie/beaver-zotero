/**
 * Draft items: a page's items between segmentation and sentence mapping.
 *
 * Segmentation creates them from the paragraph detector's result
 * (`draftItemsFromParagraphs`), item passes relabel, split and merge them
 * (`itemPasses.ts`), and sentence mapping turns them into the page's
 * `DocItem`s. Coordinates are in the upright working frame.
 *
 * The kind is a field. The paragraph detector marks a heading with a "## "
 * prefix in its text, which its markdown output (`pageContent`) keeps; draft
 * text drops it, and `publicItemText` restores it for `section_header`
 * items, whose public text carries it too.
 */

import type { BoundingBox } from "@beaver/agent-core/extract/types";
import type { PageLine } from "../LineDetector";
import type { HangingRole, PageParagraphResult } from "../ParagraphDetector";
import type { RotationAngle } from "../PageRotationNormalizer";
import type { RegionItemKind } from "../regions/regionItems";

/**
 * Kinds a draft item can have; region items are placed after sentence mapping.
 * `margin` items (page furniture an item pass found) leave the reading order:
 * they become internal margin items, like the margin filter's.
 */
export type DraftItemKind = "text" | "section_header" | "reference" | "footnote" | "margin";

export interface DraftItem {
    kind: DraftItemKind;
    /** The item's lines in reading order. */
    lines: PageLine[];
    /** Hanging-indent role of each line (see `detectHangingRoles`), aligned with `lines`. */
    roles: HangingRole[];
    /** Block (column) of the item's first line. */
    columnIndex: number;
    /**
     * Block of the item's last line, set only when it differs from
     * `columnIndex` (an item joined across stacked blocks).
     */
    endColumnIndex?: number;
    /**
     * Block of each line, aligned with `lines`; set only when the lines span
     * more than one block. Passes that rebuild items from lines derive the
     * rebuilt item's block fields from it (`withLineColumns`).
     */
    lineColumns?: number[];
    bbox: BoundingBox;
    /** Item text, without the detector's heading marker. */
    text: string;
}

/**
 * A region item of the page (picture, table, formula). Regions are context
 * for item passes, not draft items: they are placed among the page's items
 * after sentence mapping.
 */
export interface DraftRegion {
    kind: RegionItemKind;
    /** Upright working frame. */
    bbox: BoundingBox;
}

/** The draft items of one page. */
export interface DraftPage {
    pageIndex: number;
    /** Size of the upright working frame. */
    width: number;
    height: number;
    items: DraftItem[];
    /** Column rectangles of the page (upright working frame). */
    columns?: BoundingBox[];
    /**
     * How the upright working frame relates to the page (MuPDF) frame: the
     * text's rotation and the page size before it was turned upright.
     */
    frame?: { rotation: RotationAngle; sourceWidth: number; sourceHeight: number };
    /** The page's region items, when region detection ran. */
    regions?: DraftRegion[];
}

/** The paragraph detector's heading marker (markdown heading syntax). */
const HEADING_MARKER = "## ";

/**
 * Draft items of a paragraph result. The result must carry its item lines
 * (`detectParagraphs` with `trackItemLines: true`).
 */
export function draftItemsFromParagraphs(result: PageParagraphResult): DraftItem[] {
    const itemLines = result.itemLines;
    if (!itemLines) {
        throw new Error(
            "[draftItems] paragraph result must have itemLines set " +
            "(call detectParagraphs with { trackItemLines: true })",
        );
    }
    const roles = result.itemLineRoles ?? [];
    return result.items.map((item, i) => {
        const lines = itemLines[i] ?? [];
        const header = item.type === "header";
        return {
            kind: header ? "section_header" : "text",
            lines,
            roles: roles[i] ?? lines.map(() => null),
            columnIndex: item.columnIndex,
            ...(item.endColumnIndex !== undefined ? { endColumnIndex: item.endColumnIndex } : {}),
            ...(item.lineColumns !== undefined ? { lineColumns: item.lineColumns } : {}),
            bbox: item.bbox,
            text: header && item.text.startsWith(HEADING_MARKER)
                ? item.text.slice(HEADING_MARKER.length)
                : item.text,
        };
    });
}

/** The draft page of a paragraph result (`draftItemsFromParagraphs`). */
export function draftPageFromParagraphs(result: PageParagraphResult): DraftPage {
    return {
        pageIndex: result.pageIndex,
        width: result.width,
        height: result.height,
        items: draftItemsFromParagraphs(result),
    };
}

/** Block of each of the item's lines. */
export function itemLineColumns(item: DraftItem): number[] {
    return item.lineColumns ?? item.lines.map(() => item.columnIndex);
}

/**
 * `item` with its block fields (`columnIndex`, `endColumnIndex`,
 * `lineColumns`) derived from `columns`, the block of each of its lines.
 */
export function withLineColumns(item: DraftItem, columns: readonly number[]): DraftItem {
    const first = columns.length > 0 ? columns[0] : item.columnIndex;
    const last = columns.length > 0 ? columns[columns.length - 1] : first;
    const spans = columns.some((c) => c !== first);
    if (!spans && first === item.columnIndex && item.endColumnIndex === undefined && item.lineColumns === undefined) {
        return item;
    }
    const { endColumnIndex: _end, lineColumns: _lines, ...rest } = item;
    return {
        ...rest,
        columnIndex: first,
        ...(last !== first ? { endColumnIndex: last } : {}),
        ...(spans ? { lineColumns: [...columns] } : {}),
    };
}

/**
 * Public text of a draft item. A heading's carries the "## " marker, as in
 * the markdown output.
 */
export function publicItemText(item: DraftItem): string {
    return item.kind === "section_header" ? `${HEADING_MARKER}${item.text}` : item.text;
}
