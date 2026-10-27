/**
 * Vocabulary shared by the grid and the chrome around it.
 *
 * Everything here is presentation-level and client-agnostic: what a density is
 * called, how a cell's text gets rendered, how wide a column of each type is.
 * Anything that is a fact about the data rather than about the rendering
 * belongs in `@beaver/agent-core/layouts/table` instead.
 */

import type React from "react";
import type { Column } from "@beaver/agent-core/layouts/table";

/**
 * Row height, and with it how many lines every cell clamps to. One lever moves
 * the whole table: the pixel values live in `agent-ui-table.css` keyed on
 * `data-density`, so a client can restyle them without touching this package's
 * logic.
 *
 * - `compact` — one line per cell, for scanning a long result set.
 * - `cozy` — two lines. The default, and what a table of abstracts wants.
 * - `tall` — five lines, for a table whose columns hold extracted prose.
 */
export type TableDensity = "compact" | "cozy" | "tall";

export const TABLE_DENSITIES: TableDensity[] = ["compact", "cozy", "tall"];

export const DENSITY_LABELS: Record<TableDensity, string> = {
    compact: "Compact rows",
    cozy: "Cozy rows",
    tall: "Tall rows",
};

/**
 * Renders a cell's text. Text cells are markdown that may carry inline
 * `<citation …/>` tags, so the client injects its own markdown + citation
 * renderer; a rendering without one still shows the text.
 */
export type TextRenderer = (text: string) => React.ReactNode;

export const renderPlainText: TextRenderer = (text) => text;

/**
 * Whether a table is fitted to its width when the surface asks for it. Columns
 * that do not fit are read in the expanded row, so a table whose rows do not
 * expand scrolls sideways instead.
 */
export function fitsToWidth(table: { capabilities?: { expandable_rows?: boolean } | null }, requested: boolean): boolean {
    return requested && (table.capabilities?.expandable_rows ?? true);
}

/** Width the rail column takes, and the floor a flexible column may shrink to. */
const RAIL_WIDTH = "3.2rem";
const FLEX_COLUMN_MIN = "14rem";

/**
 * The width a column gets when it declares none. `Column.width` is an override
 * for a producer that knows better; these are the defaults a surface applies,
 * and they are what keeps a table of abstracts from handing an 80-character
 * column to a four-digit year.
 *
 * `undefined` means "share what is left", which is what a text column wants.
 */
export function defaultColumnWidth(
    column: Column,
    isAnchor: boolean,
): string | undefined {
    if (column.width != null)
        return column.width === "fill" ? undefined : `${column.width}px`;
    if (isAnchor) return "20rem";
    switch (column.type) {
        case "reference":
            return "16rem";
        case "number":
        case "date":
            return headerWidth(column, 6.5);
        case "boolean":
            // Short header + sort control: 4rem collapsed the label to nothing.
            return headerWidth(column, 5.5);
        case "select":
            return headerWidth(column, 9.5);
        case "link":
            return "10rem";
        case "text":
            return undefined;
    }
}

/** Widest a short column grows to for its header; a longer header wraps. */
const SHORT_COLUMN_MAX_REM = 12;

/**
 * A short column's width: its type's base, widened to fit the header on one
 * line beside the sort control ("Uses US data" read as "Us…" at 5.5rem).
 */
function headerWidth(column: Column, baseRem: number): string {
    const needed = (column.header ?? "").length * 0.55 + 2.6;
    return `${Math.min(SHORT_COLUMN_MAX_REM, Math.max(baseRem, Math.ceil(needed * 2) / 2))}rem`;
}

/**
 * The table's own minimum width, as a `calc()` of every column's.
 *
 * `table-layout: fixed` hands the declared widths out first and lets the
 * flexible columns share whatever is left — which, under a fixed `min-width`,
 * can be nothing at all once enough columns declare one. Summing them here is
 * what makes the table wider than its container instead, so the sticky rail and
 * anchor column have something to stick against.
 */
export function tableMinWidth(
    columns: Column[],
    anchorId: string | undefined,
): string {
    const parts = [RAIL_WIDTH];
    for (const column of columns) {
        parts.push(
            defaultColumnWidth(column, column.id === anchorId) ??
                FLEX_COLUMN_MIN,
        );
    }
    return `calc(${parts.join(" + ")})`;
}

/** A `defaultColumnWidth` (or {@link FLEX_COLUMN_MIN}) value in pixels. */
function widthInPx(width: string, remPx: number): number {
    const value = parseFloat(width);
    if (!Number.isFinite(value)) return 0;
    return width.endsWith("rem") ? value * remPx : value;
}

/**
 * The columns that fit a surface which never scrolls sideways, in their order,
 * and the ones that do not.
 *
 * Each column is counted at the width {@link tableMinWidth} gives it — its
 * declared or default width, or the flexible minimum — and columns are taken
 * in order until the next one would overflow `availablePx`. The anchor always
 * stays: it carries the row's identity. A column that does not fit is not
 * dropped; the grid lists it in the expanded row, as it does on a narrow
 * surface.
 */
export function fitColumns(
    columns: Column[],
    anchorId: string | undefined,
    availablePx: number,
    remPx: number,
): { fit: Column[]; overflow: Column[] } {
    let used = widthInPx(RAIL_WIDTH, remPx);
    const anchor = columns.find((c) => c.id === anchorId);
    if (anchor)
        used += widthInPx(
            defaultColumnWidth(anchor, true) ?? FLEX_COLUMN_MIN,
            remPx,
        );
    const fit: Column[] = [];
    const overflow: Column[] = [];
    for (const column of columns) {
        if (column.id === anchorId) {
            fit.push(column);
            continue;
        }
        const width = widthInPx(
            defaultColumnWidth(column, false) ?? FLEX_COLUMN_MIN,
            remPx,
        );
        if (overflow.length === 0 && used + width <= availablePx) {
            used += width;
            fit.push(column);
        } else {
            overflow.push(column);
        }
    }
    return { fit, overflow };
}
