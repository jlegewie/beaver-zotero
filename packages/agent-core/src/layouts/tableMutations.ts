/**
 * The one supported way a table changes.
 *
 * Every write goes through this vocabulary rather than reaching into a spec
 * and editing it in place, which puts the rules — what a column change does to
 * the cells under it, which cell writes a filler may make — in one place
 * instead of in each caller.
 *
 * Two properties follow from the table being the only copy of its state:
 *
 * - **All-or-nothing.** A list of mutations is applied completely or not at
 *   all. A half-applied list leaves a table nobody described and nobody can
 *   undo.
 * - **Strict.** An unknown column, row or source id, or an id added twice, is
 *   an error rather than a silent no-op. A write addressed to something that is
 *   not there is a bug in the producer.
 *
 * The one deliberate exception to strictness is a cell write the engine
 * declines on purpose — a write to a user-owned cell, or an answer to a
 * question the column no longer asks. Those are skipped and reported
 * (`skipped`), and the rest of the batch applies.
 *
 * {@link applyMutations} is pure: the input spec is never modified, and no
 * object reachable from it is modified either — the draft copies a column, a
 * row or the cells map on first write and shares everything untouched.
 *
 * The vocabulary is a stable contract shared with the backend: both produce
 * the same result for the same starting table and ordered mutations, held to
 * each other by the fixture corpus.
 */

import {
    validateTableSpec,
    normalizeSelectLabel,
    isExtractionColumn,
    isFillableColumn,
    isStale,
    isTitleAbstractOnly,
    needsReview,
    codePointLength,
    jsonBytes,
    questionHash,
    rowInScope,
    utf8Length,
    MAX_EVIDENCE_BYTES,
    MAX_MODEL_COLUMNS,
    MAX_REASONING_BYTES,
    MAX_ROWS,
    MAX_SELECT_DEFINITION_CHARS,
    MAX_SELECT_DEFINITIONS_CHARS,
    MAX_SPEC_BYTES,
    SELECT_COLORS,
    WRITE_BLOCKING_ISSUES,
    type AnsweredCell,
    type Cell,
    type CellOutcome,
    type Column,
    type ColumnRole,
    type ColumnType,
    type Row,
    type RowFailure,
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
 * An option in `update_column.options`. Without `description` it keeps the
 * definition the option had (paired by {@link normalizeSelectLabel}), so a
 * labels-only update cannot wipe the codebook; `null` clears it.
 */
export interface UpdateColumnOption {
    label: string;
    color?: SelectColor;
    description?: string | null;
}

/**
 * Changes a column's declaration. Only the named fields move; an omitted field
 * is left alone. A change to the column's question ({@link questionHash}: its
 * description or an option definition) marks the cells below it stale — see
 * {@link applyMutations}.
 */
export interface UpdateColumnMutation {
    op: "update_column";
    /** Column id. */
    column: string;
    header?: string;
    description?: string | null;
    /** Add-only: the list may re-spell and append, never drop a label in use. */
    options?: UpdateColumnOption[] | null;
    priority?: "primary" | "secondary" | null;
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
    /** Required; null or `{}` deletes the cell, so it counts as unattempted. */
    cell: Cell | Record<string, never> | null;
    /**
     * {@link questionHash} of the column when the answer was produced. A
     * mismatch skips the write, so an answer to an old question never
     * un-stales a cell.
     */
    question_hash?: string | null;
    /**
     * An explicit user reset: the only deletion that may remove a user-owned
     * cell. Any other deletion of a user cell is skipped. Carries no cell.
     */
    reset?: boolean;
    /**
     * The row's documents when the answer was produced (null or `[]`: none).
     * A row that names others now (as a set) skips the write
     * (`documents_changed`), so a fill that read an older document never
     * replaces answers read from a newer one.
     */
    expected_documents?: string[] | null;
    /**
     * The column's {@link Column.revision} when the answer was planned. A
     * column that has changed since skips the write (`column_changed`), so
     * an answer in flight while an option is renamed never writes the old
     * label back.
     */
    revision?: number | null;
}

export interface SetCellsMutation {
    op: "set_cells";
    cells: CellWrite[];
}

/**
 * The row fields a fill writes: the documents the row is filled from and its
 * failure. Only the named fields move; null clears one. Changing `documents`
 * (as a set) clears the row's failure, unless the same mutation sets one: a
 * failure is about the document that was read.
 */
export interface UpdateRowMutation {
    op: "update_row";
    /** Row id. */
    row: string;
    documents?: string[] | null;
    failure?: RowFailure | null;
    /**
     * The documents the writer saw on the row (null or `[]`: none). When the
     * row names others now (as a set), the update is skipped and reported
     * (`documents_changed`): a failure, or a switch, decided for one document
     * never lands on another a concurrent writer chose.
     */
    expected_documents?: string[] | null;
}

/** Table-level metadata. Only the named fields move; null clears one. */
export interface SetMetaMutation {
    op: "set_meta";
    title?: string | null;
    description?: string | null;
    sort?: TableSort | null;
    capabilities?: TableCapabilities | null;
    cost_estimate?: TableCostEstimate | null;
}

/** Drops source entries and the rows whose only origin they are. */
export interface RemoveSourcesMutation {
    op: "remove_sources";
    /** Source entry ids. */
    sources: string[];
}

export type TableMutation =
    | AddColumnsMutation
    | UpdateColumnMutation
    | RemoveColumnsMutation
    | AddRowsMutation
    | RemoveRowsMutation
    | SetCellsMutation
    | UpdateRowMutation
    | SetMetaMutation
    | RemoveSourcesMutation;

export type ApplyErrorCode =
    /** A column id that is not in the table. */
    | "unknown_column"
    /** A row id that is not in the table. */
    | "unknown_row"
    /** A source entry id that is not in the table. */
    | "unknown_source"
    /** `add_columns` with an id the table already has. */
    | "duplicate_column"
    /** The batch would grow the table past a limit. */
    | "too_large"
    /** The mutation itself is malformed, or its result breaks an invariant. */
    | "invalid_mutation";

export interface ApplyError {
    code: ApplyErrorCode;
    /** Names the offending column, row or cell, so a caller can report it. */
    message: string;
}

export type SkipReason =
    | "user_cell"
    /** A write whose `revision` no longer matches the column's. */
    | "column_changed"
    | "question_changed"
    | "row_removed"
    | "column_removed"
    /** A write or `update_row` whose `expected_documents` no longer match the row. */
    | "documents_changed";

/**
 * A `set_cells` write or `update_row` the engine declined, reported to the
 * writer. A skipped `update_row` names no column.
 */
export interface SkippedCell {
    row: string;
    column?: string;
    reason: SkipReason;
}

export type ApplyResult =
    | { ok: true; spec: TableSpec; skipped: SkippedCell[] }
    | { ok: false; error: ApplyError };

type Failure = Extract<ApplyResult, { ok: false }>;

function fail(code: ApplyErrorCode, message: string): Failure {
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
    skipped: SkippedCell[];
    /**
     * `set_cells` and `update_row` skip writes to a removed row or column (the
     * provider `edit`).
     */
    skipMissing: boolean;
}

function indexById<T extends { id: string }>(items: T[]): Map<string, number> {
    const index = new Map<string, number>();
    items.forEach((item, at) => index.set(item.id, at));
    return index;
}

function draftOf(spec: TableSpec, skipMissing = false): Draft {
    return {
        spec: { ...spec },
        columnsCopied: false,
        rowsCopied: false,
        ownColumns: new Set(),
        ownRows: new Set(),
        columnIndex: indexById(spec.columns),
        rowIndex: indexById(spec.rows),
        skipped: [],
        skipMissing,
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

function modelColumnCount(spec: TableSpec): number {
    return spec.columns.filter((column) => !column.system).length;
}

/**
 * `spec` with `mutations` applied in order, or the first failure.
 *
 * Semantics worth knowing before writing a producer:
 *
 * - Mutations are applied **in order**, so a later one sees the effect of an
 *   earlier one: adding a column and then writing its cells in one list works.
 * - **`add_rows` upserts.** A row whose id already exists merges — its cells
 *   are written over the existing ones and untouched cells survive. A row that
 *   is new is appended in the order given.
 * - **`set_cells` protects user cells**: a write to a cell whose provenance is
 *   `user` is skipped and reported unless the write is itself a user cell or a
 *   deletion marked `reset` — an unmarked deletion carries no provenance, so
 *   it cannot remove a user's correction. A write whose `question_hash` no
 *   longer matches the column is skipped too, and so is one whose `revision`
 *   is not the column's. An unknown row or column still
 *   fails the whole batch, except with `skipMissing` (the provider `edit`):
 *   there a write to a row or column no longer in the table is skipped and
 *   reported (`column_removed` first when both are gone), since during a fill
 *   that is a race with another writer, and the rest of the batch applies.
 *   `update_row` of a removed row is skipped the same way.
 * - **`update_row` that changes `documents` clears the row's `failure`**,
 *   unless the same mutation sets one.
 * - **`set_cells` on a `select` matches by {@link normalizeSelectLabel}** and
 *   stores the column's spelling. A label the column does not have is appended,
 *   taking the next colour from {@link SELECT_COLORS}.
 * - **`update_column.options` is add-only** — see {@link planOptions}.
 * - **An empty cell deletes**: `{ row, column, cell: {} }` (or null) removes the
 *   entry, so the cell counts as unattempted again.
 * - **A write clears `stale`**, because the cell has just been answered against
 *   the current question, and **drops an empty `documents` list** (an answer
 *   from title and abstract names none).
 * - **`update_column` that changes `description` sets `stale` on every existing
 *   cell of that column.** A change to its question or to its option labels
 *   or definitions also increments its `revision`; a header or colour does
 *   not.
 * - **`remove_columns` clears a `sort` or `anchor_column_id`** that pointed at
 *   a removed column.
 * - **`remove_sources` drops the entries** and every row whose only origin they
 *   were; a row another entry also produced keeps that origin.
 * - The result must keep every cell invariant (see `validateTableSpec`), and a
 *   batch that grows the table past a limit fails with `too_large`.
 */
export function applyMutations(
    spec: TableSpec,
    mutations: TableMutation[],
    options: { skipMissing?: boolean } = {},
): ApplyResult {
    const draft = draftOf(spec, options.skipMissing === true);
    const before = { rows: spec.rows.length, columns: modelColumnCount(spec) };
    for (const mutation of mutations) {
        const failure = applyOne(draft, mutation);
        if (failure) return failure;
    }
    const invalid = validateTableSpec(draft.spec).find((issue) =>
        WRITE_BLOCKING_ISSUES.has(issue.code),
    );
    if (invalid) return fail("invalid_mutation", invalid.message);
    const tooLarge = capacityFailure(spec, draft.spec, before);
    if (tooLarge) return tooLarge;
    return { ok: true, spec: draft.spec, skipped: draft.skipped };
}

/** Refuses a batch that grows the table past a limit; shrinking is always allowed. */
function capacityFailure(
    original: TableSpec,
    spec: TableSpec,
    before: { rows: number; columns: number },
): Failure | undefined {
    const rows = spec.rows.length;
    if (rows > MAX_ROWS && rows > before.rows)
        return fail(
            "too_large",
            `This change would give the table ${rows} rows; a table holds at most ${MAX_ROWS}. Add fewer rows, remove rows or sources first, or start a second table.`,
        );
    const columns = modelColumnCount(spec);
    if (columns > MAX_MODEL_COLUMNS && columns > before.columns)
        return fail(
            "too_large",
            `This change would give the table ${columns} question columns; a table holds at most ${MAX_MODEL_COLUMNS}. Remove columns first or start a second table.`,
        );
    const size = jsonBytes(spec);
    if (size > MAX_SPEC_BYTES && size > jsonBytes(original))
        return fail(
            "too_large",
            `This change would make the table ${size} bytes; a table holds at most ${MAX_SPEC_BYTES}. Shorten evidence or reasoning, remove rows or columns, or start a second table.`,
        );
    return undefined;
}

/**
 * The limits a whole-spec write must keep: every cell's own limits, and no
 * growth past the table's caps relative to `before` (null for a new table).
 */
export function checkTableLimits(
    before: TableSpec | null,
    after: TableSpec,
): ApplyError | undefined {
    const columns = new Map(after.columns.map((column) => [column.id, column]));
    for (const row of after.rows) {
        for (const [columnId, cell] of Object.entries(row.cells)) {
            const column =
                columns.get(columnId) ?? ({ id: columnId } as Column);
            const failure = cellLimitFailure(
                column,
                cell,
                `cell "${row.id}/${columnId}"`,
            );
            if (failure) return failure.error;
        }
    }
    const base: TableSpec = before ?? { id: after.id, columns: [], rows: [] };
    const failure = capacityFailure(base, after, {
        rows: base.rows.length,
        columns: modelColumnCount(base),
    });
    return failure?.error;
}

/** Applies one mutation to the draft, or returns the failure that stops the list. */
function applyOne(draft: Draft, mutation: TableMutation): Failure | undefined {
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
        case "update_row":
            return updateRow(draft, mutation);
        case "set_meta":
            return setMeta(draft, mutation);
        case "remove_sources":
            return removeSources(draft, mutation);
        default:
            return fail(
                "invalid_mutation",
                `Unknown mutation: ${(mutation as { op?: string }).op}`,
            );
    }
}

function addColumns(
    draft: Draft,
    mutation: AddColumnsMutation,
): Failure | undefined {
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
        const clash = duplicateOptionLabels(column.options);
        if (clash) {
            return fail(
                "invalid_mutation",
                `add_columns: column "${column.id}" lists "${clash[0]}" and "${clash[1]}" as two options, which are one label`,
            );
        }
        const options = column.options
            ? cleanDefinitions("add_columns", column.id, column.options)
            : undefined;
        if (isFailure(options)) return options;
        const columns = columnsOf(draft);
        draft.columnIndex.set(column.id, columns.length);
        // Copied so a caller that keeps editing its own object cannot reach
        // into the spec it just produced.
        draft.ownColumns.add(column.id);
        columns.push(options ? { ...column, options } : { ...column });
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** Whether a cell write deletes rather than stores. */
function isDeletion(cell: CellWrite["cell"]): boolean {
    return !cell || Object.keys(cell).length === 0;
}

/** A cell's own limits, checked on every write. */
function cellLimitFailure(
    column: Column,
    cell: Cell,
    at: string,
): Failure | undefined {
    if (cell.evidence?.length && jsonBytes(cell.evidence) > MAX_EVIDENCE_BYTES)
        return fail(
            "too_large",
            `Column ${column.id}: evidence exceeds ${MAX_EVIDENCE_BYTES} bytes (${at})`,
        );
    if (cell.reasoning && utf8Length(cell.reasoning) > MAX_REASONING_BYTES)
        return fail(
            "too_large",
            `Column ${column.id}: reasoning exceeds ${MAX_REASONING_BYTES} bytes (${at})`,
        );
    return undefined;
}

/**
 * `cell` as `column` stores it: checked against the cell limits, without
 * `stale`, and with a `select` label matched against the column's options by
 * {@link normalizeSelectLabel} and re-spelled to the column's own wording. A
 * label the column does not have is appended.
 *
 * Every path that writes a cell goes through this — `set_cells` and the cells
 * carried by `add_rows` alike.
 */
function canonicalCell(
    draft: Draft,
    column: Column,
    cell: Cell,
    at: string,
): Cell | Failure {
    if (!cell || typeof cell !== "object" || !cell.outcome || !cell.provenance)
        return fail(
            "invalid_mutation",
            `Cell ${at}: a written cell names its outcome and provenance`,
        );
    const tooLarge = cellLimitFailure(column, cell, at);
    if (tooLarge) return tooLarge;
    const stored: Cell = { ...cell };
    delete stored.stale;
    if (Array.isArray(stored.documents) && stored.documents.length === 0)
        delete stored.documents;
    const value = stored.value;
    if (column.type !== "select" || value?.kind !== "select") return stored;

    const known = optionFor(column.options, value.label);
    if (known) {
        if (known.label !== value.label)
            stored.value = { ...value, label: known.label };
        return stored;
    }
    const writable = writableColumn(draft, column.id) as Column;
    const options = writable.options ?? [];
    writable.options = [
        ...options,
        { label: value.label, color: nextSelectColor(options) },
    ];
    return stored;
}

function isFailure(value: unknown): value is Failure {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as { ok?: unknown }).ok === false
    );
}

// ---------------------------------------------------------------------------
// The select vocabulary
// ---------------------------------------------------------------------------

/**
 * The colour a newly met category gets: the next one round the palette, by how
 * many options the column already declares, skipping any colour the column (or
 * `reserved`, for colours the rest of an `options` update will keep) already
 * uses. `gray` is skipped too — it is what an option with no colour renders as.
 */
function nextSelectColor(
    options: readonly Pick<SelectOption, "color">[],
    reserved?: Iterable<SelectColor>,
): SelectColor {
    const rotation = SELECT_COLORS.filter((color) => color !== "gray");
    const taken = new Set<SelectColor | undefined>(options.map((o) => o.color));
    for (const color of reserved ?? []) taken.add(color);
    for (let step = 0; step < rotation.length; step += 1) {
        const color = rotation[(options.length + step) % rotation.length];
        if (!taken.has(color)) return color;
    }
    return rotation[options.length % rotation.length];
}

/** The declared option `label` means, matched by {@link normalizeSelectLabel}. */
function optionFor(
    options: SelectOption[] | undefined,
    label: string,
): SelectOption | undefined {
    const key = normalizeSelectLabel(label);
    return options?.find(
        (option) => normalizeSelectLabel(option.label) === key,
    );
}

/**
 * Two of a column's options that are one label under the shared key, if it has
 * any — `["Yes", "yes"]` declares one category twice.
 */
function duplicateOptionLabels(
    options: readonly Pick<SelectOption, "label">[] | null | undefined,
): [string, string] | undefined {
    const seen = new Map<string, string>();
    for (const option of options ?? []) {
        const key = normalizeSelectLabel(option.label);
        const first = seen.get(key);
        if (first !== undefined) return [first, option.label];
        seen.set(key, option.label);
    }
    return undefined;
}

/**
 * `options` with each definition trimmed and empty ones dropped, or the cap
 * they break: {@link MAX_SELECT_DEFINITION_CHARS} per definition and
 * {@link MAX_SELECT_DEFINITIONS_CHARS} across the column.
 */
function cleanDefinitions(
    op: string,
    columnId: string,
    options: readonly UpdateColumnOption[],
): SelectOption[] | Failure {
    let total = 0;
    const cleaned: SelectOption[] = [];
    for (const option of options) {
        const { description, ...rest } = option;
        if (description != null && typeof description !== "string") {
            return fail(
                "invalid_mutation",
                `${op}: column "${columnId}": the definition of "${option.label}" must be a string`,
            );
        }
        const definition = description?.trim();
        if (!definition) {
            cleaned.push(rest);
            continue;
        }
        const length = codePointLength(definition);
        if (length > MAX_SELECT_DEFINITION_CHARS) {
            return fail(
                "too_large",
                `${op}: column "${columnId}": the definition of "${option.label}" exceeds ${MAX_SELECT_DEFINITION_CHARS} characters`,
            );
        }
        total += length;
        cleaned.push({ ...rest, description: definition });
    }
    if (total > MAX_SELECT_DEFINITIONS_CHARS) {
        return fail(
            "too_large",
            `${op}: column "${columnId}": its option definitions exceed ${MAX_SELECT_DEFINITIONS_CHARS} characters together`,
        );
    }
    return cleaned;
}

/** Every select label the cells of `columnId` hold, in row order, with repeats. */
function* selectLabels(draft: Draft, columnId: string): Generator<string> {
    for (const row of draft.spec.rows) {
        const value = row.cells[columnId]?.value;
        if (value?.kind === "select") yield value.label;
    }
}

/** An accepted `update_column.options`: the new list, and the cells it re-spells. */
interface OptionsPlan {
    options: SelectOption[];
    /** Old spelling → new spelling, for the labels whose wording moved. */
    respell: Map<string, string>;
}

/**
 * What an `options` update would do, or why it is refused.
 *
 * Options are **add-only**: the two lists are paired by
 * {@link normalizeSelectLabel}, so the update may re-spell a label it already
 * has and append ones it does not, but a label the cells still hold has to
 * survive it. What survives is the invariant every renderer leans on: after any
 * mutation, every cell's label is one of its column's options.
 */
function planOptions(
    draft: Draft,
    column: Column,
    incoming: UpdateColumnOption[],
): OptionsPlan | Failure {
    // The colours the update keeps, known before the first new label is given
    // one: a label further down the list that holds on to blue must not have
    // blue handed to a new category above it.
    const reserved = new Set<SelectColor>();
    for (const option of incoming) {
        const color =
            option.color ?? optionFor(column.options, option.label)?.color;
        if (color) reserved.add(color);
    }

    const clash = duplicateOptionLabels(incoming);
    if (clash) {
        return fail(
            "invalid_mutation",
            `update_column: column "${column.id}" lists "${clash[0]}" and "${clash[1]}" as two options, which are one label`,
        );
    }

    const planned: UpdateColumnOption[] = [];
    for (const option of incoming) {
        // A label the column already has keeps the colour it had, so
        // re-spelling one does not repaint the table.
        const previous = optionFor(column.options, option.label);
        const color =
            option.color ??
            previous?.color ??
            nextSelectColor(planned, reserved);
        const next: UpdateColumnOption = color
            ? { label: option.label, color }
            : { label: option.label };
        // An option sent without a definition keeps the one it had.
        const description =
            "description" in option ? option.description : previous?.description;
        if (description != null) next.description = description;
        planned.push(next);
    }
    const options = cleanDefinitions("update_column", column.id, planned);
    if (isFailure(options)) return options;
    const byKey = new Map<string, SelectOption>();
    for (const option of options)
        byKey.set(normalizeSelectLabel(option.label), option);

    const dropped = new Set<string>();
    const respell = new Map<string, string>();
    for (const label of selectLabels(draft, column.id)) {
        const option = byKey.get(normalizeSelectLabel(label));
        if (!option) dropped.add(label);
        else if (option.label !== label) respell.set(label, option.label);
    }
    if (dropped.size > 0) {
        const labels = [...dropped].map((label) => `"${label}"`).join(", ");
        return fail(
            "invalid_mutation",
            `update_column: options for column "${column.id}" would drop ${labels}, which its cells still use; a narrower vocabulary is a new column`,
        );
    }
    return { options, respell };
}

/**
 * Writes an accepted plan: the new option list, and the cells whose label was
 * only re-worded. Re-spelling does **not** set `stale` — the question did not
 * change, only how its answer is written down.
 */
function applyOptions(draft: Draft, column: Column, plan: OptionsPlan): void {
    column.options = plan.options;
    if (plan.respell.size === 0) return;
    for (const row of draft.spec.rows) {
        const value = row.cells[column.id]?.value;
        if (value?.kind !== "select") continue;
        const label = plan.respell.get(value.label);
        if (label === undefined) continue;
        const writable = writableRow(draft, row.id);
        if (!writable) continue;
        writable.cells[column.id] = {
            ...(writable.cells[column.id] as AnsweredCell),
            value: { ...value, label },
        };
    }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

function updateColumn(
    draft: Draft,
    mutation: UpdateColumnMutation,
): Failure | undefined {
    const column = writableColumn(draft, mutation.column);
    if (!column) {
        return fail(
            "unknown_column",
            `update_column: column "${mutation.column}" does not exist`,
        );
    }
    if (mutation.header !== undefined && typeof mutation.header !== "string") {
        return fail(
            "invalid_mutation",
            `update_column: column "${column.id}": header must be a string`,
        );
    }

    // Planned before anything is written, so a refused options update leaves
    // the column and its cells exactly as they were.
    let options: OptionsPlan | undefined;
    if (mutation.options != null) {
        const planned = planOptions(draft, column, mutation.options);
        if (isFailure(planned)) return planned;
        options = planned;
    } else if (mutation.options === null) {
        const used = [...selectLabels(draft, column.id)];
        if (used.length) {
            return fail(
                "invalid_mutation",
                `update_column: options for column "${column.id}" would drop "${used[0]}", which its cells still use; a narrower vocabulary is a new column`,
            );
        }
    }

    const question = questionHash(column);
    const vocabulary = optionVocabulary(column);

    if (mutation.header !== undefined) column.header = mutation.header;
    if (mutation.description !== undefined)
        setOptional(column, "description", mutation.description);
    if (options) applyOptions(draft, column, options);
    else if (mutation.options === null) setOptional(column, "options", null);
    if (mutation.priority !== undefined)
        setOptional(column, "priority", mutation.priority);

    // A write planned against the column before this change no longer
    // lands: its question, or a label it may write, moved.
    const questionChanged = questionHash(column) !== question;
    if (questionChanged || optionVocabulary(column) !== vocabulary)
        column.revision = (column.revision ?? 0) + 1;

    // The answers under the column were given to the previous question (its
    // description or an option definition), so they are marked rather than
    // dropped: the value is still the best thing anyone has until the column
    // is re-run. A header, colour or re-spelling is not a new question.
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

/**
 * The column's options as the revision sees them: each label exactly as
 * spelled with its definition, in label order. A colour or the order of the
 * list does not count; a re-spelling, a definition, an addition or a
 * removal does.
 */
function optionVocabulary(column: Column): string {
    return JSON.stringify(
        (column.options ?? [])
            .map((option) => [option.label, option.description ?? null])
            .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)),
    );
}

/**
 * `after` with each column's revision carried over from `before` and advanced
 * where its question or option vocabulary changed between the two, however
 * the change was made: a whole-spec write or a revert moves columns without
 * `update_column`. Never lowers a revision. Returns `after` itself when
 * nothing moves.
 */
export function carryColumnRevisions(before: TableSpec | null, after: TableSpec): TableSpec {
    if (!before) return after;
    const previous = new Map(before.columns.map((column) => [column.id, column]));
    let changed = false;
    const columns = after.columns.map((column) => {
        const old = previous.get(column.id);
        if (!old) return column;
        const base = old.revision ?? 0;
        const moved =
            questionHash(old) !== questionHash(column) ||
            optionVocabulary(old) !== optionVocabulary(column);
        const revision = Math.max(column.revision ?? 0, moved ? base + 1 : base);
        if (revision === (column.revision ?? 0)) return column;
        changed = true;
        return { ...column, revision };
    });
    return changed ? { ...after, columns } : after;
}

/**
 * Sets a field from a mutation, where null means "clear". The wire keeps an
 * explicit null so a cleared field reads the same in both implementations.
 */
function setOptional<T extends object, K extends keyof T>(
    target: T,
    key: K,
    value: unknown,
): void {
    (target as Record<string, unknown>)[key as string] = value;
}

function removeColumns(
    draft: Draft,
    mutation: RemoveColumnsMutation,
): Failure | undefined {
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

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function addRows(draft: Draft, mutation: AddRowsMutation): Failure | undefined {
    for (const incoming of mutation.rows) {
        if (!incoming?.id) {
            return fail("invalid_mutation", "add_rows: a row has no id");
        }
        // The cells a row carries are cell writes like any other: they name a
        // column that exists, meet the select vocabulary and the cell limits,
        // and writing one answers it against the current question.
        const cells: Row["cells"] = {};
        for (const [columnId, cell] of Object.entries(incoming.cells ?? {})) {
            const columnAt = draft.columnIndex.get(columnId);
            const column =
                columnAt === undefined
                    ? undefined
                    : draft.spec.columns[columnAt];
            if (!column) {
                return fail(
                    "unknown_column",
                    `add_rows: column "${columnId}" does not exist (row "${incoming.id}")`,
                );
            }
            const canonical = canonicalCell(
                draft,
                column,
                cell,
                `row "${incoming.id}"`,
            );
            if (isFailure(canonical)) return canonical;
            cells[columnId] = canonical;
        }

        const fields = withoutEmptyDocuments(incoming);
        const existing = writableRow(draft, incoming.id);
        if (existing) {
            // Upsert: the incoming cells win, everything the incoming row does
            // not mention survives. Empty documents say the row has none.
            const { cells: _cells, ...rest } = fields;
            Object.assign(existing, rest);
            if (clearsDocuments(incoming)) delete existing.documents;
            existing.cells = { ...existing.cells, ...cells };
            continue;
        }
        const rows = rowsOf(draft);
        draft.rowIndex.set(incoming.id, rows.length);
        draft.ownRows.add(incoming.id);
        rows.push({ ...fields, cells });
    }
    return undefined;
}

/** Whether the row names its documents as none: an empty list or null. */
function clearsDocuments(row: Row): boolean {
    return (
        "documents" in row &&
        (row.documents === null ||
            (Array.isArray(row.documents) && row.documents.length === 0))
    );
}

/** The row without an empty `documents` list (or null), which means none. */
function withoutEmptyDocuments(row: Row): Row {
    if (!clearsDocuments(row)) return row;
    const { documents: _documents, ...rest } = row;
    return rest;
}

function sameDocuments(
    a: readonly string[] | undefined,
    b: readonly string[] | undefined,
): boolean {
    const left = new Set(a ?? []);
    const right = new Set(b ?? []);
    return left.size === right.size && [...left].every((id) => right.has(id));
}

function updateRow(
    draft: Draft,
    mutation: UpdateRowMutation,
): Failure | undefined {
    if (!draft.rowIndex.has(mutation.row)) {
        if (draft.skipMissing) {
            draft.skipped.push({ row: mutation.row, reason: "row_removed" });
            return undefined;
        }
        return fail(
            "unknown_row",
            `update_row: row "${mutation.row}" does not exist`,
        );
    }
    const documents = mutation.documents;
    if (
        documents !== undefined &&
        documents !== null &&
        !(
            Array.isArray(documents) &&
            documents.every((id) => typeof id === "string" && id.length > 0)
        )
    )
        return fail(
            "invalid_mutation",
            `update_row: the documents of "${mutation.row}" are a list of document ids`,
        );
    const failure = mutation.failure;
    if (
        failure !== undefined &&
        failure !== null &&
        !(
            typeof failure === "object" &&
            typeof failure.code === "string" &&
            failure.code.length > 0 &&
            typeof failure.message === "string" &&
            failure.message.length > 0
        )
    )
        return fail(
            "invalid_mutation",
            `update_row: the failure of "${mutation.row}" names a code and a message`,
        );
    const expected = mutation.expected_documents;
    if (
        expected !== undefined &&
        expected !== null &&
        !(
            Array.isArray(expected) &&
            expected.every((id) => typeof id === "string" && id.length > 0)
        )
    )
        return fail(
            "invalid_mutation",
            `update_row: the expected documents of "${mutation.row}" are a list of document ids`,
        );
    const current = draft.spec.rows[draft.rowIndex.get(mutation.row)!];
    if (
        expected !== undefined &&
        !sameDocuments(expected ?? undefined, current.documents)
    ) {
        draft.skipped.push({ row: mutation.row, reason: "documents_changed" });
        return undefined;
    }
    const row = writableRow(draft, mutation.row)!;
    if (documents !== undefined) {
        const next = documents?.length ? [...documents] : undefined;
        // A failure is about the document that was read, so new documents
        // get a fresh try.
        if (!sameDocuments(next, row.documents)) delete row.failure;
        if (next) row.documents = next;
        else delete row.documents;
    }
    if (failure !== undefined) {
        if (failure === null) delete row.failure;
        else row.failure = { code: failure.code, message: failure.message };
    }
    return undefined;
}

function removeRows(
    draft: Draft,
    mutation: RemoveRowsMutation,
): Failure | undefined {
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

function setCells(
    draft: Draft,
    mutation: SetCellsMutation,
): Failure | undefined {
    for (const write of mutation.cells) {
        const columnAt = draft.columnIndex.get(write.column);
        const column =
            columnAt === undefined ? undefined : draft.spec.columns[columnAt];
        if (!column) {
            if (draft.skipMissing) {
                draft.skipped.push({
                    row: write.row,
                    column: write.column,
                    reason: "column_removed",
                });
                continue;
            }
            return fail(
                "unknown_column",
                `set_cells: column "${write.column}" does not exist`,
            );
        }
        if (!draft.rowIndex.has(write.row)) {
            if (draft.skipMissing) {
                draft.skipped.push({
                    row: write.row,
                    column: write.column,
                    reason: "row_removed",
                });
                continue;
            }
            return fail(
                "unknown_row",
                `set_cells: row "${write.row}" does not exist`,
            );
        }
        if (!("cell" in write) || write.cell === undefined) {
            return fail(
                "invalid_mutation",
                `set_cells: the write to "${write.row}/${write.column}" names no cell`,
            );
        }
        const rowAt = draft.rowIndex.get(write.row)!;
        const existing = draft.spec.rows[rowAt].cells[write.column];
        const deletion = isDeletion(write.cell);
        if (write.reset !== undefined && typeof write.reset !== "boolean") {
            return fail(
                "invalid_mutation",
                `set_cells: the reset of "${write.row}/${write.column}" must be true or false`,
            );
        }
        if (write.reset && !deletion) {
            return fail(
                "invalid_mutation",
                `set_cells: a reset of "${write.row}/${write.column}" deletes the cell; it carries no cell`,
            );
        }

        // Only a user write (correction, clear) or an explicit reset may
        // replace or delete a user cell; a deletion carries no provenance.
        if (
            existing?.provenance === "user" &&
            !(!deletion && (write.cell as Cell).provenance === "user") &&
            !(deletion && write.reset === true)
        ) {
            draft.skipped.push({
                row: write.row,
                column: write.column,
                reason: "user_cell",
            });
            continue;
        }
        if (
            write.revision != null &&
            write.revision !== (column.revision ?? 0)
        ) {
            draft.skipped.push({
                row: write.row,
                column: write.column,
                reason: "column_changed",
            });
            continue;
        }
        if (
            write.question_hash != null &&
            write.question_hash !== questionHash(column)
        ) {
            draft.skipped.push({
                row: write.row,
                column: write.column,
                reason: "question_changed",
            });
            continue;
        }
        if (
            write.expected_documents !== undefined &&
            !sameDocuments(
                write.expected_documents ?? undefined,
                draft.spec.rows[rowAt].documents,
            )
        ) {
            draft.skipped.push({
                row: write.row,
                column: write.column,
                reason: "documents_changed",
            });
            continue;
        }

        const row = writableRow(draft, write.row)!;
        if (deletion) {
            delete row.cells[write.column];
            continue;
        }
        const canonical = canonicalCell(
            draft,
            column,
            write.cell as Cell,
            `cell "${write.row}/${write.column}"`,
        );
        if (isFailure(canonical)) return canonical;
        row.cells[write.column] = canonical;
    }
    return undefined;
}

function setMeta(draft: Draft, mutation: SetMetaMutation): Failure | undefined {
    const copied = (value: object | null) =>
        value === null ? null : { ...value };
    if (mutation.title !== undefined)
        setOptional(draft.spec, "title", mutation.title);
    if (mutation.description !== undefined)
        setOptional(draft.spec, "description", mutation.description);
    if (mutation.sort !== undefined)
        setOptional(draft.spec, "sort", copied(mutation.sort));
    if (mutation.capabilities !== undefined)
        setOptional(draft.spec, "capabilities", copied(mutation.capabilities));
    if (mutation.cost_estimate !== undefined)
        setOptional(
            draft.spec,
            "cost_estimate",
            copied(mutation.cost_estimate),
        );
    return undefined;
}

function removeSources(
    draft: Draft,
    mutation: RemoveSourcesMutation,
): Failure | undefined {
    const sources = draft.spec.sources ?? [];
    const known = new Set(sources.map((source) => source.id));
    for (const id of mutation.sources) {
        if (!known.has(id)) {
            return fail(
                "unknown_source",
                `remove_sources: source "${id}" does not exist`,
            );
        }
    }
    const doomed = new Set(mutation.sources);
    draft.spec.sources = sources.filter((source) => !doomed.has(source.id));
    const kept: Row[] = [];
    for (const row of draft.spec.rows) {
        if (!row.origin?.length) {
            kept.push(row);
            continue;
        }
        const remaining = row.origin.filter((o) => !doomed.has(o.source));
        if (!remaining.length) continue;
        kept.push(
            remaining.length === row.origin.length
                ? row
                : { ...row, origin: remaining },
        );
    }
    draft.spec.rows = kept;
    draft.rowsCopied = true;
    draft.ownRows = new Set(
        [...draft.ownRows].filter((id) => kept.some((row) => row.id === id)),
    );
    draft.rowIndex = indexById(kept);
    return undefined;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Per-column counts, so a header can say "3 not reported" without walking
 * the rows. `unattempted` counts only the rows a filler would cover: in-scope rows
 * for extraction columns, every row for other question columns; those of rows
 * with a `failure` count as `in_failed_rows` instead. `distribution` is
 * present only where a column has a countable vocabulary.
 */
export interface TableSummaryColumn {
    type: ColumnType;
    role?: ColumnRole;
    system?: true;
    answered: number;
    not_reported: number;
    /** Failed answers; failed rows are `in_failed_rows`. */
    failed: number;
    cleared: number;
    unattempted: number;
    /** Unattempted cells of rows with a `failure`. */
    in_failed_rows: number;
    /** By {@link isStale}: the question or the row's documents changed. */
    stale: number;
    /**
     * Filler cells with the review mark ({@link needsReview}): kept for
     * evaluation, shown by no surface and stripped before the chat model
     * reads a summary.
     */
    needs_review: number;
    /** Filler answers read from the title and abstract only. */
    title_abstract_only: number;
    distribution?: Record<string, number>;
}

export interface TableSummary {
    rows: number;
    /** Every column in the spec, system ones included. */
    columns: number;
    /** Source entries. */
    sources: number;
    /** Rows in scope for extraction columns. */
    in_scope_rows: number;
    /** Rows with a `failure`. */
    failed_rows: number;
    /** Cells whose `provenance` is `"user"`. */
    user_edits: number;
    /** Keyed by column id, in declaration order. */
    columns_detail: Record<string, TableSummaryColumn>;
}

const OUTCOME_COUNTS: readonly CellOutcome[] = [
    "answered",
    "not_reported",
    "failed",
    "cleared",
];

/**
 * What a chat card, a status line and a column header read instead of walking
 * a megabyte of spec: one pass over rows × columns, no allocation per cell.
 */
export function summarize(spec: TableSpec): TableSummary {
    const inScope = spec.rows.map((row) => rowInScope(spec, row));
    const summary: TableSummary = {
        rows: spec.rows.length,
        columns: spec.columns.length,
        sources: spec.sources?.length ?? 0,
        in_scope_rows: inScope.filter(Boolean).length,
        failed_rows: 0,
        user_edits: 0,
        columns_detail: {},
    };

    for (const column of spec.columns) {
        const detail: TableSummaryColumn = {
            type: column.type,
            answered: 0,
            not_reported: 0,
            failed: 0,
            cleared: 0,
            unattempted: 0,
            in_failed_rows: 0,
            stale: 0,
            needs_review: 0,
            title_abstract_only: 0,
        };
        if (column.role) detail.role = column.role;
        if (column.system) detail.system = true;
        if (column.type === "select" || column.type === "boolean")
            detail.distribution = {};
        summary.columns_detail[column.id] = detail;
    }

    spec.rows.forEach((row, index) => {
        const failedRow = row.failure != null;
        if (failedRow) summary.failed_rows += 1;
        for (const column of spec.columns) {
            const detail = summary.columns_detail[column.id];
            const cell = row.cells[column.id];
            if (!cell) {
                if (
                    isFillableColumn(column) &&
                    (inScope[index] || !isExtractionColumn(column))
                ) {
                    if (failedRow) detail.in_failed_rows += 1;
                    else detail.unattempted += 1;
                }
                continue;
            }
            if (OUTCOME_COUNTS.includes(cell.outcome))
                detail[cell.outcome] += 1;
            if (isStale(row, cell)) detail.stale += 1;
            if (needsReview(column, cell)) detail.needs_review += 1;
            if (cell.outcome === "answered" && isTitleAbstractOnly(cell))
                detail.title_abstract_only += 1;
            if (cell.provenance === "user") summary.user_edits += 1;
            const value = cell.value;
            if (!value || !detail.distribution) continue;
            if (value.kind === "select") {
                detail.distribution[value.label] =
                    (detail.distribution[value.label] ?? 0) + 1;
            } else if (value.kind === "boolean") {
                const key = value.value ? "true" : "false";
                detail.distribution[key] = (detail.distribution[key] ?? 0) + 1;
            }
        }
    });

    return summary;
}
