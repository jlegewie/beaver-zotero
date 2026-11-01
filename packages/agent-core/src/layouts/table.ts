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
 *   back in: a spec written in another format is refused rather than misread.
 * - Rows are discriminated by what they are about (`Row.ref`, a `RowRef`), and
 *   everything that depends on that — in-library state, which verbs apply and
 *   where they point — is answered by `./rowKinds`, never by branching on
 *   `ref.kind` in a renderer. Row ids are opaque.
 * - One column is the **anchor** (`anchor_column_id`): it owns row identity, is
 *   the sticky column under horizontal scroll and is the target of reveal.
 * - Evidence names its document: each entry locates text in one of the
 *   documents its cell was read from (`Evidence.document`), and
 *   `./tableCitations` assembles a chat citation from the row plus one entry.
 * - A row names the documents it is filled from (`Row.documents`); a filler
 *   cell names the documents its answer was read from. {@link isStale}
 *   compares the two.
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
export const TABLE_SPEC_VERSION = 2;

export type ColumnType =
    | "text"
    | "date"
    | "boolean"
    | "select"
    | "reference"
    | "link";

/** Column types a filler answers; `reference` and `link` belong to system columns. */
export const MODEL_COLUMN_TYPES: readonly ColumnType[] = [
    "text",
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
/** Evidence entries of one cell. */
export const MAX_EVIDENCE_ENTRIES = 5;
/** Characters (code points) of one evidence entry's table context. */
export const MAX_CONTEXT_CHARS = 600;
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
    /**
     * Counts changes to the column's type, question or options (a label, a
     * definition, a rename, an addition or a removal); absent means 0. Never
     * moved by a header or colour change. A fill records it when it plans and
     * its writes carry it, so an answer prepared against an earlier column is
     * skipped where the question hash alone would let it land (a renamed
     * option without a definition). See {@link questionHash}.
     */
    revision?: number;
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

/**
 * A regular (bibliographic) library item. The document it is filled from, which
 * `open` targets, is `Row.documents`.
 */
export interface ItemRowRef extends ZoteroRowReference {
    kind: "item";
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

/**
 * A document id: the portable id of a Zotero attachment (`u-KEY`,
 * `g<groupID>-KEY`) or of an attached file (`ext-KEY`).
 */
export type DocumentId = string;

/**
 * Why the last fill of a row stopped before its questions were answered: an
 * unreadable document, nothing to read, a deadline. Cleared by a successful
 * answer, and by `update_row` when the row's documents change.
 */
export interface RowFailure {
    /** A stable code, e.g. `encrypted` or `no_source`. */
    code: string;
    /** One short user-facing sentence, as the row shows it. */
    message: string;
}

/** A paper removed from the table, remembered so a refresh skips it. */
export interface RemovedPaper {
    ref: RowRef;
    /** ISO time of the removal. */
    removed_at: string;
}

export interface Row {
    /**
     * Opaque, allocated when the row is created and never derived from the
     * reference, so the reference can change without moving cells. Becomes a
     * DOM id in the snapshot rendering.
     */
    id: string;
    ref?: RowRef;
    /**
     * The documents this row is filled from. An attachment or file row names
     * itself, an annotation row its attachment, an item row the attachment
     * found for it. Absent ⇒ the row has none and is answered from its title
     * and abstract.
     */
    documents?: DocumentId[];
    /** Why the last fill stopped before the row was answered. */
    failure?: RowFailure;
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
}

export type CellValue =
    /** Inline markdown. */
    | { kind: "text"; text: string }
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
 * One cited passage. `document` + `locator` identify it; the row supplies the
 * work, so a full chat citation is assembled from the row plus one entry (see
 * `./tableCitations`).
 */
export interface Evidence {
    /** The document the passage is in: one of the cell's `documents`. */
    document: DocumentId;
    /** Ids within that document's extraction ("s243-s250", "s5.6"). */
    locator: string;
    /** The exact text at the highlighted spot. */
    quote: string;
    /** 0-based page index (PDF). */
    page?: number;
    /** `[left, top, right, bottom]` in PDF points, top-left origin. */
    boxes?: number[][];
    /**
     * The caption and header rows of the table a cited row sits in, so the
     * quote can be read. Not part of the quote.
     */
    context?: string;
}

export type CellOutcome = "answered" | "not_reported" | "failed" | "cleared";

/**
 * Who wrote the cell: the filler (`model`), the user, or the producer for the
 * reference, year and identifier columns (`system`).
 */
export type CellProvenance = "model" | "user" | "system";

/** How directly the filler's sources state its answer. */
export type Confidence = "high" | "medium" | "low";

interface CellBase {
    provenance: CellProvenance;
    /**
     * The column's question changed after this cell was written. Set by
     * `update_column`; a write never carries it. See {@link isStale}.
     */
    stale?: true;
}

/** An answer. Filler cells also say what they were read from and how sure they are. */
export interface AnsweredCell extends CellBase {
    outcome: "answered";
    value: CellValue;
    /**
     * Filler cells only: the documents the answer was read from. Absent ⇒
     * answered from title and abstract.
     */
    documents?: DocumentId[];
    confidence?: Confidence;
    /** Why this answer; on a user correction, the user's stated reason. */
    reasoning?: string;
    evidence?: Evidence[];
    /** User cells only: the model cell this answer replaced ({@link ReplacedCell}). */
    replaced?: ReplacedCell;
    error?: never;
    error_code?: never;
}

/**
 * The material does not say — a finding, not a failure. A user may mark a
 * cell Not reported too: provenance `user`, no filler fields, an optional
 * note as its `reasoning`, and `replaced` as for a correction.
 */
export interface NotReportedCell extends CellBase {
    outcome: "not_reported";
    documents?: DocumentId[];
    confidence?: Confidence;
    /** Why there is no answer; on a user's mark, the user's note. */
    reasoning?: string;
    /** The closest passages, when any. */
    evidence?: Evidence[];
    /** User cells only: the model cell this one replaced ({@link ReplacedCell}). */
    replaced?: ReplacedCell;
    value?: never;
    error?: never;
    error_code?: never;
}

/** One answer failed; the rest of its row did not (see {@link RowFailure}). */
export interface FailedCell extends CellBase {
    outcome: "failed";
    /** A stable code, e.g. `no_locator`. */
    error_code: string;
    /** One short user-facing sentence, as the cell shows it. */
    error: string;
    value?: never;
    documents?: never;
    confidence?: never;
    reasoning?: never;
    evidence?: never;
    replaced?: never;
}

/** A user-owned blank the filler never refills. */
export interface ClearedCell extends CellBase {
    outcome: "cleared";
    provenance: "user";
    value?: never;
    documents?: never;
    confidence?: never;
    reasoning?: never;
    evidence?: never;
    /** The model cell the user cleared ({@link ReplacedCell}). */
    replaced?: ReplacedCell;
    error?: never;
    error_code?: never;
}

/**
 * The model cell a user cell replaced, kept on the user cell without its own
 * `replaced`. It keeps Beaver's answer and evidence visible after a
 * correction and is what Reset restores. Counts toward the cell's byte caps;
 * over the cap its evidence is dropped first, then the field. When the
 * column's question changes it is marked `stale` like the cell holding it.
 */
export type ReplacedCell =
    | (Omit<AnsweredCell, "replaced"> & { provenance: "model" })
    | (Omit<NotReportedCell, "replaced"> & { provenance: "model" });

/**
 * A written cell; absent means unattempted. The structural rules
 * ({@link cellInvariantError}) hold on every write.
 */
export type Cell = AnsweredCell | NotReportedCell | FailedCell | ClearedCell;

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
    /** Format version of this spec — absent ⇒ 1, which this build cannot read. */
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
     * Papers the user or the model removed from the table. Refreshing a
     * source leaves them out; adding one explicitly restores it.
     */
    removed?: RemovedPaper[];
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
 * distinguishes matter. `unsupported_version` means the file was written in
 * another format — the caller should refuse it (or open a newer one read-only)
 * rather than parse it with today's assumptions and write back something lossy.
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
        // Another format is never misread: an older one has no reader in
        // this build, and a newer one may carry fields it would drop.
        if (specVersion !== TABLE_SPEC_VERSION)
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

    // A table without a version is in the first format, which this build
    // has no reader for; checked after the shape, so a corrupt file still
    // reads as invalid.
    if (specVersion === undefined)
        return { ok: false, reason: "unsupported_version", specVersion: 1 };
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
 * Boolean centres (a single glyph); a date ends; everything else
 * starts. Header and cell, in both the React grid and the HTML snapshot, must
 * call this — a local copy is how they start to disagree.
 */
export function columnAlign(column: Column): "start" | "end" | "center" {
    if (column.align) return column.align;
    if (column.type === "boolean") return "center";
    return column.type === "date" ? "end" : "start";
}

/** True when the cell holds no answer: unattempted, failed or cleared. */
export function isCellEmpty(cell: Cell | undefined): boolean {
    return cell?.value == null && cell?.outcome !== "not_reported";
}

/**
 * A filler answer or finding read from the title and abstract rather than a
 * document: a model cell that names no documents.
 */
export function isTitleAbstractOnly(cell: Cell | undefined): boolean {
    return (
        cell?.provenance === "model" &&
        (cell.outcome === "answered" || cell.outcome === "not_reported") &&
        !cell.documents?.length
    );
}

/**
 * Why a cell is stale: `question` when the column's question changed since it
 * was written (stored by `update_column`), `document` when it is a filler cell
 * read from documents the row no longer names (derived, nothing stored).
 * User, system, failed and cleared cells are never stale by the row rule.
 * Undefined when the cell is current.
 */
export function staleReason(
    row: Pick<Row, "documents">,
    cell: Cell | undefined,
): "question" | "document" | undefined {
    if (!cell) return undefined;
    if (cell.stale) return "question";
    if (
        cell.provenance !== "model" ||
        (cell.outcome !== "answered" && cell.outcome !== "not_reported")
    )
        return undefined;
    const read = new Set(cell.documents ?? []);
    const named = new Set(row.documents ?? []);
    if (read.size !== named.size) return "document";
    for (const id of read) if (!named.has(id)) return "document";
    return undefined;
}

/** Whether a cell answers an earlier question or an earlier document; see {@link staleReason}. */
export function isStale(
    row: Pick<Row, "documents">,
    cell: Cell | undefined,
): boolean {
    return staleReason(row, cell) !== undefined;
}

/**
 * The review mark, a fixed rule: a filler answer or blank read from a
 * document, of confidence below high, outside text columns. Computed for
 * evaluation and counted by `summarize`; no surface shows it.
 */
export function needsReview(
    column: Pick<Column, "type">,
    cell: Cell | undefined,
): boolean {
    return (
        cell?.provenance === "model" &&
        (cell.outcome === "answered" || cell.outcome === "not_reported") &&
        (cell.documents?.length ?? 0) > 0 &&
        (cell.confidence === "medium" || cell.confidence === "low") &&
        column.type !== "text"
    );
}

/**
 * The heading over a cell's passages, by its outcome alone: a blank's
 * passages are the closest the paper comes; an answer's are its evidence.
 */
export function evidenceHeading(
    cell: Cell | undefined,
): "Evidence" | "Closest passages" {
    return cell?.outcome === "not_reported" ? "Closest passages" : "Evidence";
}

/**
 * A filler answer read from a document that cites no passage: shown with its
 * reasoning and "No passage cited", for the user to judge.
 */
export function isUncitedAnswer(cell: Cell | undefined): boolean {
    return (
        cell?.provenance === "model" &&
        cell.outcome === "answered" &&
        (cell.documents?.length ?? 0) > 0 &&
        (cell.evidence?.length ?? 0) === 0
    );
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
    /** Rows with a failure: the last fill could not read them. */
    errorRows: number;
    /** Filler answers read from the title and abstract only, as `summarize` counts them. */
    titleAbstractOnly: number;
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
        titleAbstractOnly: 0,
    };
    for (const row of rows) {
        if (row.failure) coverage.errorRows += 1;
        for (const column of spec.columns) {
            const cell = row.cells[column.id];
            if (cell?.outcome === "failed") coverage.error += 1;
            if (cell?.value) coverage.filled += 1;
            else {
                coverage.empty += 1;
                if (cell?.outcome === "not_reported") coverage.notReported += 1;
            }
            if (cell?.outcome === "answered" && isTitleAbstractOnly(cell))
                coverage.titleAbstractOnly += 1;
        }
    }
    return coverage;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * A text cell's sort key: its prose, lowercased, and the number it opens with
 * when it opens with one ("1,200" → 1200, "21.9", "10–20" → 10), so a
 * quantity column sorts as numbers ("9" before "120", "950" before "1,200").
 */
export interface TextSortKey {
    text: string;
    lead?: number;
}

// A leading number: thousands groups and a decimal part, or a bare decimal
// part (".05"), optionally signed.
const LEADING_NUMBER =
    /^[-−+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)/;

function textSortKey(text: string): TextSortKey {
    const key: TextSortKey = { text: text.toLocaleLowerCase(SORT_LOCALE) };
    const match = LEADING_NUMBER.exec(text);
    if (match) {
        const lead = Number(match[0].replace(/,/g, "").replace("−", "-"));
        if (Number.isFinite(lead)) key.lead = lead;
    }
    return key;
}

type SortKey = number | string | TextSortKey | null;

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

/**
 * Compares text cells: digit runs as numbers ("about 9" before "about 120"),
 * case and accents aside.
 */
const TEXT_COLLATOR = new Intl.Collator(SORT_LOCALE, {
    numeric: true,
    sensitivity: "base",
});

/** Sort key of a cell; `null` means empty and sorts last in either direction. */
export function cellSortKey(cell: Cell | undefined): SortKey {
    const value = cell?.value;
    if (!value) return null;
    switch (value.kind) {
        case "boolean":
            return value.value ? 1 : 0;
        case "date":
            return value.value;
        case "text":
            // Sorted on the prose, not on the markup wrapped around it.
            return textSortKey(stripCitationTags(value.text));
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
    const text = (key: Exclude<SortKey, null>) =>
        typeof key === "object" ? key.text : String(key);
    const cmp =
        typeof a === "number" && typeof b === "number"
            ? a - b
            : typeof a === "object" && typeof b === "object"
              ? compareText(a, b)
              : text(a).localeCompare(text(b), SORT_LOCALE);
    return direction === "desc" ? -cmp : cmp;
}

/**
 * Two text cells, numeric-aware. Answers that open with a number come first,
 * by that number (the collator alone would put "1,200" before "950" and "1.5"
 * before "1.25"), then by the collator; every other answer follows, by the
 * collator. Grouping first keeps the order total: mixing the number and the
 * collator across groups would let "+10" < "<2" < "2" < "+10".
 */
function compareText(a: TextSortKey, b: TextSortKey): number {
    const aLead = a.lead !== undefined;
    const bLead = b.lead !== undefined;
    if (aLead !== bLead) return aLead ? -1 : 1;
    if (aLead && bLead && a.lead !== b.lead) return a.lead! - b.lead!;
    return TEXT_COLLATOR.compare(a.text, b.text);
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
    /** Case-insensitive substring match on the value's text form (text and number columns). */
    | { column_id: string; kind: "contains"; text: string }
    /** Inclusive range on date values; either bound may be open. */
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
            const key = value.kind === "date" ? value.value : null;
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
        | "invalid_row"
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
        // A column of an unsupported type (a `number` column) or without a
        // text header: the backend's spec model refuses it as well.
        "invalid_column_definition",
        "invalid_cell",
        "invalid_row",
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
const PROVENANCES: readonly CellProvenance[] = ["model", "user", "system"];
const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low"];

function isDocumentList(value: unknown): value is DocumentId[] {
    return (
        Array.isArray(value) &&
        value.every((id) => typeof id === "string" && id.length > 0)
    );
}

/**
 * The first structural cell rule the cell breaks, or undefined. Only the
 * rules every reader depends on; what a filler should write (the evidence or
 * reasoning behind each answer) is the filler's policy.
 */
export function cellInvariantError(cell: Cell): string | undefined {
    // Read loosely: the cell may be any stored shape.
    const raw = cell as unknown as Record<string, unknown>;
    if (!OUTCOMES.includes(cell.outcome))
        return "A cell names an unknown outcome";
    if (!PROVENANCES.includes(cell.provenance))
        return "A cell names an unknown provenance";
    if ((raw.value != null) !== (cell.outcome === "answered"))
        return "A cell has a value exactly when its outcome is answered";
    const failed = cell.outcome === "failed";
    if (failed !== (raw.error != null) || failed !== (raw.error_code != null))
        return "A cell has an error and an error code exactly when its outcome is failed";
    if (cell.outcome === "cleared" && cell.provenance !== "user")
        return "Only the user clears a cell";
    const reasons = cell.outcome === "answered" || cell.outcome === "not_reported";
    if (raw.reasoning != null && !reasons)
        return "Only an answered or not-reported cell gives reasoning";
    if (raw.replaced != null) {
        if (cell.provenance !== "user")
            return "Only a user cell keeps the answer it replaced";
        const replaced = raw.replaced as Record<string, unknown>;
        if (
            !isPlainObject(replaced) ||
            replaced.provenance !== "model" ||
            (replaced.outcome !== "answered" && replaced.outcome !== "not_reported")
        )
            return "A replaced answer is a model answer or finding";
        if (replaced.replaced != null)
            return "A replaced answer keeps no replaced answer of its own";
        const inner = cellInvariantError(replaced as unknown as Cell);
        if (inner) return `Replaced answer: ${inner}`;
    }
    const modelFields = ["documents", "confidence", "evidence"].some(
        (name) => raw[name] != null,
    );
    if (cell.provenance !== "model")
        return modelFields
            ? "Only a filler cell carries documents, confidence or evidence"
            : undefined;
    if (!reasons)
        return modelFields
            ? "Only an answered or not-reported cell carries documents, confidence or evidence"
            : undefined;
    if (raw.documents != null && !isDocumentList(raw.documents))
        return "A cell's documents are a list of document ids";
    if (
        raw.confidence != null &&
        !CONFIDENCES.includes(raw.confidence as Confidence)
    )
        return "A cell names an unknown confidence";
    if (raw.evidence != null) {
        if (!Array.isArray(raw.evidence)) return "A cell's evidence is a list";
        if (raw.evidence.length > MAX_EVIDENCE_ENTRIES)
            return `A cell has at most ${MAX_EVIDENCE_ENTRIES} evidence entries`;
        const named = new Set(
            isDocumentList(raw.documents) ? raw.documents : [],
        );
        for (const entry of raw.evidence as unknown[]) {
            if (!isPlainObject(entry)) return "An evidence entry is an object";
            if (typeof entry.document !== "string" || !named.has(entry.document))
                return "Every evidence entry names one of the cell's documents";
            if (!isNonEmptyString(entry.locator))
                return "Every evidence entry names its locator";
            if (typeof entry.quote !== "string")
                return "Every evidence entry quotes its passage";
            if (
                entry.context != null &&
                (typeof entry.context !== "string" ||
                    codePointLength(entry.context) > MAX_CONTEXT_CHARS)
            )
                return `An evidence context is at most ${MAX_CONTEXT_CHARS} characters`;
        }
    }
    return undefined;
}

/** The first structural row rule the row breaks, or undefined. */
export function rowInvariantError(row: Row): string | undefined {
    if (row.documents != null && !isDocumentList(row.documents))
        return "A row's documents are a list of document ids";
    const failure = row.failure as unknown;
    if (
        failure != null &&
        !(
            isPlainObject(failure) &&
            isNonEmptyString(failure.code) &&
            isNonEmptyString(failure.message)
        )
    )
        return "A row failure has a code and a message";
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
        if (
            column.revision !== undefined &&
            !(Number.isSafeInteger(column.revision) && column.revision >= 0)
        ) {
            issues.push({
                code: "invalid_column_definition",
                column_id: column.id,
                message: `Column "${column.id}" has revision ${String(column.revision)}; a revision is a whole number from 0.`,
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

        const brokenRow = rowInvariantError(row);
        if (brokenRow) {
            issues.push({
                code: "invalid_row",
                row_id: row.id,
                message: `Row ${row.id}: ${brokenRow}`,
            });
        }

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

/** One evidence entry as a line: `document locator: quote`, with its table context. */
function evidenceLine(evidence: Evidence): string {
    const where = [evidence.document, evidence.locator]
        .filter(Boolean)
        .join(" ");
    const context = evidence.context ? ` [${evidence.context}]` : "";
    return `${where}: ${evidence.quote}${context}`;
}

/**
 * RFC 4180 CSV of the table: one header row of column headers, then one row per
 * table row in the given order.
 * Companion fields carry each cell's evidence, its reasoning and its state; a
 * companion column empty in every row is omitted. Formula-like values are
 * escaped. The filler's stored confidence is not exported.
 */
export function toCsv(spec: TableSpec, rows: Row[] = spec.rows): string {
    const fields = rows.map((row) =>
        spec.columns.map((c) => {
            const cell = row.cells[c.id];
            const value = cell?.value;
            return [
                cell?.outcome === "not_reported"
                    ? "Not reported"
                    : cellValueText(value),
                (cell?.evidence ?? []).map(evidenceLine).join("\n"),
                cell?.reasoning ?? "",
                [
                    cell && cell.outcome !== "answered" ? cell.outcome : "",
                    cell?.error ?? "",
                    isStale(row, cell) ? "stale" : "",
                    isTitleAbstractOnly(cell) ? "title and abstract" : "",
                    cell?.provenance ?? "",
                ]
                    .filter(Boolean)
                    .join("; "),
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
        spec.columns.map((c) =>
            suffixes.map((suffix) => c.header + suffix),
        ),
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
