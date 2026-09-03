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
            return "6.5rem";
        case "boolean":
            // Short header + sort control: 4rem collapsed the label to nothing.
            return "5.5rem";
        case "select":
            return "9.5rem";
        case "link":
            return "10rem";
        case "text":
            return undefined;
    }
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
