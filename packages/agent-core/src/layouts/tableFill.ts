/**
 * What a fill works on: cell selection, blocked rows, pending work and the
 * row failures a fill writes.
 *
 * A fill answers the cells {@link cellsToFill} selects. Without a row set
 * that is the table's pending work, summarised by {@link pendingWork}: what
 * the Fill button counts and what a fill's popover describes. Pending work is
 * derived from the table, never stored, so it follows every edit.
 *
 * The selection rules are shared with the backend's read helpers through the
 * `table-fill-selection` fixtures.
 */

import {
    isFillableColumn,
    isExtractionColumn,
    isStale,
    rowInScope,
    type Cell,
    type Column,
    type Row,
    type RowFailure,
    type TableSpec,
} from "./table";

// ---------------------------------------------------------------------------
// Row failures
// ---------------------------------------------------------------------------

/** The row has neither a document nor an abstract to answer from. */
export const NO_SOURCE = "no_source";
/** A read failure without a recognised code. */
export const READ_FAILED = "read_failed";
/** An item row whose lookup failed without a code of its own. */
export const ITEM_UNAVAILABLE = "item_unavailable";

const DOCUMENT_UNREADABLE = "The document could not be read.";
const NO_READABLE_TEXT = "The document has no readable text.";
const UNSUPPORTED = "This type of file cannot be read.";
const TOO_COMPLEX = "The PDF is too complex to read.";

/**
 * The message a row shows for each failure code, as the user reads it: one
 * short sentence, no ids. The same table as the backend's, so a row failed
 * by either reads the same.
 */
export const ROW_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
    deadline: "Ran out of time before this was answered.",
    [NO_SOURCE]: "There is no document or abstract to read.",
    no_answer: "No answer could be produced.",
    no_text: NO_READABLE_TEXT,
    [READ_FAILED]: DOCUMENT_UNREADABLE,
    [ITEM_UNAVAILABLE]: "The item could not be looked up.",
    item_not_found: "The item is no longer in the library.",
    parent_not_found: "The item's parent was not found.",
    zotero_unavailable: "Zotero did not respond.",
    not_found: "The attachment is no longer in the library.",
    file_missing: "The file is not on this computer.",
    download_failed:
        "The file is not on this computer and could not be downloaded.",
    file_permission_denied: "Zotero is not allowed to open the file.",
    is_linked_url: "The attachment is a link, not a file.",
    encrypted: "The PDF is password-protected.",
    no_text_layer: "The PDF has no text layer. It may be a scan.",
    empty_document: NO_READABLE_TEXT,
    empty_text: NO_READABLE_TEXT,
    invalid_pdf: "The PDF is damaged and cannot be opened.",
    pdf_too_complex: TOO_COMPLEX,
    pdf_parser_crash: TOO_COMPLEX,
    recursion_limit: TOO_COMPLEX,
    file_too_large: "The file is too large to read.",
    document_too_large: "The document is too large to read.",
    too_many_pages: "The document has too many pages to read.",
    not_attachment: UNSUPPORTED,
    not_pdf: UNSUPPORTED,
    unsupported_type: UNSUPPORTED,
    beaver_table: UNSUPPORTED,
    timeout: "Reading the document took too long.",
    worker_unavailable: "Zotero could not read the document right now.",
    library_excluded: "The item is in a library Beaver cannot access.",
    library_unavailable:
        "The item's library is not available on this computer.",
    request_refused: "Beaver could not send this paper to be answered.",
    multiple_documents: "This row names several documents; a fill reads one.",
};

/**
 * Row failures that are a property of the file, which no setting or later
 * processing changes. A row with one is blocked: default fills skip it until
 * its documents change or a fill names it. Every other failure is retried.
 */
export const PERMANENT_ROW_FAILURE_CODES: ReadonlySet<string> = new Set([
    // The file itself.
    "encrypted",
    "invalid_pdf",
    // Its type.
    "unsupported_type",
    "not_pdf",
    "not_attachment",
    "is_linked_url",
    // Its size.
    "file_too_large",
    "document_too_large",
    "too_many_pages",
    // The row's shape: a fill reads one document per row.
    "multiple_documents",
]);

/** A row failure for `code`; an unknown code reads as an unreadable document. */
export function rowFailure(code: string): RowFailure {
    const known = Object.prototype.hasOwnProperty.call(ROW_FAILURE_MESSAGES, code);
    const stored = known ? code : READ_FAILED;
    return { code: stored, message: ROW_FAILURE_MESSAGES[stored] };
}

/**
 * Whether a row's failure is permanent for its documents, which holds it back
 * from default fills until its documents change (clearing the failure) or a
 * fill names it.
 */
export function rowBlocked(row: Pick<Row, "failure">): boolean {
    return row.failure != null && PERMANENT_ROW_FAILURE_CODES.has(row.failure.code);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** A row or column a selection named that the table cannot fill. */
export class TableSelectionError extends Error {
    constructor(
        public readonly code: "unknown_row" | "unknown_column" | "invalid_column",
        message: string,
    ) {
        super(message);
        this.name = "TableSelectionError";
    }
}

export interface FillSelection {
    /** Row ids. Absent ⇒ the default row set. */
    rows?: readonly string[];
    /** Column ids. Absent ⇒ every fillable column. */
    columns?: readonly string[];
}

/** One selected cell: `[row id, column id]`. */
export type SelectedCell = [string, string];

function isUserCell(cell: Cell | undefined): boolean {
    return cell?.provenance === "user";
}

/** Whether a cell needs answering by itself: unattempted, failed or stale. */
function cellPending(row: Row, cell: Cell | undefined): boolean {
    return cell === undefined || cell.outcome === "failed" || isStale(row, cell);
}

/** The fillable columns a selection names, in table order. Throws on a bad id. */
export function selectedColumns(
    spec: TableSpec,
    columns?: readonly string[],
): Column[] {
    if (columns === undefined) return spec.columns.filter(isFillableColumn);
    const byId = new Map(spec.columns.map((column) => [column.id, column]));
    for (const id of columns) {
        const column = byId.get(id);
        if (!column)
            throw new TableSelectionError(
                "unknown_column",
                `Column ${id} does not exist`,
            );
        if (!isFillableColumn(column))
            throw new TableSelectionError(
                "invalid_column",
                `Column ${id} is not filled by the filler`,
            );
    }
    const wanted = new Set(columns);
    return spec.columns.filter((column) => wanted.has(column.id));
}

/**
 * The cells a fill works on, in table order.
 *
 * Without a row set: cells of in-scope rows that are not blocked
 * ({@link rowBlocked}) and are unattempted, stale or failed. A row whose
 * failure is retried but that has none of those (a refill that failed over
 * the answers it kept) has all its cells selected, so the retry runs. With a
 * row set: every cell of those rows, blocked or not. User cells are never
 * selected, and extraction columns only cover rows in scope.
 *
 * Throws {@link TableSelectionError} for an id the table does not have.
 */
export function cellsToFill(
    spec: TableSpec,
    selection: FillSelection = {},
): SelectedCell[] {
    const columns = selectedColumns(spec, selection.columns);
    let rows: Row[];
    if (selection.rows === undefined) {
        rows = spec.rows.filter((row) => !rowBlocked(row));
    } else {
        const known = new Set(spec.rows.map((row) => row.id));
        for (const id of selection.rows) {
            if (!known.has(id))
                throw new TableSelectionError(
                    "unknown_row",
                    `Row ${id} does not exist`,
                );
        }
        const wanted = new Set(selection.rows);
        rows = spec.rows.filter((row) => wanted.has(row.id));
    }
    const explicit = selection.rows !== undefined;
    const result: SelectedCell[] = [];
    for (const row of rows) {
        const inScope = rowInScope(spec, row);
        const candidates: string[] = [];
        let selected = false;
        for (const column of columns) {
            if (isExtractionColumn(column) && !inScope) continue;
            const cell = row.cells[column.id];
            if (isUserCell(cell)) continue;
            candidates.push(column.id);
            if (explicit || cellPending(row, cell)) {
                result.push([row.id, column.id]);
                selected = true;
            }
        }
        if (row.failure != null && !selected)
            for (const column of candidates) result.push([row.id, column]);
    }
    return result;
}

// ---------------------------------------------------------------------------
// Pending work
// ---------------------------------------------------------------------------

/** Why a column has pending cells. */
export type PendingColumnReason = "new" | "changed" | "mixed";

export interface PendingColumn {
    id: string;
    header: string;
    /**
     * `new` when the column's pending cells are unattempted (a column added
     * since), `changed` when they are stale or failed (its question, or a
     * row's document, changed), `mixed` for both.
     */
    reason: PendingColumnReason;
    /** The column's pending cells, new rows included. */
    cells: number;
}

/** The default fill, summarised: what the Fill button counts. */
export interface PendingWork {
    /** Rows the default fill would work on. */
    rows: number;
    /** Cells it would answer. */
    cells: number;
    /** Selected rows with no question cell written. */
    new_rows: number;
    /**
     * Columns with pending cells in rows that are neither new nor retries, in
     * table order. A column whose pending cells are all in new rows is not
     * listed: the new rows explain it.
     */
    columns: PendingColumn[];
    /** Rows selected only because their last fill failed with a retryable failure. */
    retry_rows: number;
    /** Rows with a permanent failure, which no default fill selects. */
    blocked_rows: number;
}

/**
 * The table's pending work: the default fill ({@link cellsToFill} without a
 * row set) summarised. A cell is pending when its row is in scope and not
 * blocked and the cell is unattempted, stale or failed; user cells never are.
 *
 * A row with a retryable failure counts as a retry row unless one of its
 * cells went stale, which is new work. The Fill button lights for
 * `rows - retry_rows`, so a failure that keeps failing does not keep asking.
 */
export function pendingWork(spec: TableSpec): PendingWork {
    const selected = cellsToFill(spec);
    const byRow = new Map<string, string[]>();
    for (const [row, column] of selected) {
        const columns = byRow.get(row);
        if (columns) columns.push(column);
        else byRow.set(row, [column]);
    }
    const fillable = spec.columns.filter(isFillableColumn);
    const perColumn = new Map<string, { cells: number; fresh: number; changed: number }>();
    let newRows = 0;
    let retryRows = 0;
    for (const row of spec.rows) {
        const columns = byRow.get(row.id);
        if (!columns) continue;
        const stale = columns.some((id) => {
            const cell = row.cells[id];
            return cell !== undefined && isStale(row, cell);
        });
        if (row.failure != null && !stale) {
            retryRows += 1;
            continue;
        }
        const isNew = !fillable.some((column) => row.cells[column.id] !== undefined);
        if (isNew) newRows += 1;
        for (const id of columns) {
            const counts = perColumn.get(id) ?? { cells: 0, fresh: 0, changed: 0 };
            counts.cells += 1;
            if (!isNew) {
                if (row.cells[id] === undefined) counts.fresh += 1;
                else counts.changed += 1;
            }
            perColumn.set(id, counts);
        }
    }
    const columns: PendingColumn[] = [];
    for (const column of spec.columns) {
        const counts = perColumn.get(column.id);
        if (!counts || counts.fresh + counts.changed === 0) continue;
        columns.push({
            id: column.id,
            header: column.header,
            reason:
                counts.fresh && counts.changed
                    ? "mixed"
                    : counts.changed
                      ? "changed"
                      : "new",
            cells: counts.cells,
        });
    }
    return {
        rows: byRow.size,
        cells: selected.length,
        new_rows: newRows,
        columns,
        retry_rows: retryRows,
        blocked_rows: spec.rows.filter(rowBlocked).length,
    };
}

/**
 * The rows a "Retry failed rows" fill names: rows whose last fill failed
 * with a failure a retry can change, in table order.
 */
export function retryableFailedRows(spec: TableSpec): string[] {
    return spec.rows
        .filter((row) => row.failure != null && !rowBlocked(row))
        .map((row) => row.id);
}
