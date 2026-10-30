/**
 * The table card on the chat socket: `table_card_request` from the backend,
 * `table_card_response` from the client, and `table_card_stale` for an answer
 * the backend stopped waiting for. Correlated by `card_id`. While a create
 * card waits, `table_card_estimate` asks its tool call for a new `cost` and
 * `table_card_estimate_result` answers. `table_fill_started` is the progress
 * stamp of a fill. Mirrors the backend's `app/models/ws_events.py`; the shared
 * fixtures in `tests/fixtures/artifacts/table-cards/` hold the two to one shape.
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

/** A question's type; a quantity is a text question that names its unit. */
export type TableCardColumnType = 'text' | 'date' | 'boolean' | 'select';

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

/** What the run would fill: its rows, and how each would be answered. */
export interface TableCardExtractionCost {
    /** Rows the run would fill. */
    rows: number;
    /** Of those, the rows read from a document. */
    documents: number;
    /** Of those, the rows with neither a document nor an abstract. */
    no_input: number;
    /** The count is not exact (sources edited on the card): the card says "up to". */
    upper_bound?: boolean;
}

/**
 * What the run would do and what approving it authorizes. `credits` is a
 * high-end estimate of the run, set only when approving raises what the run
 * already authorizes; null when the run fits. The reply names the
 * `estimate_id` the card showed, and approving grants exactly that estimate.
 */
export interface TableCardCost {
    extraction?: TableCardExtractionCost | null;
    /** Rows the run would screen (from the screening milestone). */
    screening?: { rows: number } | null;
    credits?: number | null;
    estimate_id: string;
}

/** The existing table a fill or edit card is about, for its "Open table" link. */
export interface TableCardTable {
    /** Portable item id of the table. */
    key: string;
    title: string;
}

export interface WSTableCardRequest extends WSBaseEvent {
    event: 'table_card_request';
    card_id: string;
    run_id: string;
    thread_id?: string | null;
    /** Tool call that proposed the table. */
    toolcall_id: string;
    /**
     * `create` for create_table, `fill` for fill_table; `edit` is reserved for
     * the edit tools. A fill card carries `table` and the columns being filled,
     * and none of the create parts.
     */
    scope: 'create' | 'edit' | 'fill';
    title: string;
    description: string;
    /** The existing table (fill and edit cards). */
    table?: TableCardTable | null;
    /** Create cards. */
    destination?: TableCardDestination | null;
    sources: TableCardSource[];
    /** The backend's merge of the proposal as sent (create cards). */
    merge?: { rows: number; duplicates: number } | null;
    /** Rows a table holds (create cards). */
    row_cap?: number | null;
    /** Sum of the sources' totals before any cap (create cards). */
    total?: number | null;
    /** The Screening part: one statement per criterion. */
    criteria: string[];
    columns: TableCardColumn[];
    /** Null while nothing can run on approval: the card offers one "Create". */
    cost: TableCardCost | null;
    user_instructions_prefill?: string;
    timeout_seconds: number;
}

/** A create card: the request with every create part present. */
export interface WSTableCreateCardRequest extends WSTableCardRequest {
    scope: 'create';
    destination: TableCardDestination;
    merge: { rows: number; duplicates: number };
    row_cap: number;
    total: number;
}

/** A fill card: the table and the columns being filled, and its cost. */
export interface WSTableFillCardRequest extends WSTableCardRequest {
    scope: 'fill';
    table: TableCardTable;
    cost: TableCardCost;
}

export function isCreateCard(request: WSTableCardRequest): request is WSTableCreateCardRequest {
    return (
        request.scope === 'create' &&
        !!request.destination &&
        !!request.merge &&
        typeof request.row_cap === 'number' &&
        typeof request.total === 'number'
    );
}

export function isFillCard(request: WSTableCardRequest): request is WSTableFillCardRequest {
    return request.scope === 'fill' && !!request.table && !!request.cost;
}

export type TableCardChoice = 'create' | 'create_and_run' | 'fill';

export interface WSTableCardResponse {
    type: 'table_card_response';
    card_id: string;
    approved: boolean;
    choice?: TableCardChoice | null;
    /** The estimate the card showed; approving grants its credits. */
    estimate_id?: string | null;
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

/**
 * The card asking its waiting tool call for a new `cost` for the draft: its
 * sources with the `resolved` blocks the card resolved, and its columns.
 * `request_id` correlates the answer.
 */
export interface WSTableCardEstimateRequest {
    type: 'table_card_estimate';
    card_id: string;
    request_id: string;
    sources: TableCardSource[];
    columns: TableCardColumn[];
}

/**
 * The answer to `table_card_estimate`: a new `cost` (null when the draft has
 * nothing to run) or an error — `unknown_card` when no tool call waits on the
 * card, `invalid_request` when the draft could not be read.
 */
export interface WSTableCardEstimateResult extends WSBaseEvent {
    event: 'table_card_estimate_result';
    card_id: string;
    request_id: string;
    cost?: TableCardCost | null;
    error?: 'unknown_card' | 'invalid_request' | null;
}

/**
 * The progress stamp of a table fill, sent once when it starts. The panel
 * takes its totals from it; its progress comes from the `edit` commits the
 * plugin applies.
 */
export interface WSTableFillStarted extends WSBaseEvent {
    event: 'table_fill_started';
    run_id: string;
    toolcall_id: string;
    table: TableCardTable;
    /** Rows the fill works on. */
    rows: number;
    /** Cells the fill works on. */
    cells: number;
    /** Rows read from a document. */
    documents: number;
    /** Rows with neither a document nor an abstract. */
    no_input: number;
    /** Headers of the columns being filled. */
    columns: string[];
    /** ISO time the fill started. */
    started_at: string;
}
