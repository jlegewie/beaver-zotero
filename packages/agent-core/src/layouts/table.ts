/**
 * Table layout spec.
 *
 * A `TableSpec` is the client-agnostic data model behind every table Beaver
 * renders: the compact sidebar table, the full-width window table and the
 * static snapshot HTML all consume the same object. The rule that makes that
 * possible is that the spec is **self-contained**: every cell carries what it
 * needs to render (display strings, item refs, citation metadata), so no
 * renderer looks anything up at render time.
 *
 * Shape conventions:
 * - Columns declare the contract (`type`, the extraction `description`, sort /
 *   filter affordances); cells carry a discriminated `value` so a renderer can
 *   switch on `value.kind` without consulting the column. `validateTableSpec`
 *   flags the two disagreeing.
 * - Default-valued fields are omitted on the wire: `status` absent means
 *   filled, `provenance` absent means AI-produced, a missing `value` means
 *   "not reported" and renders as an em dash.
 * - Actions are declarative. `capabilities.row_actions` names the verbs the
 *   table offers and `rowActions()` resolves them for one row — a row already in
 *   the library gets reveal/open, one that is not gets import. A row may narrow
 *   the set with `Row.actions`; a rendering without a host omits them entirely.
 * - One column is the **anchor** (`anchor_column_id`): it owns row identity, is
 *   the sticky column under horizontal scroll and is the target of reveal.
 * - A column is a question, not just a label. `Column.description` is the line
 *   rendered under the header — for an extraction column it is the extraction
 *   prompt — and `Column.details` carries the long form behind it.
 * - Citations: text cells may contain inline `<citation …/>` tags exactly like
 *   run text, and `TableSpec.citations` carries the matching `Citation`
 *   metadata so a stored or exported table resolves them offline.
 */

import type { Citation } from "../types/citations";
import type { ZoteroItemReference } from "../types/zotero";
import type { ExternalReference } from "../types/externalReferences";
import {
    normalizeCitationTag,
    parseRawCitationAttributes,
    requestedCitationKey,
} from "../citations/citationGrammar";
import { collectCitationKeys } from "../citations/atoms";

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export type ColumnType =
    | "text"
    | "number"
    | "date"
    | "boolean"
    | "select"
    | "reference"
    | "link";

/** Notion-style palette for `select` categories. */
export type SelectColor =
    | "gray"
    | "blue"
    | "green"
    | "yellow"
    | "orange"
    | "red"
    | "purple";

export interface SelectOption {
    label: string;
    color?: SelectColor;
}

export interface Column {
    /** snake_case identifier, unique within the table. */
    id: string;
    header: string;
    type: ColumnType;
    /**
     * The column's question, rendered as a second line under the header — not a
     * tooltip. For an extraction column this is the extraction prompt, which is
     * why the header is where it belongs: the column *is* the contract.
     */
    description?: string;
    /**
     * The long form behind `description`: the full prompt when the header line
     * is clamped, coding rules, unit conventions. Revealed from the header, the
     * same way `Cell.details` is revealed from a cell.
     */
    details?: Details;
    /** `select` only: the category set, so filters can enumerate it without scanning rows. */
    options?: SelectOption[];
    /** `number` only: unit shown with the values ("%", "USD"). */
    unit?: string;
    /** Default true for every type; set false to opt a column out. */
    sortable?: boolean;
    /** Default true. */
    filterable?: boolean;
    /** Reserved for cell editing; default false. */
    editable?: boolean;
    /**
     * Rendered width in CSS px, or `"fill"` to take the remaining space. Absent
     * ⇒ the renderer's default for this `type`, which is what most producers
     * should emit: widths are a rendering concern and differ per surface.
     */
    width?: number | "fill";
    /**
     * How a value longer than the row handles the overflow. Default `"clamp"`:
     * clamped to the row height and revealed on expand, so rows stay a uniform
     * height. `"nowrap"` keeps a value on one line and ellipsises it.
     */
    wrap?: "clamp" | "nowrap";
    /** Compact renderings show only `primary` columns; the rest appear on row expand. */
    priority?: "primary" | "secondary";
    /** Default `end` for number/date, `start` otherwise. */
    align?: "start" | "end";
    /**
     * Absent ⇒ ready. `"filling"` means a producer is populating this column
     * right now; its unfilled cells carry `status: "pending"`.
     */
    status?: "filling";
    /**
     * Progress of a `filling` column, so a header can show "6 of 9" without
     * counting cells on every render.
     */
    progress?: ColumnProgress;
}

export interface ColumnProgress {
    done: number;
    total: number;
}

export type ExternalReferenceSource = "semantic_scholar" | "openalex";

/**
 * What a row is about. Row actions (reveal / open / import) resolve against it.
 * An external row carries the full `reference` when the producer has it, since
 * importing needs the bibliographic payload and the spec must stay self-contained.
 */
export type RowRef =
    | ({ kind: "item" } & ZoteroItemReference)
    | {
          kind: "external";
          source: ExternalReferenceSource;
          source_id: string;
          reference?: ExternalReference;
      };

export interface Row {
    /** Stable id — see {@link rowIdFor}. Becomes a DOM id in the snapshot rendering. */
    id: string;
    ref?: RowRef;
    /** Column id → cell. A missing entry is an empty cell. */
    cells: Record<string, Cell>;
    /**
     * Whether this row's item is in the user's library — it decides whether the
     * row offers reveal or import. Absent ⇒ derived by {@link isRowInLibrary}:
     * true for an `item` ref, or for an external ref whose reference cell lists
     * `library_items`. Producers set it explicitly when they know better; a
     * client that imports a row updates it locally.
     */
    in_library?: boolean;
    /** Verbs for this row only. Absent ⇒ the table's `capabilities.row_actions`. */
    actions?: RowAction[];
    /** Row-level outcome, e.g. extraction failed for this paper. */
    status?: "error";
    error?: string;
}

export type CellValue =
    /** Inline markdown; may contain `<citation …/>` tags. */
    | { kind: "text"; text: string }
    | { kind: "number"; value: number; display?: string }
    /** ISO `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; sorts lexically. */
    | { kind: "date"; value: string; display?: string }
    | { kind: "boolean"; value: boolean }
    /** One category; must be in `Column.options` when those are declared. */
    | { kind: "select"; label: string }
    /**
     * A bibliographic item, library or external. Identity lives on `Row.ref`;
     * `library_items` lists library copies of an external reference so the
     * in-library state resolves without a lookup.
     */
    | {
          kind: "reference";
          display_name: string;
          subtitle?: string;
          item_type?: string;
          library_items?: ZoteroItemReference[];
      }
    | { kind: "link"; url: string; label?: string };

export type CellValueKind = CellValue["kind"];

/**
 * Secondary content revealed on expand — of a cell, or of a column header.
 * Never participates in sorting, filtering or export.
 */
export type Details =
    | { kind: "text"; text: string; label?: string }
    | { kind: "list"; items: string[]; label?: string };

/** The cell-side name for {@link Details}. */
export type CellDetails = Details;

export interface Cell {
    /** Absent ⇒ the producer reports nothing for this cell ("—"). */
    value?: CellValue;
    details?: CellDetails;
    /** Absent ⇒ filled. */
    status?: "pending" | "error";
    error?: string;
    /** Absent ⇒ AI-produced. */
    provenance?: "user" | "imported";
}

export type RowAction = "reveal" | "open" | "import";

export interface TableCapabilities {
    /** Default true. */
    sortable?: boolean;
    /** Default true. */
    filterable?: boolean;
    /** Compact renderings may expand a row to show secondary columns. */
    expandable_rows?: boolean;
    /** Verbs the host may offer per row — see {@link rowActions}. */
    row_actions?: RowAction[];
    /**
     * The table may gain a column the user defines (name, type, question). The
     * affordance must show `TableSpec.cost_estimate` before anything runs; in a
     * rendering that cannot run one, it is absent rather than dead.
     */
    allow_add_column?: boolean;
    /** The table may gain rows (more papers) after it was first produced. */
    allow_add_row?: boolean;
}

/**
 * What a run over this table costs, so an add-column / re-extract affordance can
 * state it before spending anything.
 */
export interface TableCostEstimate {
    /** Credits per row for one column-wide run. */
    per_row_credits: number;
    /** Rough wall clock for the whole run, in seconds. */
    estimated_seconds?: number;
}

export interface TableSort {
    column_id: string;
    direction: "asc" | "desc";
}

export interface TableSpec {
    id: string;
    title?: string;
    caption?: string;
    columns: Column[];
    rows: Row[];
    /**
     * The column that owns row identity: sticky under horizontal scroll and the
     * target of reveal. Absent ⇒ {@link anchorColumn} picks the first
     * `reference` column, else the first column.
     */
    anchor_column_id?: string;
    /** Initial sort. Static renderings (snapshot) bake it in. */
    sort?: TableSort;
    capabilities?: TableCapabilities;
    /** Cost of one column-wide run; required wherever `allow_add_column` is set. */
    cost_estimate?: TableCostEstimate;
    /** Metadata for every `<citation …/>` tag in any cell, same model as run citations. */
    citations?: Citation[];
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * Stable row id derived from what the row is about, so the same paper gets the
 * same id across regenerations (and snapshot annotations stay anchored).
 */
export function rowIdFor(ref: RowRef): string {
    if (ref.kind === "item")
        return `item:${ref.library_ref ?? ref.library_id}:${ref.zotero_key}`;
    return `ext:${ref.source}:${ref.source_id}`;
}

export function cellIdFor(rowId: string, columnId: string): string {
    return `${rowId}/${columnId}`;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const VALUE_KIND_BY_COLUMN_TYPE: Record<ColumnType, CellValueKind> = {
    text: "text",
    number: "number",
    date: "date",
    boolean: "boolean",
    select: "select",
    reference: "reference",
    link: "link",
};

export function isColumnSortable(column: Column): boolean {
    return column.sortable ?? true;
}

export function columnWrap(column: Column): "clamp" | "nowrap" {
    return column.wrap ?? "clamp";
}

/**
 * The column that owns row identity. Explicit when the producer says so,
 * otherwise the first `reference` column and finally the first column, so a
 * table without a bibliographic column still has an anchor.
 */
export function anchorColumn(spec: TableSpec): Column | undefined {
    if (spec.anchor_column_id) {
        const named = spec.columns.find((c) => c.id === spec.anchor_column_id);
        if (named) return named;
    }
    return spec.columns.find((c) => c.type === "reference") ?? spec.columns[0];
}

export function isColumnFilterable(column: Column): boolean {
    return column.filterable ?? true;
}

export function columnAlign(column: Column): "start" | "end" {
    if (column.align) return column.align;
    return column.type === "number" || column.type === "date" ? "end" : "start";
}

export function isCellEmpty(cell: Cell | undefined): boolean {
    return cell?.value == null;
}

/**
 * Whether the row's item is in the user's library. The explicit flag wins; an
 * `item` ref is by definition in a library; otherwise an external row counts as
 * in-library once one of its reference cells lists a library copy.
 */
export function isRowInLibrary(row: Row): boolean {
    if (row.in_library != null) return row.in_library;
    if (row.ref?.kind === "item") return true;
    for (const cell of Object.values(row.cells)) {
        const value = cell.value;
        if (
            value?.kind === "reference" &&
            (value.library_items?.length ?? 0) > 0
        )
            return true;
    }
    return false;
}

/**
 * The verbs this row actually offers, in declared order. The table (or the row)
 * names the candidates; applicability is decided here so a renderer never draws
 * "import" on a row that is already in the library, or "reveal" on one that is
 * nowhere to reveal. A row with no `ref` offers nothing.
 */
export function rowActions(spec: TableSpec, row: Row): RowAction[] {
    if (!row.ref) return [];
    const declared = row.actions ?? spec.capabilities?.row_actions ?? [];
    const inLibrary = isRowInLibrary(row);
    return declared.filter((action) =>
        action === "import" ? !inLibrary : inLibrary,
    );
}

export function getCell(row: Row, columnId: string): Cell | undefined {
    return row.cells[columnId];
}

/** Plain-text form of a value, for CSV export and text filters. */
export function cellValueText(value: CellValue | undefined): string {
    if (!value) return "";
    switch (value.kind) {
        case "text":
            return value.text;
        case "number":
            return value.display ?? String(value.value);
        case "date":
            return value.display ?? value.value;
        case "boolean":
            return value.value ? "true" : "false";
        case "select":
            return value.label;
        case "reference":
            return value.subtitle
                ? `${value.display_name} — ${value.subtitle}`
                : value.display_name;
        case "link":
            return value.label ?? value.url;
    }
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

type SortKey = number | string | null;

/** Sort key of a cell; `null` means empty and sorts last in either direction. */
export function cellSortKey(cell: Cell | undefined): SortKey {
    const value = cell?.value;
    if (!value) return null;
    switch (value.kind) {
        case "number":
            return Number.isFinite(value.value) ? value.value : null;
        case "boolean":
            return value.value ? 1 : 0;
        case "date":
            return value.value;
        case "text":
            return value.text.toLocaleLowerCase();
        case "select":
            return value.label.toLocaleLowerCase();
        case "reference":
            return value.display_name.toLocaleLowerCase();
        case "link":
            return (value.label ?? value.url).toLocaleLowerCase();
    }
}

function compareSortKeys(a: SortKey, b: SortKey): number {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
}

/**
 * Rows ordered by `sort`. Empty cells always sort last; the original order is
 * kept among equal keys. Returns the input array when the column is unknown.
 */
export function sortRows(spec: TableSpec, sort: TableSort | undefined): Row[] {
    if (!sort) return spec.rows;
    const column = spec.columns.find((c) => c.id === sort.column_id);
    if (!column) return spec.rows;
    const dir = sort.direction === "desc" ? -1 : 1;
    return spec.rows
        .map((row, index) => ({
            row,
            index,
            key: cellSortKey(row.cells[column.id]),
        }))
        .sort((a, b) => {
            if (a.key === null && b.key === null) return a.index - b.index;
            if (a.key === null) return 1;
            if (b.key === null) return -1;
            const cmp = compareSortKeys(a.key, b.key) * dir;
            return cmp !== 0 ? cmp : a.index - b.index;
        })
        .map((entry) => entry.row);
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export type Filter =
    /** Case-insensitive substring match on the value's text form. */
    | { column_id: string; kind: "contains"; text: string }
    /** Inclusive range on number or date values; either bound may be open. */
    | {
          column_id: string;
          kind: "range";
          min?: number | string;
          max?: number | string;
      }
    /** Value's select label is one of `labels`. */
    | { column_id: string; kind: "in"; labels: string[] }
    | { column_id: string; kind: "equals"; value: boolean }
    /** Keep only rows with (or without) a value in the column. */
    | { column_id: string; kind: "empty"; empty: boolean };

function matchesFilter(cell: Cell | undefined, filter: Filter): boolean {
    const value = cell?.value;
    if (filter.kind === "empty") return (value == null) === filter.empty;
    if (!value) return false;
    switch (filter.kind) {
        case "contains":
            return cellValueText(value)
                .toLocaleLowerCase()
                .includes(filter.text.toLocaleLowerCase());
        case "range": {
            const key =
                value.kind === "number" || value.kind === "date"
                    ? value.value
                    : null;
            if (key == null) return false;
            if (filter.min != null && compareSortKeys(key, filter.min) < 0)
                return false;
            if (filter.max != null && compareSortKeys(key, filter.max) > 0)
                return false;
            return true;
        }
        case "in":
            return (
                value.kind === "select" && filter.labels.includes(value.label)
            );
        case "equals":
            return value.kind === "boolean" && value.value === filter.value;
    }
}

/** Rows matching every filter (AND). Filters on unknown columns are ignored. */
export function filterRows(spec: TableSpec, filters: Filter[]): Row[] {
    const known = new Set(spec.columns.map((c) => c.id));
    const active = filters.filter((f) => known.has(f.column_id));
    if (active.length === 0) return spec.rows;
    return spec.rows.filter((row) =>
        active.every((f) => matchesFilter(row.cells[f.column_id], f)),
    );
}

/** Distinct select labels present in a column, in first-seen order. */
export function selectLabelsInColumn(
    spec: TableSpec,
    columnId: string,
): string[] {
    const seen = new Set<string>();
    for (const row of spec.rows) {
        const value = row.cells[columnId]?.value;
        if (value?.kind === "select") seen.add(value.label);
    }
    return [...seen];
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

const CITATION_TAG_RE = /<citation\b([^>]*?)\/?>/gi;

/** Lookup keys of every `<citation …/>` tag in a text, in document order (unparseable tags are skipped). */
export function citationKeysInText(text: string): string[] {
    const keys: string[] = [];
    for (const match of text.matchAll(CITATION_TAG_RE)) {
        const normalized = normalizeCitationTag(
            parseRawCitationAttributes(match[1] || ""),
        );
        if (normalized.ok) keys.push(requestedCitationKey(normalized.ref));
        else if (normalized.rawIdentity)
            keys.push(`invalid:${normalized.rawIdentity}`);
    }
    return keys;
}

function cellTexts(cell: Cell): string[] {
    const texts: string[] = [];
    if (cell.value?.kind === "text") texts.push(cell.value.text);
    if (cell.details?.kind === "text") texts.push(cell.details.text);
    if (cell.details?.kind === "list") texts.push(...cell.details.items);
    return texts;
}

/** Every citation key referenced by any cell of the table, de-duplicated, in document order. */
export function citationKeysInTable(spec: TableSpec): string[] {
    const seen = new Set<string>();
    for (const row of spec.rows) {
        for (const column of spec.columns) {
            const cell = row.cells[column.id];
            if (!cell) continue;
            for (const text of cellTexts(cell)) {
                for (const key of citationKeysInText(text)) seen.add(key);
            }
        }
    }
    return [...seen];
}

/** Citation metadata keyed by every lookup key it answers to (requested, resolved, raw tag). */
export function citationsByKey(
    citations: Citation[] | undefined,
): Record<string, Citation> {
    const byKey: Record<string, Citation> = {};
    for (const citation of citations ?? []) {
        for (const key of collectCitationKeys(citation)) byKey[key] = citation;
    }
    return byKey;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface TableSpecIssue {
    code:
        | "duplicate_column_id"
        | "duplicate_row_id"
        | "unknown_column"
        | "value_kind_mismatch"
        | "unknown_select_label"
        | "unknown_sort_column"
        | "unknown_anchor_column"
        | "invalid_column_progress"
        | "unresolved_citation";
    message: string;
    row_id?: string;
    column_id?: string;
}

/**
 * Structural problems that would make a rendering wrong or misleading. Producers
 * should treat any issue as an error; renderers may still draw a spec with
 * issues but must not assume the invariants below.
 */
export function validateTableSpec(spec: TableSpec): TableSpecIssue[] {
    const issues: TableSpecIssue[] = [];
    const columns = new Map<string, Column>();

    for (const column of spec.columns) {
        if (columns.has(column.id)) {
            issues.push({
                code: "duplicate_column_id",
                column_id: column.id,
                message: `Duplicate column id "${column.id}"`,
            });
        }
        columns.set(column.id, column);
    }

    for (const column of spec.columns) {
        const progress = column.progress;
        if (!progress) continue;
        if (
            !Number.isFinite(progress.done) ||
            !Number.isFinite(progress.total) ||
            progress.total < 0 ||
            progress.done < 0 ||
            progress.done > progress.total
        ) {
            issues.push({
                code: "invalid_column_progress",
                column_id: column.id,
                message: `Column "${column.id}" has progress ${progress.done}/${progress.total}`,
            });
        }
    }

    if (spec.anchor_column_id && !columns.has(spec.anchor_column_id)) {
        issues.push({
            code: "unknown_anchor_column",
            column_id: spec.anchor_column_id,
            message: `Anchor column "${spec.anchor_column_id}" does not exist`,
        });
    }

    if (spec.sort && !columns.has(spec.sort.column_id)) {
        issues.push({
            code: "unknown_sort_column",
            column_id: spec.sort.column_id,
            message: `Sort column "${spec.sort.column_id}" does not exist`,
        });
    }

    const rowIds = new Set<string>();
    for (const row of spec.rows) {
        if (rowIds.has(row.id)) {
            issues.push({
                code: "duplicate_row_id",
                row_id: row.id,
                message: `Duplicate row id "${row.id}"`,
            });
        }
        rowIds.add(row.id);

        for (const [columnId, cell] of Object.entries(row.cells)) {
            const column = columns.get(columnId);
            if (!column) {
                issues.push({
                    code: "unknown_column",
                    row_id: row.id,
                    column_id: columnId,
                    message: `Row "${row.id}" has a cell for unknown column "${columnId}"`,
                });
                continue;
            }
            const value = cell.value;
            if (!value) continue;
            const expected = VALUE_KIND_BY_COLUMN_TYPE[column.type];
            if (value.kind !== expected) {
                issues.push({
                    code: "value_kind_mismatch",
                    row_id: row.id,
                    column_id: columnId,
                    message: `Cell "${cellIdFor(row.id, columnId)}" has kind "${value.kind}" in a "${column.type}" column`,
                });
            }
            if (
                value.kind === "select" &&
                column.options &&
                !column.options.some((o) => o.label === value.label)
            ) {
                issues.push({
                    code: "unknown_select_label",
                    row_id: row.id,
                    column_id: columnId,
                    message: `Select label "${value.label}" is not among the options of column "${columnId}"`,
                });
            }
        }
    }

    const byKey = citationsByKey(spec.citations);
    for (const key of citationKeysInTable(spec)) {
        if (!byKey[key]) {
            issues.push({
                code: "unresolved_citation",
                message: `Citation "${key}" has no entry in the table's citations`,
            });
        }
    }

    return issues;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function csvEscape(field: string): string {
    return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/**
 * RFC 4180 CSV of the table: one header row of column headers, then one row per
 * table row in the given order (pass `sortRows(...)` / `filterRows(...)` output
 * to export a view). Details are not exported; citation tags stay inline.
 */
export function toCsv(spec: TableSpec, rows: Row[] = spec.rows): string {
    const header = spec.columns.map((c) => csvEscape(c.header)).join(",");
    const lines = rows.map((row) =>
        spec.columns
            .map((c) => csvEscape(cellValueText(row.cells[c.id]?.value)))
            .join(","),
    );
    return [header, ...lines].join("\r\n");
}
