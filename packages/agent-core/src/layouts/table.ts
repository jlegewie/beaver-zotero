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
 * - Actions are declarative. `capabilities.row_actions` names the verbs
 *   (import, reveal, open) and the host resolves them against `Row.ref`; a
 *   rendering without a host simply omits them.
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
    /** The per-column question. For extraction columns this is the extraction prompt. */
    description?: string;
    /** `select` only: the category set, so filters can enumerate it without scanning rows. */
    options?: SelectOption[];
    /** `number` only: unit shown with the values ("%", "USD"). */
    unit?: string;
    /** Defaults: true except for `reference` and `link`. */
    sortable?: boolean;
    /** Default true. */
    filterable?: boolean;
    /** Reserved for cell editing; default false. */
    editable?: boolean;
    width?: "narrow" | "medium" | "wide" | "fill";
    /** Compact renderings show only `primary` columns; the rest appear on row expand. */
    priority?: "primary" | "secondary";
    /** Default `end` for number/date, `start` otherwise. */
    align?: "start" | "end";
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

/** Content revealed when a cell is expanded. Never participates in sorting. */
export type CellDetails =
    | { kind: "text"; text: string; label?: string }
    | { kind: "list"; items: string[]; label?: string };

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
    /** Verbs the host may offer per row, resolved against `Row.ref`. */
    row_actions?: RowAction[];
    /** Reserved. */
    allow_add_column?: boolean;
    /** Reserved. */
    allow_add_row?: boolean;
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
    /** Initial sort. Static renderings (snapshot) bake it in. */
    sort?: TableSort;
    capabilities?: TableCapabilities;
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
    if (column.sortable != null) return column.sortable;
    return column.type !== "reference" && column.type !== "link";
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
