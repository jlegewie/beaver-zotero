/**
 * The grid a table's cells occupy. A row lists only the cells that start in
 * it; a cell spanning rows covers positions in the rows below, which list
 * nothing there (as in HTML and Zotero notes). Formats without spanning cells
 * place the content at the cell's first position and leave the others empty.
 */

import type { MdTable, MdTableCell } from '../mdast';

export interface GridSlot {
    cell: MdTableCell;
    /** True at the cell's first (top-left) position. */
    origin: boolean;
}

export interface TableGrid {
    columns: number;
    /** `rows[r][c]`: the cell at a position, or null where no cell reaches. */
    rows: Array<Array<GridSlot | null>>;
}

function span(value: number | undefined): number {
    return Number.isInteger(value) && value! > 1 ? value! : 1;
}

export function tableGrid(table: MdTable): TableGrid {
    const rows: Array<Array<GridSlot | null>> = table.children.map(() => []);
    table.children.forEach((row, rowIndex) => {
        let column = 0;
        for (const cell of row.children) {
            while (rows[rowIndex][column]) column += 1;
            const rowspan = Math.min(span(cell.rowspan), table.children.length - rowIndex);
            const colspan = span(cell.colspan);
            for (let r = 0; r < rowspan; r++) {
                for (let c = 0; c < colspan; c++) {
                    rows[rowIndex + r][column + c] = { cell, origin: r === 0 && c === 0 };
                }
            }
            column += colspan;
        }
    });
    const columns = Math.max(1, ...rows.map(row => row.length));
    return { columns, rows: rows.map(row => Array.from({ length: columns }, (_, index) => row[index] ?? null)) };
}

/** Whether any cell spans more than one row or column. */
export function hasSpans(table: MdTable): boolean {
    return table.children.some(row => row.children.some(cell => span(cell.rowspan) > 1 || span(cell.colspan) > 1));
}

/** Whether a table is a Zotero note's (cells holding blocks) rather than a markdown table. */
export function isNoteTable(table: MdTable): boolean {
    return table.children.some(row => row.children.some(cell => cell.blocks));
}

/**
 * Relative column widths from the note's column widths, a column without one
 * taking the mean of the others; null when the note sets none.
 */
export function columnWeights(table: MdTable, columns: number): number[] | null {
    const known = (table.colwidths ?? []).filter((width): width is number => !!width);
    if (known.length === 0) return null;
    const mean = known.reduce((sum, width) => sum + width, 0) / known.length;
    return Array.from({ length: columns }, (_, index) => table.colwidths?.[index] || mean);
}
