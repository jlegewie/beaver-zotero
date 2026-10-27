/**
 * The table card on the chat socket: `table_card_request` from the backend,
 * `table_card_response` from the client, and `table_card_stale` for an answer
 * the backend stopped waiting for. Correlated by `card_id`. Mirrors
 * `WSTableCardRequest` / `WSTableCardResponse` in the backend's
 * `app/models/ws_events.py`; the shared fixtures in
 * `tests/fixtures/artifacts/table-cards/` hold the two to one shape.
 */

import type { WSBaseEvent } from './agentProtocol';

export type TableCardSourceType =
    | 'items'
    | 'library'
    | 'library_keyword'
    | 'library_semantic'
    | 'openalex_keyword';

/** One collection, tag or saved search in one library, as stored on an entry. */
export interface TableCardLibraryScope {
    kind: 'collection' | 'tag' | 'saved_search';
    library_ref: string;
    /** Collection or saved-search key. */
    key?: string | null;
    /** Tag name. */
    tag?: string | null;
    /** Display name when the entry was resolved. */
    name?: string | null;
}

export interface TableCardSample {
    /** Portable item id. */
    id: string;
    title: string;
}

/** What an entry resolved to when the card was built. */
export interface TableCardResolved {
    /** Rows the entry yields after the cap. */
    count: number;
    /** Matches before the cap. */
    total: number;
    truncated: boolean;
    /** Yielded rows whose item has no PDF attachment. */
    without_pdf: number;
    sample: TableCardSample[];
    /** Why the entry yields nothing, when it could not be resolved. */
    error?: string | null;
}

/**
 * A source entry in the stored flat shape. Requests carry `id` and
 * `resolved`; replies send entries as edited, without `resolved`, and the
 * backend assigns ids again.
 */
export interface TableCardSource {
    id?: string | null;
    type: TableCardSourceType;
    /** `items`: portable item ids of regular Zotero items. */
    ids?: string[] | null;
    /** `library`: the scope. */
    scope?: TableCardLibraryScope | null;
    resolved?: TableCardResolved | null;
}

export type TableCardColumnType = 'text' | 'number' | 'date' | 'boolean' | 'select';

/** A select category on the card: its label and, optionally, its definition. */
export interface TableCardOption {
    label: string;
    /** What counts as the category; absent or null when it has none. */
    description?: string | null;
}

/** A question column as proposed and edited on the card. */
export interface TableCardColumn {
    header: string;
    type: TableCardColumnType;
    /** The question asked of every paper. */
    description?: string | null;
    /** Select options. */
    options?: TableCardOption[] | null;
    /** Number unit. */
    unit?: string | null;
}

export interface TableCardDestination {
    library_ref: string;
    library_name: string;
    collection_key?: string | null;
    collection_name?: string | null;
    /**
     * Named by the model: fixed. Otherwise derived from the sources, and the
     * card and the backend derive it again from the sources as edited.
     */
    explicit?: boolean;
}

export interface TableCardCost {
    screening?: { rows: number; credits: number } | null;
    extraction?: { rows: number; credits: number; upper_bound?: boolean } | null;
}

export interface WSTableCardRequest extends WSBaseEvent {
    event: 'table_card_request';
    card_id: string;
    run_id: string;
    thread_id?: string | null;
    /** Tool call that proposed the table. */
    toolcall_id: string;
    /** `create` for create_table; `edit` is reserved for the edit tools. */
    scope: 'create' | 'edit';
    title: string;
    description: string;
    destination: TableCardDestination;
    sources: TableCardSource[];
    /** The backend's merge of the proposal as sent. */
    merge: { rows: number; duplicates: number };
    /** Rows a table holds. */
    row_cap: number;
    /** Sum of the sources' totals before any cap. */
    total: number;
    /** The Screening part: one statement per criterion. */
    criteria: string[];
    columns: TableCardColumn[];
    /** Null while nothing can run on approval: the card offers one "Create". */
    cost: TableCardCost | null;
    user_instructions_prefill?: string;
    timeout_seconds: number;
}

export type TableCardChoice = 'create' | 'create_and_run';

export interface WSTableCardResponse {
    type: 'table_card_response';
    card_id: string;
    approved: boolean;
    choice?: TableCardChoice | null;
    title?: string | null;
    description?: string | null;
    sources?: TableCardSource[] | null;
    criteria?: string[] | null;
    columns?: TableCardColumn[] | null;
    user_instructions?: string | null;
}

export interface WSTableCardStale extends WSBaseEvent {
    event: 'table_card_stale';
    card_id: string;
    reason: 'timed_out' | 'unknown';
}
