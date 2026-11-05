/**
 * The research table as a spreadsheet: which columns an export writes and
 * what each cell says. CSV ({@link toCsv}) and the Excel writer read the same
 * model, so the two files agree column for column.
 *
 * An export carries what the grid shows, one column per field. The paper
 * column is split into its parts (title, authors, publication), followed by
 * the year, the identifier and the question columns in table order. A cell's
 * evidence and reasoning are not columns; {@link exportCellDetails} lists
 * them for a writer that has room for them (the workbook's Evidence sheet).
 */

import { itemLinkExportHref } from "../identity/itemLinks";
import { rowReference } from "./tableCitations";
import {
    cellValueText,
    IDENTIFIER_COLUMN_ID,
    researchColumns,
    type Cell,
    type Column,
    type Row,
    type SelectColor,
    type TableSpec,
} from "./table";

/** What an export column holds. */
export type ExportColumnKind =
    | "title"
    | "authors"
    | "venue"
    | "year"
    | "identifier"
    | "question";

export interface ExportColumn {
    kind: ExportColumnKind;
    header: string;
    /** The table column the values come from (the paper column for its parts). */
    column: Column;
}

/** One exported cell. */
export type ExportValue =
    | { kind: "empty" }
    | {
          kind: "text";
          text: string;
          /** Where the value links to: the item in Zotero, an identifier's URL. */
          href?: string;
      }
    | { kind: "number"; value: number; text: string }
    | { kind: "boolean"; value: boolean; text: string }
    | { kind: "select"; label: string; color?: SelectColor }
    /** The material does not say; written as "Not reported". */
    | { kind: "not_reported"; text: string };

const EMPTY: ExportValue = { kind: "empty" };
export const NOT_REPORTED_TEXT = "Not reported";

/**
 * The columns an export writes, in order. A part of the paper column, the
 * year or the identifier that is empty in every row is left out; the title
 * and every question column are always written.
 */
export function exportColumns(
    spec: TableSpec,
    rows: Row[] = spec.rows,
): ExportColumn[] {
    const { paper, year, questions } = researchColumns(spec);
    const identifier = spec.columns.find((c) => c.id === IDENTIFIER_COLUMN_ID);
    const candidates: ExportColumn[] = [];
    if (paper) {
        candidates.push({
            kind: "title",
            header: paper.type === "reference" ? "Title" : paper.header,
            column: paper,
        });
        if (paper.type === "reference") {
            candidates.push({ kind: "authors", header: "Authors", column: paper });
            candidates.push({ kind: "venue", header: "Publication", column: paper });
        }
    }
    if (year) candidates.push({ kind: "year", header: year.header, column: year });
    if (identifier)
        candidates.push({ kind: "identifier", header: identifier.header, column: identifier });
    const optional: ReadonlySet<ExportColumnKind> = new Set([
        "authors",
        "venue",
        "year",
        "identifier",
    ]);
    return [
        ...candidates.filter(
            (c) =>
                !optional.has(c.kind) ||
                rows.some((row) => exportValue(row, c).kind !== "empty"),
        ),
        ...questions.map((column) => ({
            kind: "question" as const,
            header: column.header,
            column,
        })),
    ];
}

/** The `zotero://select` link of a library row. */
function rowHref(row: Row): string | undefined {
    const ref = row.ref;
    if (ref?.kind !== "item") return undefined;
    return itemLinkExportHref(`${ref.library_ref}-${ref.zotero_key}`) ?? undefined;
}

function text(value: string, href?: string): ExportValue {
    if (!value) return EMPTY;
    return href ? { kind: "text", text: value, href } : { kind: "text", text: value };
}

/** A cell's value as written: the answer, "Not reported", or nothing. */
function cellExportValue(column: Column, cell: Cell | undefined): ExportValue {
    if (!cell) return EMPTY;
    if (cell.outcome === "not_reported")
        return { kind: "not_reported", text: NOT_REPORTED_TEXT };
    if (cell.outcome !== "answered") return EMPTY;
    const value = cell.value;
    switch (value.kind) {
        case "boolean":
            return {
                kind: "boolean",
                value: value.value,
                text: value.value ? "Yes" : "No",
            };
        case "select": {
            const color = column.options?.find((o) => o.label === value.label)?.color;
            return color
                ? { kind: "select", label: value.label, color }
                : { kind: "select", label: value.label };
        }
        case "link":
            return text(value.label ?? value.url, value.url);
        default:
            return text(cellValueText(value));
    }
}

/** What one row says in one export column. */
export function exportValue(row: Row, column: ExportColumn): ExportValue {
    switch (column.kind) {
        case "title": {
            const reference = rowReference(row);
            const title = reference
                ? reference.title || reference.display_name
                : cellValueText(row.cells[column.column.id]?.value);
            return text(title || "Untitled", rowHref(row));
        }
        case "authors":
            return text(rowReference(row)?.subtitle ?? "");
        case "venue":
            return text(rowReference(row)?.venue ?? "");
        case "year": {
            const year = cellValueText(row.cells[column.column.id]?.value);
            return /^\d{4}$/.test(year)
                ? { kind: "number", value: Number(year), text: year }
                : text(year);
        }
        case "identifier":
        case "question":
            return cellExportValue(column.column, row.cells[column.column.id]);
    }
}

/** The text of an exported value, as CSV writes it. */
export function exportValueText(value: ExportValue): string {
    switch (value.kind) {
        case "empty":
            return "";
        case "select":
            return value.label;
        default:
            return value.text;
    }
}

/** One cited passage, ready to print. */
export interface ExportPassage {
    quote: string;
    /** 1-based page, when the passage names one. */
    page?: number;
    /** The caption and header rows of the table the quote sits in. */
    context?: string;
}

/** Why a cell says what it says: its reasoning and the passages it cites. */
export interface ExportCellDetail {
    row: Row;
    column: Column;
    value: ExportValue;
    reasoning?: string;
    passages: ExportPassage[];
}

/**
 * Every question cell with reasoning or cited passages, row by row in the
 * given order, then column by column in table order.
 */
export function exportCellDetails(
    spec: TableSpec,
    rows: Row[] = spec.rows,
): ExportCellDetail[] {
    const { questions } = researchColumns(spec);
    const details: ExportCellDetail[] = [];
    for (const row of rows) {
        for (const column of questions) {
            const cell = row.cells[column.id];
            if (cell?.outcome !== "answered" && cell?.outcome !== "not_reported") continue;
            const reasoning = cell.reasoning?.trim() || undefined;
            const passages = (cell.evidence ?? []).map((evidence) => ({
                quote: evidence.quote,
                ...(evidence.page !== undefined ? { page: evidence.page + 1 } : {}),
                ...(evidence.context ? { context: evidence.context } : {}),
            }));
            if (!reasoning && !passages.length) continue;
            details.push({
                row,
                column,
                value: cellExportValue(column, cell),
                ...(reasoning ? { reasoning } : {}),
                passages,
            });
        }
    }
    return details;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvEscape(field: string): string {
    // A leading =, +, - or @ would run as a formula when the file is opened.
    if (/^[\s]*[=+@-]/.test(field)) field = "'" + field;
    return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/**
 * RFC 4180 CSV of the table: one header row, then one row per table row in
 * the given order, with the columns of {@link exportColumns}. Values only:
 * no evidence, reasoning, confidence or cell state.
 */
export function toCsv(spec: TableSpec, rows: Row[] = spec.rows): string {
    const columns = exportColumns(spec, rows);
    const header = columns.map((c) => csvEscape(c.header)).join(",");
    const lines = rows.map((row) =>
        columns
            .map((c) => csvEscape(exportValueText(exportValue(row, c))))
            .join(","),
    );
    return [header, ...lines].join("\r\n");
}
