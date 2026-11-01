/**
 * The provider operations that build and change a table: `preview`, `create`
 * and `apply_edit`.
 *
 * The plugin is the only engine that writes a table. The backend validates a
 * tool call and sends what to apply: the sources and columns of a new table,
 * or the operations of one `edit_table` call. The plugin resolves the
 * sources, merges the rows, applies the operations as one write and answers
 * with the change list and the table's pending work. `preview` resolves a
 * proposal's sources without writing. Mirrors the backend's
 * `app/models/table_edits.py`.
 */

import type { LibraryScope } from "../layouts/table";

export type TableEditColumnType = "text" | "boolean" | "select" | "date";

/** A source entry to resolve, without its id: the plugin assigns ids. */
export type TableSourceDraft =
    | { type: "items"; ids: string[]; scope?: null }
    | { type: "library"; scope: LibraryScope; ids?: null };

/** A source entry with its stored id (`s1`, `s2`, …). */
export type TableSourceEntryWire = TableSourceDraft & { id: string };

export interface TableOptionDraft {
    label: string;
    description?: string | null;
}

/** An option in an update; `previous_label` renames that option. */
export interface TableOptionUpdate extends TableOptionDraft {
    previous_label?: string | null;
}

/**
 * A new question column. The id is derived from `id` or the header, unique in
 * the table; `after` places it after that column (absent: at the end).
 */
export interface TableColumnDraft {
    id?: string | null;
    header: string;
    type: TableEditColumnType;
    description?: string | null;
    options?: TableOptionDraft[] | null;
    after?: string | null;
}

/**
 * A change to a question column. `options` is the full new list: an option
 * the list drops is removed and the cells holding it are cleared.
 */
export interface TableColumnUpdate {
    id: string;
    header?: string | null;
    description?: string | null;
    options?: TableOptionUpdate[] | null;
}

/**
 * One `edit_table` call. Applied as one write in a fixed order: title and
 * description; removals (rows, columns, sources); column updates; column
 * additions; source additions; refresh.
 */
export interface TableEditOperations {
    title?: string | null;
    /** An empty string clears the description. */
    description?: string | null;
    add_columns?: TableColumnDraft[] | null;
    update_columns?: TableColumnUpdate[] | null;
    remove_columns?: string[] | null;
    add_sources?: TableSourceDraft[] | null;
    remove_sources?: string[] | null;
    /** True refreshes every library source; a list names them. */
    refresh_sources?: true | string[] | null;
    remove_rows?: string[] | null;
}

/** An id an items entry named that yields no row, with the reason. */
export interface TableRejectedItem {
    id: string;
    error: string;
}

/** One source as the plugin resolved it. */
export interface TablePreviewSource {
    /**
     * The entry as it would be stored: an items entry lists only the papers
     * that yield a row; a library entry carries the scope's display name.
     */
    entry: TableSourceEntryWire;
    count: number;
    /** Papers before the row cap; a source cut short is `truncated`. */
    total: number;
    truncated: boolean;
    /** Rows without a PDF, EPUB or snapshot. */
    without_document: number;
    sample: { id: string; title: string }[];
    rejected: TableRejectedItem[];
    /** The source cannot be used: an unknown key, an excluded library, no usable item. */
    error?: string;
}

/** What a proposal's sources would give, without writing anything. */
export interface TablePreview {
    sources: TablePreviewSource[];
    /** Rows after merging duplicates within and across sources. */
    rows: number;
    duplicates: number;
    /** The sum of the sources' totals before any cap. */
    total: number;
    /** The rows by how a fill would answer them. */
    documents: number;
    title_abstract: number;
    no_input: number;
    row_cap: number;
}

/** One entry of a write's change list, in the order applied. */
export type TableChange =
    | { op: "title"; title: string }
    | { op: "description" }
    | { op: "add_column"; column: string; header: string }
    | {
          op: "update_column";
          column: string;
          header: string;
          /** What changed: the header, the question, the options. */
          fields: ("header" | "question" | "options")[];
          /**
           * Cells marked out of date, cleared by a removed option (and of them
           * the user's), relabelled.
           */
          stale: number;
          cleared: number;
          user_cleared: number;
          relabelled: number;
      }
    | {
          op: "remove_column";
          column: string;
          header: string;
          /** Cells removed with the column, and of them the user's. */
          cleared: number;
          user_cleared: number;
      }
    | {
          op: "add_source";
          source: string;
          type: string;
          kind?: string | null;
          name?: string | null;
          /** A library entry's library. */
          library_ref?: string | null;
          rows_added: number;
          /** Removed papers this addition brought back. */
          rows_restored: number;
          /** Papers that were already rows (or found twice), merged. */
          duplicates: number;
          rejected: TableRejectedItem[];
      }
    | {
          op: "remove_source";
          source: string;
          type: string;
          kind?: string | null;
          name?: string | null;
          /** A library entry's library. */
          library_ref?: string | null;
          /** Rows whose only origin it was. */
          rows_removed: number;
      }
    | {
          op: "refresh_source";
          source: string;
          kind?: string | null;
          name?: string | null;
          /** A library entry's library. */
          library_ref?: string | null;
          rows_added: number;
          /** Removed papers the source yields, left out. */
          removed_skipped: number;
          /** Rows the source no longer yields; they stay. */
          no_longer_found: number;
      }
    | { op: "remove_rows"; rows: number };
