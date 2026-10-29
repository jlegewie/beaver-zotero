/**
 * Table layout spec.
 *
 * A `TableSpec` is the client-agnostic data model behind every table Beaver
 * renders: the compact sidebar table, the full-width window table and the
 * static snapshot HTML all consume the same object. The rule that makes that
 * possible is that the spec is **self-contained**: every cell carries what it
 * needs to render, so no renderer looks anything up at render time.
 *
 * Shape conventions:
 * - Columns declare the contract (`type`, the question in `description`, sort /
 *   filter affordances); cells carry a discriminated `value` so a renderer can
 *   switch on `value.kind` without consulting the column. `validateTableSpec`
 *   flags the two disagreeing.
 * - Default-valued fields are omitted on the wire. A missing cell is
 *   unattempted; a written cell always names its `outcome` and `provenance`.
 * - A stored spec carries its own format version (`spec_version`), identity
 *   (`key`) and revision (`version`), and {@link readSpec} is the guarded way
 *   back in: a spec written by a newer format is refused rather than misread.
 * - Rows are discriminated by what they are about (`Row.ref`, a `RowRef`), and
 *   everything that depends on that — in-library state, which verbs apply and
 *   where they point — is answered by `./rowKinds`, never by branching on
 *   `ref.kind` in a renderer. Row ids are opaque.
 * - One column is the **anchor** (`anchor_column_id`): it owns row identity, is
 *   the sticky column under horizontal scroll and is the target of reveal.
 * - Evidence is item-less: each entry locates text in the attachment the row
 *   names, and `./tableCitations` assembles a chat citation from the row plus
 *   one entry.
 * - The engine in `./tableMutations` mirrors the backend's; the shared fixture
 *   corpus holds the two to the same results.
 */

import type { ExternalReference } from "../types/externalReferences";
import { anchorValueKindsFor, rowKindsIn, type RowAction } from "./rowKinds";

export {
    ROW_ACTIONS,
    ROW_KINDS,
    anchorValueKindsFor,
    annotationComment,
    annotationTitle,
    annotationTypeLabel,
    isRowInLibrary,
    rowActionTarget,
    rowActions,
    rowKindOf,
    rowKindsIn,
    rowPrimaryAction,
    rowTypeColor,
    rowTypeLabel,
} from "./rowKinds";
export type {
    RowAction,
    RowActionTarget,
    RowKind,
    RowKindDef,
} from "./rowKinds";

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

/** Column types a filler answers; `reference` and `link` belong to system columns. */
export const MODEL_COLUMN_TYPES: readonly ColumnType[] = [
    "text",
    "number",
    "date",
    "boolean",
    "select",
];

/** System column ids, filled from the row's reference and never by the filler. */
export const REFERENCE_COLUMN_ID = "_reference";
export const YEAR_COLUMN_ID = "_year";
export const IDENTIFIER_COLUMN_ID = "_identifier";

/**
 * Limits shared with the backend. A write that grows a table past one is
 * refused with `too_large`; shrinking is always allowed.
 */
export const MAX_ROWS = 1000;
export const MAX_MODEL_COLUMNS = 30;
/** Compact JSON of one cell's evidence list. */
export const MAX_EVIDENCE_BYTES = 6000;
/** UTF-8 bytes of one cell's reasoning. */
export const MAX_REASONING_BYTES = 1000;
/** Compact JSON of the whole spec. */
export const MAX_SPEC_BYTES = 10_000_000;
/** Characters (code points) of one select option's definition. */
export const MAX_SELECT_DEFINITION_CHARS = 300;
/** Characters (code points) of all option definitions of one column. */
export const MAX_SELECT_DEFINITIONS_CHARS = 3000;

/**
 * Notion-style palette for `select` categories, in the order a writer hands
 * colours out to new categories. `gray` is first because it is also the
 * renderer's fallback for an option that declares no colour.
 */
export const SELECT_COLORS = [
    "gray",
    "blue",
    "green",
    "yellow",
    "orange",
    "red",
    "purple",
] as const;

export type SelectColor = (typeof SELECT_COLORS)[number];

export interface SelectOption {
    label: string;
    color?: SelectColor;
    /**
     * What the category means, so it is applied the same way to every row.
     * Part of the column's question ({@link questionHash}): changing it marks
     * the column's cells stale.
     */
    description?: string;
}

/**
 * What a column *means* in a workflow. Persisted inside stored tables, so a
 * value may be added but never renamed. `criterion` columns are filled over
 * every row; `decision` drives the scope rule ({@link rowInScope}).
 *
 * A reader that does not know a role ignores the column: it renders as an
 * ordinary read-only column, is never filled, never counts as unattempted and
 * is not part of the scope rule. A newer client's role therefore cannot turn
 * into an extraction question in an older one.
 */
export type ColumnRole = string;

export interface Column {
    /** snake_case identifier, unique within the table. */
    id: string;
    header: string;
    type: ColumnType;
    /**
     * The column's question, rendered as a second line under the header.
     * Changing it marks the column's cells stale.
     */
    description?: string;
    /** The long form behind `description`, revealed from the header. */
    details?: Details;
    /** What this column is for in a workflow; absent ⇒ an ordinary column. */
    role?: ColumnRole;
    /**
     * A column the producer owns (reference, year, identifier): filled from the
     * row's reference, never by a filler, and hidden by default in renderings.
     */
    system?: true;
    /**
     * `select` only: the category set, so filters can enumerate it without
     * scanning rows. Absent ⇒ an **open** select — the writer appends a new
     * label as it meets it.
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
     * ⇒ the renderer's default for this `type`.
     */
    width?: number | "fill";
    /**
     * How a value longer than the row handles the overflow. Default `"clamp"`:
     * clamped to the row height and revealed on expand. `"nowrap"` keeps a value
     * on one line and ellipsises it.
     */
    wrap?: "clamp" | "nowrap";
    /** Compact renderings show only `primary` columns; the rest appear on row expand. */
    priority?: "primary" | "secondary";
    /** Overrides {@link columnAlign}, which centres a boolean and ends a number or date. */
    align?: "start" | "end";
    /** Absent ⇒ ready. `"filling"` means a producer is populating this column now. */
    status?: "filling";
    /** Progress of a `filling` column, so a header can show "6 of 9". */
    progress?: ColumnProgress;
}

export interface ColumnProgress {
    done: number;
    total: number;
}

export type ExternalReferenceSource = "openalex";

/**
 * A Zotero object as a stored table names it. `library_ref` (`u` /
 * `g<groupID>`) is the identity; `library_id` is this device's rowid and
 * optional, because a table travels between devices.
 */
export interface ZoteroRowReference {
    library_ref: string;
    zotero_key: string;
    library_id?: number;
}

/**
 * What a row is about — its identity, and nothing about how it looks. The
 * reference cell carries the display; the ref carries what the row's verbs
 * need. `./rowKinds` reads it; renderers do not branch on `kind` themselves.
 */
export type RowRef =
    | ItemRowRef
    | AttachmentRowRef
    | AnnotationRowRef
    | ExternalRowRef
    | FileRowRef;

/** A regular (bibliographic) library item. */
export interface ItemRowRef extends ZoteroRowReference {
    kind: "item";
    /**
     * The attachment that was read for this row, which `open` targets. Absent ⇒
     * the host picks the item's best attachment when clicked.
     */
    attachment?: ZoteroRowReference;
}

/** A file attachment in its own right, not folded onto its parent. */
export interface AttachmentRowRef extends ZoteroRowReference {
    kind: "attachment";
    /** The bibliographic item it belongs to; absent for a standalone attachment. */
    parent_item?: ZoteroRowReference;
}

/** An annotation. `open` lands in the reader on it; `reveal` selects its item. */
export interface AnnotationRowRef extends ZoteroRowReference {
    kind: "annotation";
    /** The attachment the annotation is on. */
    attachment: ZoteroRowReference;
    /** The bibliographic item above the attachment, when there is one. */
    parent_item?: ZoteroRowReference;
}

/** A Zotero object of any kind — what the three library kinds have in common. */
export type ZoteroRowRef = ItemRowRef | AttachmentRowRef | AnnotationRowRef;

/**
 * A work found outside the library. Carries the full `reference` when the
 * producer has it: importing needs the bibliographic payload, and its
 * `library_items` say whether a copy is already in the library.
 */
export interface ExternalRowRef {
    kind: "external";
    source: ExternalReferenceSource;
    source_id: string;
    reference?: ExternalReference;
}

/**
 * A context file the user supplied — not a library item and not a work with an
 * external identity.
 */
export interface FileRowRef {
    kind: "file";
    ext_key: string;
    label?: string;
}

export function isZoteroRowRef(ref: RowRef): ref is ZoteroRowRef {
    return (
        ref.kind === "item" ||
        ref.kind === "attachment" ||
        ref.kind === "annotation"
    );
}

/** The source entry that added a row, and when (`YYYY-MM-DD`). */
export interface RowOrigin {
    source: string;
    date: string;
}

export interface Row {
    /**
     * Opaque, allocated when the row is created and never derived from the
     * reference, so the reference can change without moving cells. Becomes a
     * DOM id in the snapshot rendering.
     */
    id: string;
    ref?: RowRef;
    /** Column id → cell. A missing entry is an unattempted cell. */
    cells: Record<string, Cell>;
    /**
     * Whether this row's subject is in the user's library. Absent ⇒ derived
     * from the ref's kind by `isRowInLibrary`.
     */
    in_library?: boolean;
    /** Every source entry that produced the row. */
    origin?: RowOrigin[];
    /** Verbs for this row only. Absent ⇒ the table's `capabilities.row_actions`. */
    actions?: RowAction[];
    /** Row-level outcome, e.g. the row could not be processed at all. */
    status?: "error";
    error?: string;
}

export type CellValue =
    /** Inline markdown. */
    | { kind: "text"; text: string }
    | { kind: "number"; value: number; display?: string }
    /** ISO `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; sorts lexically. */
    | { kind: "date"; value: string; display?: string }
    | { kind: "boolean"; value: boolean }
    /** One category; must be in `Column.options` when those are declared. */
    | { kind: "select"; label: string }
    /**
     * A bibliographic item, library or external, or a file: what a citation
     * needs to render the row without loading Zotero data. Identity lives on
     * `Row.ref`.
     */
    | {
          kind: "reference";
          /** Short label, as on a chat citation ("Smith et al. 2023"). */
          display_name: string;
          /** The work's title. */
          title?: string;
          /** Who it is by. */
          subtitle?: string;
          /** Where it appeared — journal, publisher, repository. */
          venue?: string;
          /** Zotero item type (`journalArticle`, `attachment`, …), for the icon. */
          item_type?: string;
          /** The formatted bibliographic reference. */
          formatted_citation?: string;
          /** Attachments only: `pdf`, `epub`, `snapshot`, … refines the icon. */
          content_kind?: string;
      }
    /**
     * An annotation, described for display. Only meaningful in a `reference`
     * column, next to an `annotation` ref.
     */
    | {
          kind: "annotation";
          /** `highlight`, `underline`, `note`, `text` or `image`. */
          annotation_type?: string;
          /** The highlighted or underlined passage. */
          text?: string;
          comment?: string;
          /** Hex or CSS colour; tints the icon. */
          color?: string;
          page_label?: string;
          /** The bibliographic item it belongs to, short form ("Smith 2020"). */
          source_display_name?: string;
      }
    | { kind: "link"; url: string; label?: string };

export type CellValueKind = CellValue["kind"];

/** Secondary content of a column header, revealed on expand. */
export type Details =
    | { kind: "text"; text: string; label?: string }
    | { kind: "list"; items: string[]; label?: string };

/**
 * Text located in the attachment the row names, or a metadata field. Item-less:
 * the row supplies the item, so a full chat citation is assembled from the row
 * plus one entry (see `./tableCitations`).
 */
export interface Evidence {
    /** Locator in the citation grammar ("s243-s250", "s5.6", "p12"); absent for metadata. */
    locator?: string;
    /** The located text. */
    quote: string;
    /** 0-based page index (PDF). */
    page?: number;
    /** `[left, top, right, bottom]` in PDF points, top-left origin. */
    boxes?: number[][];
    /** The metadata field a metadata answer rests on. */
    field?: "title" | "abstract";
}

export type CellOutcome = "answered" | "not_reported" | "failed" | "cleared";

/**
 * Who wrote the cell and from what: the filler from the attachment text
 * (`document`) or from title and abstract (`metadata`), the user, or the
 * producer for the reference, year and identifier columns (`system`).
 */
export type CellProvenance = "document" | "metadata" | "user" | "system";

/**
 * A written cell; absent means unattempted.
 *
 * Invariants, checked by {@link validateTableSpec} and enforced on every write:
 * `value` iff `answered`; `error` iff `failed`, and `error_code` only with
 * it; `evidence` only with `document` or `metadata`; `cleared` only with
 * `user`.
 */
export interface Cell {
    /**
     * `not_reported`: the material does not say — a finding. `cleared`: a
     * user-owned blank the filler never refills.
     */
    outcome: CellOutcome;
    value?: CellValue;
    evidence?: Evidence[];
    /** Short reasoning wherever the answer needed judgment. */
    reasoning?: string;
    provenance: CellProvenance;
    /** A best guess. */
    unsure?: true;
    /**
     * The cell was answered for an earlier version of the column's question and
     * has not been re-answered since.
     */
    stale?: true;
    /**
     * Why a `failed` cell failed, as the cell shows it: one short user-facing
     * sentence written by whoever failed the cell.
     */
    error?: string;
    /** A stable code for the failure, e.g. `download_failed` or `deadline`. */
    error_code?: string;
}

/** One collection, tag or saved search in one library. */
export interface LibraryScope {
    kind: "collection" | "tag" | "saved_search";
    library_ref: string;
    /** Collection or saved-search key. */
    key?: string;
    /** Tag name. */
    tag?: string;
    /** Display name when the entry was made. */
    name?: string;
}

export type SourceType =
    | "items"
    | "library"
    | "library_keyword"
    | "library_semantic"
    | "openalex_keyword";

/**
 * One approved source entry, stored exactly as approved and never edited in
 * place. `items` lists portable item ids or external work ids; `library` takes
 * one collection, tag or saved search as it is in Zotero. The search types are
 * declared for a stable schema and not yet produced.
 */
export interface SourceEntry {
    id: string;
    type: SourceType;
    ids?: string[];
    scope?: LibraryScope;
    query?: string;
    year_from?: number;
    year_to?: number;
    types?: string[];
    languages?: string[];
    limit?: number;
}

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
     * The table may gain a column the user defines. The affordance must show
     * `TableSpec.cost_estimate` before anything runs.
     */
    allow_add_column?: boolean;
    /** The table may gain rows after it was first produced. */
    allow_add_row?: boolean;
}

/** What a run over this table costs, stated before anything is spent. */
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
    /** Format version of this spec — absent ⇒ 1. */
    spec_version?: number;
    /**
     * Identity of the stored table: the Zotero item key of the attachment that
     * holds it. Absent on a spec that has never been stored.
     */
    key?: string;
    /** The table's revision number, stamped by the store on every write. */
    version?: number;
    title?: string;
    /** One sentence: the research question, or what was compared and why. */
    description?: string;
    columns: Column[];
    rows: Row[];
    /** The approved source entries that produced the rows. */
    sources?: SourceEntry[];
    /**
     * The column that owns row identity: sticky under horizontal scroll and the
     * target of reveal. Absent ⇒ {@link anchorColumn} picks the first
     * `reference` column, else the first column.
     */
    anchor_column_id?: string;
    /** Initial sort. Static renderings bake it in. */
    sort?: TableSort;
    capabilities?: TableCapabilities;
    /** Cost of one column-wide run; required wherever `allow_add_column` is set. */
    cost_estimate?: TableCostEstimate;
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

export function cellIdFor(rowId: string, columnId: string): string {
    return `${rowId}/${columnId}`;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Value kinds a column of each type holds. One each, except `reference`: the
 * anchor column describes the row's subject, and a table may mix papers and
 * annotations, so it accepts both display shapes.
 */
const VALUE_KINDS_BY_COLUMN_TYPE: Record<ColumnType, readonly CellValueKind[]> =
    {
        text: ["text"],
        number: ["number"],
        date: ["date"],
        boolean: ["boolean"],
        select: ["select"],
        reference: ["reference", "annotation"],
        link: ["link"],
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
 * Columns a rendering hides until asked: the `system` ones, because they are
 * enrichment rather than answers — with one exception. A `row_type` column
 * shows by default when the table mixes kinds of row (papers beside
 * annotations, a search result beside a library item), since that is when the
 * type is the first thing a reader needs; in a table of one kind the anchor
 * icon already says it.
 */
export function defaultHiddenColumnIds(spec: TableSpec): string[] {
    const mixed = rowKindsIn(spec).size > 1;
    return spec.columns
        .filter((c) => c.system && !(c.role === "row_type" && mixed))
        .map((c) => c.id);
}

/**
 * The fields a row reveals only when expanded, beyond its cells: an
 * annotation's passage and comment, listed under their names.
 */
export function cellExpandedFields(
    cell: Cell | undefined,
): { label: string; details: Details }[] {
    const fields: { label: string; details: Details }[] = [];
    const value = cell?.value;
    if (value?.kind === "annotation") {
        if (value.text)
            fields.push({
                label:
                    value.annotation_type === "text"
                        ? "Text"
                        : "Highlighted text",
                details: { kind: "text", text: value.text },
            });
        if (value.comment)
            fields.push({
                label: "Comment",
                details: { kind: "text", text: value.comment },
            });
    }
    return fields;
}

/** Trailing punctuation {@link normalizeSelectLabel} ignores. */
const TRAILING_PUNCTUATION = /[.,;:!?…]+$/;

/**
 * The key two `select` labels are the same option under: lower-cased, runs of
 * whitespace / `-` / `_` collapsed to one space, trailing punctuation dropped.
 * So `RCT`, `rct` and `RCT.` are one category, and so are `Quasi-experiment`,
 * `Quasi_Experiment` and `quasi experiment`.
 *
 * The **one** key in the system: cell writes match against `Column.options`
 * with it, an open select appends only what it does not already have under it,
 * and `update_column.options` pairs old and new lists by it. Without a single
 * key the same category arrives twice under two spellings, the filter menu
 * offers both and the distribution splits the count between them.
 *
 * Exported because the backend keys the same matching and has to reproduce it
 * step for step — lower-case, `[\s\-_]+` → one space, trim, drop trailing
 * `[.,;:!?…]`, trim — with the mutation fixtures holding the two to each other.
 * The steps are deliberately plain so a Python `re.sub` says the same thing.
 *
 * A label that survives none of that (`"-"`, `"?"`) falls back to the last form
 * that was not empty, so labels made only of punctuation stay distinct instead
 * of all becoming one option under the empty key.
 */
export function normalizeSelectLabel(label: string): string {
    const lowered = label.toLowerCase().trim();
    const collapsed = lowered.replace(/[\s\-_]+/g, " ").trim();
    const key = collapsed.replace(TRAILING_PUNCTUATION, "").trim();
    return key || collapsed || lowered;
}

/**
 * The declared option a select cell's label names (exact match: writes store
 * the option's own spelling), for its colour and definition in one lookup.
 */
export function selectOption(
    column: Pick<Column, "options">,
    label: string,
): SelectOption | undefined {
    return column.options?.find((option) => option.label === label);
}

/**
 * A select column's defined categories as plain text: "Categories", then
 * `Label — definition` per defined option. Undefined when none is defined.
 */
export function categoriesText(
    column: Pick<Column, "options">,
): string | undefined {
    const defined = (column.options ?? []).filter((option) => option.description);
    if (!defined.length) return undefined;
    return [
        "Categories",
        ...defined.map((option) => `${option.label} — ${option.description}`),
    ].join("\n");
}

/**
 * Alignment of a column's values and its header.
 *
 * Boolean centres (a single glyph); number and date end; everything else
 * starts. Header and cell, in both the React grid and the HTML snapshot, must
 * call this — a local copy is how they start to disagree.
 */
export function columnAlign(column: Column): "start" | "end" | "center" {
    if (column.align) return column.align;
    if (column.type === "boolean") return "center";
    return column.type === "number" || column.type === "date" ? "end" : "start";
}

/** True when the cell holds no answer: unattempted, failed or cleared. */
export function isCellEmpty(cell: Cell | undefined): boolean {
    return cell?.value == null && cell?.outcome !== "not_reported";
}

/** An answer or finding taken from title and abstract rather than the attachment. */
export function isMetadataOnly(cell: Cell | undefined): boolean {
    return cell?.provenance === "metadata";
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
            return [
                value.display_name,
                value.title !== value.display_name ? value.title : undefined,
                value.subtitle,
                value.venue,
            ]
                .filter(Boolean)
                .join(" — ");
        case "annotation":
            return [value.text, value.comment].filter(Boolean).join(" — ");
        case "link":
            return value.label ?? value.url;
    }
}

/**
 * How much of the table is actually filled. Computed once, here, rather than
 * by each renderer walking the rows its own way.
 */
export interface TableCoverage {
    rows: number;
    cells: number;
    /** Answered cells. */
    filled: number;
    /** Cells with no answer, in any column: unattempted, failed or cleared. */
    empty: number;
    /** Completed inspections with no reported answer. */
    notReported: number;
    /** Cells whose answer failed. */
    error: number;
    errorRows: number;
    /** Cells answered from metadata only. */
    metadataOnly: number;
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
        notReported: 0,
        error: 0,
        errorRows: 0,
        metadataOnly: 0,
    };
    for (const row of rows) {
        if (row.status === "error") coverage.errorRows += 1;
        for (const column of spec.columns) {
            const cell = row.cells[column.id];
            if (cell?.outcome === "failed") coverage.error += 1;
            if (cell?.value) coverage.filled += 1;
            else {
                coverage.empty += 1;
                if (cell?.outcome === "not_reported") coverage.notReported += 1;
            }
            if (isMetadataOnly(cell)) coverage.metadataOnly += 1;
        }
    }
    return coverage;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

type SortKey = number | string | null;

/**
 * The locale sorting is pinned to.
 *
 * A sorted table is baked into the stored snapshot in the order it was written,
 * so the order has to be a function of the data and nothing else. Left to the
 * host, `toLocaleLowerCase` and `localeCompare` would collate the same titles
 * differently on two installs — which would show up as a spurious reordering
 * when a second device writes the table, and would move the text offsets its
 * annotations are anchored to. Filtering is not pinned: that is a live response
 * to what someone is typing, not something stored.
 */
export const SORT_LOCALE = "en";

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
            return stripCitationTags(value.text).toLocaleLowerCase(SORT_LOCALE);
        case "select":
            return value.label.toLocaleLowerCase(SORT_LOCALE);
        case "reference":
            // Sorted on what the column shows: the title, else the short label.
            return (value.title ?? value.display_name).toLocaleLowerCase(
                SORT_LOCALE,
            );
        case "annotation": {
            const text = value.text ?? value.comment;
            return text ? text.toLocaleLowerCase(SORT_LOCALE) : null;
        }
        case "link":
            return (value.label ?? value.url).toLocaleLowerCase(SORT_LOCALE);
    }
}

/**
 * Orders two sort keys, with `null` (an empty cell) last in **either**
 * direction.
 *
 * Exported because a stored table is sorted twice: row order is baked into the
 * document, and the HTML renderer emits CSS ranks beside it. Those ranks have
 * to come from this comparator — a different one shows up as a table that
 * reorders itself the moment someone clicks the column it was already sorted
 * by. Empty-last in both directions is also why a descending rank cannot be
 * `n - asc`: reversing an ascending order would lead with the empty rows.
 */
export function compareSortKeys(
    a: SortKey,
    b: SortKey,
    direction: TableSort["direction"] = "asc",
): number {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    const cmp =
        typeof a === "number" && typeof b === "number"
            ? a - b
            : String(a).localeCompare(String(b), SORT_LOCALE);
    return direction === "desc" ? -cmp : cmp;
}

/**
 * Rows ordered by `sort`. Empty cells always sort last; the original order is
 * kept among equal keys. Returns the input array when the column is unknown.
 */
export function sortRows(spec: TableSpec, sort: TableSort | undefined): Row[] {
    if (!sort) return spec.rows;
    const column = spec.columns.find((c) => c.id === sort.column_id);
    if (!column) return spec.rows;
    return spec.rows
        .map((row, index) => ({
            row,
            index,
            key: cellSortKey(row.cells[column.id]),
        }))
        .sort((a, b) => {
            const cmp = compareSortKeys(a.key, b.key, sort.direction);
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
// Citation markup in text
// ---------------------------------------------------------------------------

/**
 * Every `<citation …/>` tag, with its raw attributes in group 1. Text values
 * are plain prose; the pattern only strips markup a producer left in one.
 *
 * **Global, so use it only with `matchAll` or `replace`.**
 */
export const CITATION_TAG_RE = /<citation\b([^>]*?)\/?>/gi;

/**
 * The text without its `<citation …/>` tags, for the plain-text forms of a
 * value (CSV, filters, sort keys).
 */
export function stripCitationTags(text: string): string {
    return text
        .replace(CITATION_TAG_RE, "")
        .replace(/[^\S\r\n]{2,}/g, " ")
        .trim();
}

// ---------------------------------------------------------------------------
// Measures shared with the backend
// ---------------------------------------------------------------------------

/** The UTF-8 bytes of a string (the core has no `TextEncoder`). */
export function utf8Bytes(text: string): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i += 1) {
        let code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
                i += 1;
            }
        }
        if (code < 0x80) bytes.push(code);
        else if (code < 0x800)
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
        else if (code < 0x10000)
            bytes.push(
                0xe0 | (code >> 12),
                0x80 | ((code >> 6) & 63),
                0x80 | (code & 63),
            );
        else
            bytes.push(
                0xf0 | (code >> 18),
                0x80 | ((code >> 12) & 63),
                0x80 | ((code >> 6) & 63),
                0x80 | (code & 63),
            );
    }
    return bytes;
}

/** UTF-8 byte length of a string. */
export function utf8Length(text: string): number {
    let bytes = 0;
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                i += 1;
            } else bytes += 3;
        } else bytes += 3;
    }
    return bytes;
}

/** UTF-8 length of the compact JSON form, the measure behind every byte cap. */
export function jsonBytes(value: unknown): number {
    return utf8Length(JSON.stringify(value) ?? "");
}

/** Length in code points, the unit the backend's character caps count in. */
export function codePointLength(text: string): number {
    let length = 0;
    for (const _ of text) length += 1;
    return length;
}

/** Orders strings by code point, as Python compares them. */
function compareCodePoints(a: string, b: string): number {
    const left = a[Symbol.iterator]();
    const right = b[Symbol.iterator]();
    for (;;) {
        const x = left.next();
        const y = right.next();
        if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
        const diff = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
        if (diff !== 0) return diff;
    }
}

/**
 * FNV-1a 64-bit hex digest of a column's question.
 *
 * The question is `type` and `description`, then, only when an option has a
 * definition, the definitions as compact JSON pairs `[key, definition]` sorted
 * by {@link normalizeSelectLabel}. Recolouring, reordering or re-spelling an
 * option, or adding one without a definition, leaves the digest unchanged.
 *
 * A filler sends it with each answer and the engine skips the write when the
 * column's question changed since. The backend computes the same digest; the
 * arithmetic runs on four 16-bit limbs because the core targets no BigInt.
 */
export function questionHash(
    column: Pick<Column, "type" | "description" | "options">,
): string {
    let text = `${column.type}\n${column.description ?? ""}`;
    const definitions = (column.options ?? [])
        .filter((option) => option.description)
        .map((option) => [
            normalizeSelectLabel(option.label),
            option.description as string,
        ])
        .sort(
            (a, b) =>
                compareCodePoints(a[0], b[0]) || compareCodePoints(a[1], b[1]),
        );
    if (definitions.length) text += `\n${JSON.stringify(definitions)}`;
    // Offset basis 0xcbf29ce484222325, least significant limb first.
    let h0 = 0x2325;
    let h1 = 0x8422;
    let h2 = 0x9ce4;
    let h3 = 0xcbf2;
    for (const byte of utf8Bytes(text)) {
        h0 ^= byte;
        // Multiply by the prime 0x100000001b3: 0x1b3 at limb 0, 0x100 at limb 2.
        const t0 = h0 * 0x1b3;
        const t1 = h1 * 0x1b3 + Math.floor(t0 / 0x10000);
        const t2 = h2 * 0x1b3 + h0 * 0x100 + Math.floor(t1 / 0x10000);
        const t3 = h3 * 0x1b3 + h1 * 0x100 + Math.floor(t2 / 0x10000);
        h0 = t0 % 0x10000;
        h1 = t1 % 0x10000;
        h2 = t2 % 0x10000;
        h3 = t3 % 0x10000;
    }
    return [h3, h2, h1, h0]
        .map((limb) => limb.toString(16).padStart(4, "0"))
        .join("");
}

/** A fresh opaque row id that is not in `taken`. */
export function allocateRowId(taken: ReadonlySet<string> = new Set()): string {
    for (;;) {
        const id = `r${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
        if (!taken.has(id)) return id;
    }
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** A question column without a role: the ones the scope rule applies to. */
export function isExtractionColumn(column: Column): boolean {
    return (
        !column.system &&
        MODEL_COLUMN_TYPES.includes(column.type) &&
        !column.role
    );
}

/**
 * A column a filler answers: an extraction column or a criterion. Roles are
 * listed, not excluded, so a role this client does not know is never filled.
 */
export function isFillableColumn(column: Column): boolean {
    return (
        !column.system &&
        MODEL_COLUMN_TYPES.includes(column.type) &&
        (!column.role || column.role === "criterion")
    );
}

function decisionColumn(spec: TableSpec): Column | undefined {
    return spec.columns.find((column) => column.role === "decision");
}

/**
 * The row's screening decision: `include`, `exclude`, `unsure` or undefined.
 * A user cell in the decision column is an override and wins; without one the
 * decision is derived from the criterion cells once screening exists.
 */
export function rowDecision(spec: TableSpec, row: Row): string | undefined {
    const column = decisionColumn(spec);
    if (!column) return undefined;
    const cell = row.cells[column.id];
    if (cell?.provenance === "user" && cell.value?.kind === "select")
        return normalizeSelectLabel(cell.value.label);
    return undefined;
}

/**
 * Scope rule: a row is in scope for extraction columns when the table has no
 * decision column or the row's decision is include.
 */
export function rowInScope(spec: TableSpec, row: Row): boolean {
    return !decisionColumn(spec) || rowDecision(spec, row) === "include";
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
        | "anchor_kind_mismatch"
        | "unknown_select_label"
        | "unknown_sort_column"
        | "unknown_anchor_column"
        | "invalid_column_progress"
        | "missing_cost_estimate"
        | "invalid_cell"
        | "invalid_cell_value"
        | "invalid_column_definition"
        | "duplicate_source_id"
        | "multiple_items_sources"
        | "unknown_origin_source";
    message: string;
    row_id?: string;
    column_id?: string;
}

/** Issues no write may introduce: the engine rejects a batch whose result has one. */
export const WRITE_BLOCKING_ISSUES: ReadonlySet<TableSpecIssue["code"]> =
    new Set<TableSpecIssue["code"]>([
        "invalid_cell",
        "duplicate_source_id",
        "multiple_items_sources",
        "unknown_origin_source",
    ]);

const OUTCOMES: readonly CellOutcome[] = [
    "answered",
    "not_reported",
    "failed",
    "cleared",
];
const PROVENANCES: readonly CellProvenance[] = [
    "document",
    "metadata",
    "user",
    "system",
];

/** The first cell invariant the cell breaks, or undefined. */
export function cellInvariantError(cell: Cell): string | undefined {
    if (!OUTCOMES.includes(cell.outcome))
        return "A cell names an unknown outcome";
    if (!PROVENANCES.includes(cell.provenance))
        return "A cell names an unknown provenance";
    if ((cell.value != null) !== (cell.outcome === "answered"))
        return "A cell has a value exactly when its outcome is answered";
    if ((cell.error != null) !== (cell.outcome === "failed"))
        return "A cell has an error exactly when its outcome is failed";
    if (cell.error_code != null && cell.outcome !== "failed")
        return "Only a failed cell has an error code";
    if (
        cell.evidence?.length &&
        cell.provenance !== "document" &&
        cell.provenance !== "metadata"
    )
        return "Only document or metadata cells carry evidence";
    if (cell.outcome === "cleared" && cell.provenance !== "user")
        return "Only the user clears a cell";
    return undefined;
}

/**
 * Structural problems that would make a rendering wrong or misleading, plus the
 * cell invariants a stored table has to keep. Renderers may still draw a spec
 * with issues but must not assume the invariants.
 *
 * This is a report about a spec we could already read — {@link readSpec} is
 * the gate that decides whether we can read it at all.
 */
export function validateTableSpec(spec: TableSpec): TableSpecIssue[] {
    const issues: TableSpecIssue[] = [];
    const columns = new Map<string, Column>();

    for (const column of spec.columns) {
        if (
            !Object.prototype.hasOwnProperty.call(
                VALUE_KINDS_BY_COLUMN_TYPE,
                column.type,
            ) ||
            typeof column.header !== "string"
        ) {
            issues.push({
                code: "invalid_column_definition",
                column_id: column.id,
                message: "Columns need a supported type and a text header.",
            });
        }
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

    const sourceIds = new Set<string>();
    let itemsSources = 0;
    for (const source of spec.sources ?? []) {
        if (sourceIds.has(source.id)) {
            issues.push({
                code: "duplicate_source_id",
                message: `Duplicate source ${source.id}`,
            });
        }
        sourceIds.add(source.id);
        if (source.type === "items") itemsSources += 1;
    }
    if (itemsSources > 1) {
        issues.push({
            code: "multiple_items_sources",
            message: "A table has at most one items source",
        });
    }

    const anchor = anchorColumn(spec);

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

        for (const origin of row.origin ?? []) {
            if (!sourceIds.has(origin.source)) {
                issues.push({
                    code: "unknown_origin_source",
                    row_id: row.id,
                    message: `Row ${row.id} names unknown source ${origin.source}`,
                });
            }
        }

        // The anchor cell describes the row's subject, so it has to describe
        // the kind of subject the ref says it is: an annotation ref under a
        // bibliographic title is a row that lies about itself.
        const anchorValue = anchor ? row.cells[anchor.id]?.value : undefined;
        if (row.ref && anchorValue && anchor) {
            const allowed = anchorValueKindsFor(row.ref);
            if (!allowed.includes(anchorValue.kind)) {
                issues.push({
                    code: "anchor_kind_mismatch",
                    row_id: row.id,
                    column_id: anchor.id,
                    message: `Anchor cell "${cellIdFor(row.id, anchor.id)}" has kind "${anchorValue.kind}", which does not describe a "${row.ref.kind}" row`,
                });
            }
        }

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
            const broken = cellInvariantError(cell);
            if (broken) {
                issues.push({
                    code: "invalid_cell",
                    row_id: row.id,
                    column_id: columnId,
                    message: `Cell ${row.id}/${columnId}: ${broken}`,
                });
            }
            const value = cell.value;
            if (!value) continue;

            if (
                value.kind === "number" &&
                (typeof value.value !== "number" ||
                    !Number.isFinite(value.value))
            ) {
                issues.push({
                    code: "invalid_cell_value",
                    row_id: row.id,
                    column_id: columnId,
                    message: "A numeric answer must be finite.",
                });
            }
            if (
                !VALUE_KINDS_BY_COLUMN_TYPE[column.type]?.includes(value.kind)
            ) {
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

    return issues;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function csvEscape(field: string): string {
    if (/^[\s]*[=+@-]/.test(field)) field = "'" + field;
    return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/** One evidence entry as a line: the quote and where it was found. */
function evidenceLine(evidence: Evidence): string {
    const where = evidence.field
        ? evidence.field
        : [
              evidence.page != null ? `p. ${evidence.page + 1}` : "",
              evidence.locator ?? "",
          ]
              .filter(Boolean)
              .join(", ");
    return where ? `"${evidence.quote}" (${where})` : `"${evidence.quote}"`;
}

/**
 * RFC 4180 CSV of the table: one header row of column headers, then one row per
 * table row in the given order. Companion fields carry each cell's evidence,
 * its reasoning and its state; a companion column empty in every row is
 * omitted. Formula-like values are escaped.
 */
export function toCsv(spec: TableSpec, rows: Row[] = spec.rows): string {
    const fields = rows.map((row) =>
        spec.columns.map((c) => {
            const cell = row.cells[c.id];
            return [
                cell?.outcome === "not_reported"
                    ? "Not reported"
                    : cellValueText(cell?.value),
                (cell?.evidence ?? []).map(evidenceLine).join("\n"),
                cell?.reasoning ?? "",
                cell
                    ? [
                          cell.outcome === "answered" ? "" : cell.outcome,
                          cell.error ?? "",
                          cell.unsure ? "unsure" : "",
                          cell.stale ? "stale" : "",
                          cell.provenance,
                      ]
                          .filter(Boolean)
                          .join("; ")
                    : "",
            ];
        }),
    );
    // A companion column that is empty in every row is left out: it would only
    // widen the sheet. The value column is always written.
    const suffixes = ["", " — evidence", " — reasoning", " — state"];
    const kept = spec.columns.map((_, ci) =>
        suffixes.map(
            (_, fi) => fi === 0 || fields.some((row) => row[ci][fi] !== ""),
        ),
    );
    const pick = (values: string[][]) =>
        values.flatMap((group, ci) => group.filter((_, fi) => kept[ci][fi]));
    const header = pick(
        spec.columns.map((c) => suffixes.map((suffix) => c.header + suffix)),
    )
        .map(csvEscape)
        .join(",");
    const lines = fields.map((row) => pick(row).map(csvEscape).join(","));
    return [header, ...lines].join("\r\n");
}

/**
 * The table as plain text for the clipboard: tab-separated, one header line of
 * column headers, then one line per row in the given order. It carries what a
 * reader sees in the grid — the value, or "Not reported" — and none of the
 * evidence or state companions {@link toCsv} adds. Tabs and line breaks inside
 * a value become spaces, so every row stays one line and pastes into a
 * spreadsheet or a document table cell for cell.
 */
export function toPlainText(
    spec: TableSpec,
    rows: Row[] = spec.rows,
    columns: Column[] = spec.columns,
): string {
    const flatten = (text: string) => text.replace(/[\t\r\n]+/g, " ").trim();
    const header = columns.map((c) => flatten(c.header)).join("\t");
    const lines = rows.map((row) =>
        columns
            .map((c) => {
                const cell = row.cells[c.id];
                return flatten(
                    cell?.outcome === "not_reported"
                        ? "Not reported"
                        : cellValueText(cell?.value),
                );
            })
            .join("\t"),
    );
    return [header, ...lines].join("\n");
}
