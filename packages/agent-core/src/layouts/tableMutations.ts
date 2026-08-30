/**
 * The one supported way a table changes.
 *
 * A stored table is a snapshot attachment whose embedded {@link TableSpec} is
 * the only copy of its state: there is no row table to rebuild it from and no
 * previous value to diff against. So every write goes through this vocabulary
 * rather than reaching into a spec and editing it in place, which puts the
 * rules — what a column change does to the cells under it, what an unknown
 * label means on a fixed vocabulary — in one place instead of in each caller.
 *
 * Two properties follow from the table being the only copy:
 *
 * - **All-or-nothing.** A list of mutations is applied completely or not at
 *   all. A half-applied list leaves a table nobody described and nobody can
 *   undo — worse than a rejected one, which leaves the user exactly where they
 *   were and names what was wrong.
 * - **Strict.** An unknown column or row id, or an id added twice, is an error
 *   rather than a silent no-op. A write addressed to something that is not
 *   there is a bug in the producer, and swallowing it loses the answer it was
 *   carrying.
 *
 * {@link applyMutations} is pure: the input spec is never modified, and no
 * object reachable from it is modified either — the draft copies a column, a
 * row or the cells map on first write and shares everything untouched.
 *
 * The vocabulary is also a contract across implementations: the fixtures under
 * `tests/fixtures/artifacts/table-mutations/` are `before` + `mutations` +
 * `after` triples that any second implementation of these semantics can be
 * held to.
 */

import type { Citation } from "../types/citations";
import {
    hasFixedVocabulary,
    SELECT_COLORS,
    type Cell,
    type Column,
    type ColumnRole,
    type ColumnType,
    type Row,
    type SelectColor,
    type SelectOption,
    type TableCapabilities,
    type TableCostEstimate,
    type TableSort,
    type TableSpec,
} from "./table";

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/** Appends columns. An id that already exists is an error, not an update. */
export interface AddColumnsMutation {
    op: "add_columns";
    columns: Column[];
}

/**
 * Changes a column's declaration. Only the named fields move; an omitted field
 * is left alone. Changing `description` restates the column's question, so the
 * cells below it are marked stale — see {@link applyMutations}.
 */
export interface UpdateColumnMutation {
    op: "update_column";
    /** Column id. */
    column: string;
    header?: string;
    description?: string;
    options?: SelectOption[];
    unit?: string;
    priority?: "primary" | "secondary";
    role?: ColumnRole;
}

/** Removes columns and every cell under them. */
export interface RemoveColumnsMutation {
    op: "remove_columns";
    /** Column ids. */
    columns: string[];
}

/** Appends rows, or merges into rows that already exist — see {@link applyMutations}. */
export interface AddRowsMutation {
    op: "add_rows";
    rows: Row[];
}

export interface RemoveRowsMutation {
    op: "remove_rows";
    /** Row ids. */
    rows: string[];
}

/** One cell write, addressed by row id and column id. */
export interface CellWrite {
    row: string;
    column: string;
    /** An empty cell (`{}`) clears the cell rather than storing an empty one. */
    cell: Cell;
}

export interface SetCellsMutation {
    op: "set_cells";
    cells: CellWrite[];
}

/** Table-level metadata. Only the named fields move. */
export interface SetMetaMutation {
    op: "set_meta";
    title?: string;
    caption?: string;
    sort?: TableSort;
    capabilities?: TableCapabilities;
    cost_estimate?: TableCostEstimate;
    /** Merged into `spec.citations` by `citation_id`; the incoming entry wins. */
    citations_add?: Citation[];
}

export type TableMutation =
    | AddColumnsMutation
    | UpdateColumnMutation
    | RemoveColumnsMutation
    | AddRowsMutation
    | RemoveRowsMutation
    | SetCellsMutation
    | SetMetaMutation;

export type ApplyErrorCode =
    /** A column id that is not in the table. */
    | "unknown_column"
    /** A row id that is not in the table. */
    | "unknown_row"
    /** `add_columns` with an id the table already has. */
    | "duplicate_column"
    /** A select label outside a fixed vocabulary — see {@link hasFixedVocabulary}. */
    | "fixed_vocabulary"
    /** The mutation itself is malformed (a column or row with no id). */
    | "invalid_mutation";

export interface ApplyError {
    code: ApplyErrorCode;
    /** Names the offending column, row or cell, so a caller can report it. */
    message: string;
}

export type ApplyResult =
    | { ok: true; spec: TableSpec }
    | { ok: false; error: ApplyError };

function fail(code: ApplyErrorCode, message: string): ApplyResult {
    return { ok: false, error: { code, message } };
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/**
 * The spec under construction. `spec` starts as a shallow copy of the input, so
 * assigning a field on it never touches the caller's object; the arrays and the
 * objects inside them are copied on first write and tracked here so the second
 * write to the same row does not copy it again.
 */
interface Draft {
    spec: TableSpec;
    columnsCopied: boolean;
    rowsCopied: boolean;
    /** Ids whose column / row object in the draft is our own to write to. */
    ownColumns: Set<string>;
    ownRows: Set<string>;
    columnIndex: Map<string, number>;
    rowIndex: Map<string, number>;
}

function indexById<T extends { id: string }>(items: T[]): Map<string, number> {
    const index = new Map<string, number>();
    items.forEach((item, at) => index.set(item.id, at));
    return index;
}

function draftOf(spec: TableSpec): Draft {
    return {
        spec: { ...spec },
        columnsCopied: false,
        rowsCopied: false,
        ownColumns: new Set(),
        ownRows: new Set(),
        columnIndex: indexById(spec.columns),
        rowIndex: indexById(spec.rows),
    };
}

function columnsOf(draft: Draft): Column[] {
    if (!draft.columnsCopied) {
        draft.spec.columns = [...draft.spec.columns];
        draft.columnsCopied = true;
    }
    return draft.spec.columns;
}

function rowsOf(draft: Draft): Row[] {
    if (!draft.rowsCopied) {
        draft.spec.rows = [...draft.spec.rows];
        draft.rowsCopied = true;
    }
    return draft.spec.rows;
}

/** The column with this id, copied so it can be written to. Undefined if unknown. */
function writableColumn(draft: Draft, id: string): Column | undefined {
    const at = draft.columnIndex.get(id);
    if (at === undefined) return undefined;
    const columns = columnsOf(draft);
    if (!draft.ownColumns.has(id)) {
        columns[at] = { ...columns[at] };
        draft.ownColumns.add(id);
    }
    return columns[at];
}

/** The row with this id, with its cells map copied too. Undefined if unknown. */
function writableRow(draft: Draft, id: string): Row | undefined {
    const at = draft.rowIndex.get(id);
    if (at === undefined) return undefined;
    const rows = rowsOf(draft);
    if (!draft.ownRows.has(id)) {
        rows[at] = { ...rows[at], cells: { ...rows[at].cells } };
        draft.ownRows.add(id);
    }
    return rows[at];
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * `spec` with `mutations` applied in order, or the first failure.
 *
 * Semantics worth knowing before writing a producer:
 *
 * - Mutations are applied **in order**, so a later one sees the effect of an
 *   earlier one: adding a column and then writing its cells in one list works.
 * - **`add_rows` upserts.** A row whose id already exists merges — its cells
 *   are written over the existing ones and untouched cells survive — rather
 *   than duplicating the row or replacing it wholesale. A row that is new is
 *   appended in the order given.
 * - **`set_cells` on an open `select`** whose label is not among
 *   `Column.options` appends the label, taking the next colour from
 *   {@link SELECT_COLORS} so the new category is visually distinct from its
 *   neighbours. On a column with a fixed vocabulary the same label is a
 *   `fixed_vocabulary` error: a closed set that quietly grows is not a set.
 * - **An empty cell clears.** `{ row, column, cell: {} }` removes the entry
 *   from `row.cells` instead of storing an empty object, so `isCellEmpty` and
 *   the coverage counts stay true.
 * - **A write clears `stale`**, because the cell has just been answered against
 *   the current question — an incoming `stale: true` is ignored for the same
 *   reason.
 * - **`update_column` that changes `description` sets `stale` on every existing
 *   cell of that column**: those answers were given to a different question.
 *   Changing the header, the unit or the priority does not — the question is
 *   the same.
 * - **`remove_columns` clears a `sort` or `anchor_column_id`** that pointed at
 *   a removed column, rather than leaving the spec referring to a column that
 *   is gone.
 */
export function applyMutations(
    spec: TableSpec,
    mutations: TableMutation[],
): ApplyResult {
    const draft = draftOf(spec);
    for (const mutation of mutations) {
        const failure = applyOne(draft, mutation);
        if (failure) return failure;
    }
    return { ok: true, spec: draft.spec };
}

/** Applies one mutation to the draft, or returns the failure that stops the list. */
function applyOne(
    draft: Draft,
    mutation: TableMutation,
): ApplyResult | undefined {
    switch (mutation.op) {
        case "add_columns":
            return addColumns(draft, mutation);
        case "update_column":
            return updateColumn(draft, mutation);
        case "remove_columns":
            return removeColumns(draft, mutation);
        case "add_rows":
            return addRows(draft, mutation);
        case "remove_rows":
            return removeRows(draft, mutation);
        case "set_cells":
            return setCells(draft, mutation);
        case "set_meta":
            return setMeta(draft, mutation);
    }
}

function addColumns(
    draft: Draft,
    mutation: AddColumnsMutation,
): ApplyResult | undefined {
    for (const column of mutation.columns) {
        if (!column?.id) {
            return fail("invalid_mutation", "add_columns: a column has no id");
        }
        if (draft.columnIndex.has(column.id)) {
            return fail(
                "duplicate_column",
                `add_columns: column "${column.id}" already exists`,
            );
        }
        const columns = columnsOf(draft);
        draft.columnIndex.set(column.id, columns.length);
        // Copied so a caller that keeps editing its own object cannot reach
        // into the spec it just produced.
        draft.ownColumns.add(column.id);
        columns.push({ ...column });
    }
    return undefined;
}

function updateColumn(
    draft: Draft,
    mutation: UpdateColumnMutation,
): ApplyResult | undefined {
    const column = writableColumn(draft, mutation.column);
    if (!column) {
        return fail(
            "unknown_column",
            `update_column: column "${mutation.column}" does not exist`,
        );
    }

    const questionChanged =
        mutation.description !== undefined &&
        mutation.description !== column.description;

    if (mutation.header !== undefined) column.header = mutation.header;
    if (mutation.description !== undefined)
        column.description = mutation.description;
    if (mutation.options !== undefined)
        column.options = mutation.options.map((option) => ({ ...option }));
    if (mutation.unit !== undefined) column.unit = mutation.unit;
    if (mutation.priority !== undefined) column.priority = mutation.priority;
    if (mutation.role !== undefined) column.role = mutation.role;

    // The answers under the column were given to the previous question, so
    // they are marked rather than dropped: the value is still the best thing
    // anyone has until the column is re-run.
    if (questionChanged) {
        for (const row of draft.spec.rows) {
            if (!row.cells[column.id]) continue;
            const writable = writableRow(draft, row.id);
            if (!writable) continue;
            writable.cells[column.id] = {
                ...writable.cells[column.id],
                stale: true,
            };
        }
    }
    return undefined;
}

function removeColumns(
    draft: Draft,
    mutation: RemoveColumnsMutation,
): ApplyResult | undefined {
    const doomed = new Set<string>();
    for (const id of mutation.columns) {
        if (!draft.columnIndex.has(id)) {
            return fail(
                "unknown_column",
                `remove_columns: column "${id}" does not exist`,
            );
        }
        doomed.add(id);
    }
    if (doomed.size === 0) return undefined;

    draft.spec.columns = columnsOf(draft).filter((c) => !doomed.has(c.id));
    draft.columnIndex = indexById(draft.spec.columns);

    for (const row of draft.spec.rows) {
        if (!Object.keys(row.cells).some((id) => doomed.has(id))) continue;
        const writable = writableRow(draft, row.id);
        if (!writable) continue;
        for (const id of doomed) delete writable.cells[id];
    }

    // A sort or an anchor pointing at a column that no longer exists would make
    // the spec describe a table it is not.
    if (draft.spec.sort && doomed.has(draft.spec.sort.column_id))
        delete draft.spec.sort;
    if (draft.spec.anchor_column_id && doomed.has(draft.spec.anchor_column_id))
        delete draft.spec.anchor_column_id;
    return undefined;
}

function addRows(
    draft: Draft,
    mutation: AddRowsMutation,
): ApplyResult | undefined {
    for (const incoming of mutation.rows) {
        if (!incoming?.id) {
            return fail("invalid_mutation", "add_rows: a row has no id");
        }
        const existing = writableRow(draft, incoming.id);
        if (existing) {
            // Upsert: the incoming cells win, everything the incoming row does
            // not mention survives. A re-run that reports two columns must not
            // erase the rest of the row.
            existing.cells = { ...existing.cells, ...incoming.cells };
            if (incoming.ref !== undefined) existing.ref = incoming.ref;
            if (incoming.in_library !== undefined)
                existing.in_library = incoming.in_library;
            if (incoming.actions !== undefined)
                existing.actions = incoming.actions;
            if (incoming.status !== undefined)
                existing.status = incoming.status;
            if (incoming.error !== undefined) existing.error = incoming.error;
            continue;
        }
        const rows = rowsOf(draft);
        draft.rowIndex.set(incoming.id, rows.length);
        draft.ownRows.add(incoming.id);
        rows.push({ ...incoming, cells: { ...incoming.cells } });
    }
    return undefined;
}

function removeRows(
    draft: Draft,
    mutation: RemoveRowsMutation,
): ApplyResult | undefined {
    const doomed = new Set<string>();
    for (const id of mutation.rows) {
        if (!draft.rowIndex.has(id)) {
            return fail(
                "unknown_row",
                `remove_rows: row "${id}" does not exist`,
            );
        }
        doomed.add(id);
    }
    if (doomed.size === 0) return undefined;

    draft.spec.rows = rowsOf(draft).filter((r) => !doomed.has(r.id));
    draft.rowIndex = indexById(draft.spec.rows);
    return undefined;
}

/**
 * The colour a newly met category gets: the next one round the palette, by how
 * many options the column already declares, so consecutive new categories do
 * not come out the same. `gray` is skipped — it is what an option with no
 * colour renders as, so handing it out would make the new category look like an
 * unlabelled one.
 */
function nextSelectColor(options: SelectOption[]): SelectColor {
    const rotation = SELECT_COLORS.filter((color) => color !== "gray");
    return rotation[options.length % rotation.length];
}

function setCells(
    draft: Draft,
    mutation: SetCellsMutation,
): ApplyResult | undefined {
    for (const write of mutation.cells) {
        const columnAt = draft.columnIndex.get(write.column);
        const column =
            columnAt === undefined ? undefined : draft.spec.columns[columnAt];
        if (!column) {
            return fail(
                "unknown_column",
                `set_cells: column "${write.column}" does not exist`,
            );
        }
        const row = writableRow(draft, write.row);
        if (!row) {
            return fail(
                "unknown_row",
                `set_cells: row "${write.row}" does not exist`,
            );
        }

        const value = write.cell?.value;
        if (column.type === "select" && value?.kind === "select") {
            const known = (column.options ?? []).some(
                (option) => option.label === value.label,
            );
            if (!known) {
                if (hasFixedVocabulary(column)) {
                    return fail(
                        "fixed_vocabulary",
                        `set_cells: label "${value.label}" is not in the fixed vocabulary of column "${column.id}" (cell "${write.row}/${write.column}")`,
                    );
                }
                const writable = writableColumn(draft, column.id) as Column;
                const options = writable.options ?? [];
                writable.options = [
                    ...options,
                    {
                        label: value.label,
                        color: nextSelectColor(options),
                    },
                ];
            }
        }

        // An empty cell is a clear, not a stored empty object: a `{}` left in
        // the map would count as a cell everywhere the spec is walked.
        if (!write.cell || Object.keys(write.cell).length === 0) {
            delete row.cells[write.column];
            continue;
        }
        // The cell has just been answered against the current question, so it
        // cannot be stale — not even if the writer says it is.
        const cell: Cell = { ...write.cell };
        delete cell.stale;
        row.cells[write.column] = cell;
    }
    return undefined;
}

function setMeta(
    draft: Draft,
    mutation: SetMetaMutation,
): ApplyResult | undefined {
    if (mutation.title !== undefined) draft.spec.title = mutation.title;
    if (mutation.caption !== undefined) draft.spec.caption = mutation.caption;
    if (mutation.sort !== undefined) draft.spec.sort = { ...mutation.sort };
    if (mutation.capabilities !== undefined)
        draft.spec.capabilities = { ...mutation.capabilities };
    if (mutation.cost_estimate !== undefined)
        draft.spec.cost_estimate = { ...mutation.cost_estimate };

    if (mutation.citations_add?.length) {
        // The incoming entry wins on a `citation_id` collision, in the place
        // the existing one held: the added metadata is the fresher read of the
        // same citation (a re-extraction that learned a page label, say), and
        // order is what a cited-sources list numbers from.
        const merged = [...(draft.spec.citations ?? [])];
        const at = new Map(merged.map((c, i) => [c.citation_id, i]));
        for (const citation of mutation.citations_add) {
            const existing = at.get(citation.citation_id);
            if (existing === undefined) {
                at.set(citation.citation_id, merged.length);
                merged.push(citation);
            } else {
                merged[existing] = citation;
            }
        }
        draft.spec.citations = merged;
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Per-column counts, so a header can say "3 unsure" without walking the rows.
 * `distribution` is present only where a column has a countable vocabulary:
 * select labels, and `"true"` / `"false"` for a boolean.
 */
export interface TableSummaryColumn {
    type: ColumnType;
    role?: ColumnRole;
    system?: true;
    /** Cells with a value. */
    filled: number;
    unsure: number;
    unsourced: number;
    stale: number;
    distribution?: Record<string, number>;
}

export interface TableSummary {
    rows: number;
    /** Every column in the spec, system ones included. */
    columns: number;
    /** Rows whose `status` is `"error"`. */
    failed_rows: number;
    /** Cells whose `provenance` is `"user"`. */
    user_edits: number;
    /** Keyed by column id, in declaration order. */
    columns_detail: Record<string, TableSummaryColumn>;
}

/**
 * What a chat card, a status line and a column header read instead of walking
 * a megabyte of spec: one pass over rows × columns, no allocation per cell.
 *
 * Deliberately says nothing about **when** the table last changed or **who**
 * changed it. That is the store's version log — a property of the history of a
 * stored table, not of the spec, which a spec that was never stored would have
 * to invent.
 */
export function summarize(spec: TableSpec): TableSummary {
    const summary: TableSummary = {
        rows: spec.rows.length,
        columns: spec.columns.length,
        failed_rows: 0,
        user_edits: 0,
        columns_detail: {},
    };

    for (const column of spec.columns) {
        const detail: TableSummaryColumn = {
            type: column.type,
            filled: 0,
            unsure: 0,
            unsourced: 0,
            stale: 0,
        };
        if (column.role) detail.role = column.role;
        if (column.system) detail.system = true;
        if (column.type === "select" || column.type === "boolean")
            detail.distribution = {};
        summary.columns_detail[column.id] = detail;
    }

    for (const row of spec.rows) {
        if (row.status === "error") summary.failed_rows += 1;
        for (const column of spec.columns) {
            const cell = row.cells[column.id];
            if (!cell) continue;
            const detail = summary.columns_detail[column.id];
            if (cell.provenance === "user") summary.user_edits += 1;
            if (cell.stale) detail.stale += 1;
            if (cell.flag === "unsure") detail.unsure += 1;
            else if (cell.flag === "unsourced") detail.unsourced += 1;
            const value = cell.value;
            if (!value) continue;
            detail.filled += 1;
            if (detail.distribution && value.kind === "select") {
                detail.distribution[value.label] =
                    (detail.distribution[value.label] ?? 0) + 1;
            } else if (detail.distribution && value.kind === "boolean") {
                const key = value.value ? "true" : "false";
                detail.distribution[key] = (detail.distribution[key] ?? 0) + 1;
            }
        }
    }

    return summary;
}
