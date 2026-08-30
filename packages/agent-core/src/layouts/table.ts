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
 *   filled, a missing `value` means "not reported" and renders as an em dash.
 * - The spec is also the stored file. A snapshot embeds it verbatim and is then
 *   the only copy of the table's state, so it carries its own format version
 *   (`spec_version`), identity (`key`) and revision (`version`), and
 *   {@link readSpec} is the guarded way back in: a spec written by a newer
 *   format is refused rather than misread.
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

/**
 * Format version of a `TableSpec`. Bumped when the **shape** changes in a way
 * an older reader would misread; see {@link readSpec}, which refuses anything
 * higher. Unrelated to `TableSpec.version`, which counts edits to one table.
 */
export const TABLE_SPEC_VERSION = 1;

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

/**
 * What a column *means*, so a client can find it without guessing from its
 * header ("Include?" and "Screening decision" are the same column).
 *
 * The vocabulary is **add-only**: these values are persisted inside stored
 * tables, so a name may be added but never renamed or repurposed — a rename
 * silently changes the meaning of every table already on disk. A reader that
 * does not know a role must ignore it, not reject the column.
 */
export type ColumnRole =
    | "screening_decision"
    | "exclusion_reason"
    | "relevance"
    | "quality"
    | "quote";

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
    /**
     * What this column is for, when it plays a known part in a workflow — see
     * {@link ColumnRole}. Absent ⇒ an ordinary column, handled as any other.
     */
    role?: ColumnRole;
    /**
     * A column the producer owns: the model neither sees nor writes it, and it
     * is enrichment rather than an answer (publication year, DOI). Hidden by
     * default in renderings, which show it only on request.
     */
    system?: true;
    /**
     * `select` only: the category set, so filters can enumerate it without
     * scanning rows. Absent ⇒ an **open** select — the writer appends a new
     * label as it meets it — except on a role whose vocabulary is fixed,
     * where a label outside the set is an error, not a new option (see
     * {@link hasFixedVocabulary}).
     */
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
 * A `file` row is a context file the user supplied — not a library item, and
 * not a work with an external identity — so it is nowhere to reveal and
 * nothing to import. `ext_key` is the key its `<citation ext_key=…/>` tags
 * use.
 */
export type RowRef =
    | ({ kind: "item" } & ZoteroItemReference)
    | {
          kind: "external";
          source: ExternalReferenceSource;
          source_id: string;
          reference?: ExternalReference;
      }
    | { kind: "file"; ext_key: string; label?: string };

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
          /** Who it is by. Rendered under the title. */
          subtitle?: string;
          /**
           * Where it appeared — journal, publisher, repository. Separate from
           * `subtitle` because a renderer sets it apart: it is emphasised
           * differently, and a taller row gives it its own line.
           */
          venue?: string;
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
    /**
     * Where the value came from. `extracted`: an extraction pass read a
     * document for it. `asserted`: the model wrote it from what it already
     * knew, without reading anything. `user`: a local edit. `imported`:
     * carried in from elsewhere. Optional because a cleared or pending cell
     * has nothing to attribute — but a cell **with** a value and no provenance
     * is a spec error, since an unattributed value is not evidence.
     */
    provenance?: "extracted" | "asserted" | "user" | "imported";
    /**
     * A caveat about a value that is present. `unsure`: a best guess.
     * `unsourced`: a real value that no citation could be attached to. Both are
     * distinct from an absent value, which means the source reports nothing.
     */
    flag?: "unsure" | "unsourced";
    /**
     * The cell was filled for an earlier version of the column's question and
     * has not been re-answered since. Set on a column's existing cells when its
     * question changes, cleared by the next write to the cell.
     */
    stale?: true;
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
    /**
     * Render-scoped id: it becomes the DOM id prefix of every row and cell, so
     * two tables on one page do not collide. Not the table's identity — that
     * is {@link TableSpec.key}.
     */
    id: string;
    /**
     * Format version of this spec — absent ⇒ 1. See
     * {@link TABLE_SPEC_VERSION}. This says nothing about the table's content;
     * `version` does that.
     */
    spec_version?: number;
    /**
     * Identity of the stored table: the Zotero item key of the snapshot
     * attachment that holds it. Absent on a spec that has never been stored.
     * Distinct from `id`, which is only about rendering.
     */
    key?: string;
    /**
     * The table's revision number, monotone, stamped by the store on every
     * write. Absent ⇒ not yet persisted.
     */
    version?: number;
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
// Reading a stored spec
// ---------------------------------------------------------------------------

export type ReadSpecResult =
    | { ok: true; spec: TableSpec }
    | { ok: false; reason: "unsupported_version"; specVersion: number }
    | { ok: false; reason: "invalid"; detail: string };

function invalidSpec(detail: string): ReadSpecResult {
    return { ok: false, reason: "invalid", detail };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

/**
 * The guarded way into a stored spec: takes parsed JSON and answers whether
 * this build can open it.
 *
 * A stored table is the only copy of its state, so the two failures it
 * distinguishes matter. `unsupported_version` means the file was written by a
 * newer format — the caller should open it read-only (or refuse) rather than
 * parse it with today's assumptions and write back something lossy.
 * `invalid` means it is not a table at all.
 *
 * The check is deliberately shallow and forward-compatible: it never rejects an
 * unknown enum value, because a future `Column.role` or `Cell.flag` must round
 * trip through an older client untouched. Deep agreement between columns and
 * cells is {@link validateTableSpec}'s job: a quality report about a spec we
 * could read, not a reason to refuse one.
 */
export function readSpec(raw: unknown): ReadSpecResult {
    if (!isPlainObject(raw)) return invalidSpec("spec is not an object");

    const specVersion = raw.spec_version;
    if (specVersion !== undefined) {
        if (typeof specVersion !== "number" || !Number.isFinite(specVersion))
            return invalidSpec("spec_version is not a number");
        if (specVersion > TABLE_SPEC_VERSION)
            return { ok: false, reason: "unsupported_version", specVersion };
    }

    if (!isNonEmptyString(raw.id)) return invalidSpec("id is missing or empty");
    if (!Array.isArray(raw.columns))
        return invalidSpec("columns is not an array");
    if (!Array.isArray(raw.rows)) return invalidSpec("rows is not an array");

    for (const column of raw.columns) {
        if (!isPlainObject(column) || !isNonEmptyString(column.id))
            return invalidSpec("a column has no id");
    }
    for (const row of raw.rows) {
        if (!isPlainObject(row) || !isNonEmptyString(row.id))
            return invalidSpec("a row has no id");
        // `cells` is what every walker of a row indexes into, so a row without
        // one is unreadable rather than merely questionable — better said
        // here than thrown inside a renderer.
        if (!isPlainObject(row.cells))
            return invalidSpec(`row "${row.id}" has no cells map`);
    }

    return { ok: true, spec: raw as unknown as TableSpec };
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
    if (ref.kind === "file") return `file:${ref.ext_key}`;
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

/**
 * Roles whose option set is fixed: a label outside `options` is an error, not a
 * new option. A screening decision is the one vocabulary a reviewer must be
 * able to count on — "include" / "exclude" and nothing invented beside them.
 */
export function hasFixedVocabulary(column: Column): boolean {
    return column.role === "screening_decision";
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
    // A context file is not a library item, and its cells are about the file
    // rather than about a work, so scanning them for a library copy would only
    // find a coincidence.
    if (row.ref?.kind === "file") return false;
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
    // A context file has no library identity: nothing to reveal, and nothing to
    // import either — importing means adding a bibliographic record, which a
    // loose file does not have. So it offers no verbs at all rather than
    // falling through to "import" on the strength of not being in the library.
    if (row.ref.kind === "file") return [];
    const declared = row.actions ?? spec.capabilities?.row_actions ?? [];
    const inLibrary = isRowInLibrary(row);
    return declared.filter((action) =>
        action === "import" ? !inLibrary : inLibrary,
    );
}

export function getCell(row: Row, columnId: string): Cell | undefined {
    return row.cells[columnId];
}

/**
 * Plain-text form of a value, for CSV export and text filters. Citation tags
 * are stripped: they are markup, so leaving them in would put `<citation …/>`
 * into a spreadsheet cell and let a search for "cit" match every sourced value.
 */
export function cellValueText(value: CellValue | undefined): string {
    if (!value) return "";
    switch (value.kind) {
        case "text":
            return stripCitationTags(value.text);
        case "number":
            return value.display ?? String(value.value);
        case "date":
            return value.display ?? value.value;
        case "boolean":
            return value.value ? "true" : "false";
        case "select":
            return value.label;
        case "reference":
            return [value.display_name, value.subtitle, value.venue]
                .filter(Boolean)
                .join(" — ");
        case "link":
            return value.label ?? value.url;
    }
}

/**
 * How much of the table is actually filled. A review table's honesty is the
 * point of it, so the counts a footer reports are computed once, here, rather
 * than by each renderer walking the rows its own way.
 *
 * `empty` counts cells the producer reports nothing for — in an extraction
 * table that is "the paper does not report this", a finding rather than a gap.
 */
export interface TableCoverage {
    rows: number;
    cells: number;
    filled: number;
    empty: number;
    pending: number;
    error: number;
    errorRows: number;
}

export function summarizeCoverage(
    spec: TableSpec,
    rows: Row[] = spec.rows,
): TableCoverage {
    const coverage: TableCoverage = {
        rows: rows.length,
        cells: rows.length * spec.columns.length,
        filled: 0,
        empty: 0,
        pending: 0,
        error: 0,
        errorRows: 0,
    };
    for (const row of rows) {
        if (row.status === "error") coverage.errorRows += 1;
        for (const column of spec.columns) {
            const cell = row.cells[column.id];
            if (cell?.status === "pending") coverage.pending += 1;
            else if (cell?.status === "error") coverage.error += 1;
            else if (cell?.value) coverage.filled += 1;
            else coverage.empty += 1;
        }
    }
    return coverage;
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
            // Sorted on the prose, not on the markup wrapped around it.
            return stripCitationTags(value.text).toLocaleLowerCase();
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

/**
 * The text without its `<citation …/>` tags, for the plain-text forms of a
 * value (CSV, filters, sort keys). Whitespace left behind by a removed tag is
 * collapsed so a stripped sentence reads normally.
 */
export function stripCitationTags(text: string): string {
    return text
        .replace(CITATION_TAG_RE, "")
        .replace(/[^\S\r\n]{2,}/g, " ")
        .trim();
}

function cellTexts(cell: Cell): string[] {
    const texts: string[] = [];
    if (cell.value?.kind === "text") texts.push(cell.value.text);
    if (cell.details?.kind === "text") texts.push(cell.details.text);
    if (cell.details?.kind === "list") texts.push(...cell.details.items);
    return texts;
}

/**
 * Every citation key one cell references, de-duplicated, in document order.
 * A non-text column keeps its evidence in `Cell.details`, so both sides of a
 * cell are read.
 */
function citationKeysInCell(cell: Cell): string[] {
    const seen = new Set<string>();
    for (const text of cellTexts(cell)) {
        for (const key of citationKeysInText(text)) seen.add(key);
    }
    return [...seen];
}

/** Every citation key referenced by any cell of the table, de-duplicated, in document order. */
export function citationKeysInTable(spec: TableSpec): string[] {
    const seen = new Set<string>();
    for (const row of spec.rows) {
        for (const column of spec.columns) {
            const cell = row.cells[column.id];
            if (!cell) continue;
            for (const key of citationKeysInCell(cell)) seen.add(key);
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
        | "fixed_vocabulary_violation"
        | "unknown_sort_column"
        | "unknown_anchor_column"
        | "invalid_column_progress"
        | "missing_cost_estimate"
        | "missing_decision_details"
        | "missing_provenance"
        | "unresolved_citation";
    message: string;
    row_id?: string;
    column_id?: string;
}

/**
 * Structural problems that would make a rendering wrong or misleading, plus the
 * claims a stored table has to be able to keep on its own: every citation tag
 * resolves from the spec's own metadata, every value says where it came from,
 * and a screening decision carries its reason. Producers should treat any issue
 * as an error; renderers may still draw a spec with issues but must not assume
 * the invariants below.
 *
 * This is a report about a spec we could already read — {@link readSpec} is
 * the gate that decides whether we can read it at all.
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

    // An add-column affordance bills per row, so a table that offers one and
    // cannot state the price is a spec error, not a rendering choice.
    if (spec.capabilities?.allow_add_column && !spec.cost_estimate) {
        issues.push({
            code: "missing_cost_estimate",
            message: "Table allows adding columns but carries no cost_estimate",
        });
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

    const citationIndex = citationsByKey(spec.citations);

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

            // A stored table outlives the run that produced it, so every
            // citation tag it carries has to resolve from the table's own
            // metadata — otherwise the evidence is gone and only the claim is
            // left. Details count too: a non-text column keeps its citations
            // there.
            for (const key of citationKeysInCell(cell)) {
                if (citationIndex[key]) continue;
                issues.push({
                    code: "unresolved_citation",
                    row_id: row.id,
                    column_id: columnId,
                    message: `Citation "${key}" in cell "${cellIdFor(row.id, columnId)}" has no entry in the table's citations`,
                });
            }

            const value = cell.value;
            if (!value) continue;

            if (!cell.provenance) {
                issues.push({
                    code: "missing_provenance",
                    row_id: row.id,
                    column_id: columnId,
                    message: `Cell "${cellIdFor(row.id, columnId)}" has a value but no provenance`,
                });
            }

            // A screening decision without its reason cannot be reviewed, only
            // trusted — so an undocumented one is a spec error, not a style
            // choice.
            if (column.role === "screening_decision" && !cell.details) {
                issues.push({
                    code: "missing_decision_details",
                    row_id: row.id,
                    column_id: columnId,
                    message: `Cell "${cellIdFor(row.id, columnId)}" records a screening decision with no details explaining it`,
                });
            }

            const expected = VALUE_KIND_BY_COLUMN_TYPE[column.type];
            if (value.kind !== expected) {
                issues.push({
                    code: "value_kind_mismatch",
                    row_id: row.id,
                    column_id: columnId,
                    message: `Cell "${cellIdFor(row.id, columnId)}" has kind "${value.kind}" in a "${column.type}" column`,
                });
            }
            // On an open select an unknown label is one the options list has
            // not caught up with; on a fixed vocabulary it is a value nobody
            // agreed to, which is a different (and worse) kind of wrong.
            if (
                value.kind === "select" &&
                column.options &&
                !column.options.some((o) => o.label === value.label)
            ) {
                const fixed = hasFixedVocabulary(column);
                issues.push({
                    code: fixed
                        ? "fixed_vocabulary_violation"
                        : "unknown_select_label",
                    row_id: row.id,
                    column_id: columnId,
                    message: fixed
                        ? `Select label "${value.label}" is not in the fixed vocabulary of column "${columnId}"`
                        : `Select label "${value.label}" is not among the options of column "${columnId}"`,
                });
            }
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
