/**
 * The table card on the chat socket: `table_card_request` from the backend,
 * `table_card_response` from the client, and `table_card_stale` for an answer
 * the backend stopped waiting for. Correlated by `card_id`. Mirrors the
 * backend's `app/models/ws_events.py`; the shared fixtures in
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

/**
 * What filling costs: the rows, how each is answered, and the credits. A fill
 * card's cost is its plan's, exact; approving it approves exactly that plan.
 * A create card's is computed from the resolved sources at the user's prices,
 * and the card recomputes it the same way after the user edits the sources.
 * The credits are the fill's own, charged per paper as it is filled.
 */
export interface TableCardCost {
    /** Rows the fill works on. */
    rows: number;
    /** Rows read from a document. */
    documents: number;
    /** Rows answered from title and abstract. */
    title_abstract: number;
    /** Rows with neither, or that cannot be filled: marked, never charged. */
    no_input: number;
    /** The fill's cost in credits. */
    credits: number;
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
    /** `create_and_run`: the cost the card showed, the ceiling of the fill it starts. */
    cost?: TableCardCost | null;
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
