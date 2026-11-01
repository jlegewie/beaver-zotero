/**
 * Table fills: the backend's fill endpoint, and the plugin's fill job as its
 * clients see it.
 *
 * A fill job runs in the plugin. It plans the cells to fill, reads each
 * row's document locally and posts the row to `POST /api/v1/tables/fill`,
 * which answers its questions statelessly and charges a flat price per row;
 * the job writes the answers. `GET /api/v1/tables/pricing` gives the prices a
 * plan is costed at.
 */

import type { Cell, RowFailure, SelectColor } from "../layouts/table";
import type { PendingWork } from "../layouts/tableFill";

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

export const TABLE_FILL_API_PREFIX = "/api/v1/tables";

/** `GET /tables/pricing`: credits per row. */
export interface TableFillPricing {
    /** A row answered from its document. */
    document: number;
    /** A row answered from its title and abstract. */
    title_abstract: number;
}

/** The kinds of document a row is read from. */
export type TableFillDocumentKind = "pdf" | "epub" | "snapshot" | "text";

export interface TableFillColumn {
    id: string;
    header: string;
    type: string;
    description?: string;
    options?: { label: string; description?: string; color?: SelectColor }[];
    /** The column's question hash when the row was planned. */
    question_hash: string;
}

export interface TableFillRunContext {
    run_id: string;
    thread_id: string;
    tool_call_id: string;
}

/**
 * One row of a fill. `document.content` is the backend-bound extraction the
 * plugin serves for `zotero_document_request` in structured mode; the job
 * splices it into the body as serialized JSON.
 */
export interface TableFillRequest {
    job_id: string;
    row_id: string;
    /** Agent fills only: the run whose `fill_table` started the job. */
    run?: TableFillRunContext;
    /** The price the plan quoted for this row. */
    price: number;
    table: { title: string; description?: string };
    columns: TableFillColumn[];
    row: {
        reference: {
            title?: string;
            authors?: string;
            year?: string | number;
            venue?: string;
            item_type?: string;
        };
        abstract?: string;
    };
    document?: { id: string; kind: TableFillDocumentKind; content: unknown };
}

export interface TableFillResponse {
    /** Column id → the model cell, ready for `set_cells`. */
    cells: Record<string, Cell>;
    row_failure?: RowFailure | null;
    /** Credits this request charged. */
    charged: number;
}

/** The error codes of the endpoint, in `{"detail": {"code", "message"?}}`. */
export type TableFillErrorCode =
    | "invalid_request"
    | "insufficient_credits"
    | "price_changed"
    | "too_large"
    | "rate_limited"
    | "unavailable";

// ---------------------------------------------------------------------------
// The fill job
// ---------------------------------------------------------------------------

/** A stored table, by library and item key. */
export interface TableFillTarget {
    libraryID: number;
    key: string;
}

/**
 * Which cells a plan fills: the pending work (with `limit`, the first rows
 * of it in table order: the five-row trial), the rows whose last fill failed
 * with a retryable failure, or explicit rows and columns.
 */
export type TableFillScope =
    | { kind: "pending"; limit?: number }
    | { kind: "retry_failed" }
    | { kind: "cells"; rows?: string[]; columns?: string[] };

/** What a plan costs and what it reads, as the Fill popover shows it. */
export interface TableFillPlanSummary {
    plan_id: string;
    table: TableFillTarget & { title: string };
    scope: TableFillScope;
    /** Rows the plan works on. */
    rows: number;
    cells: number;
    /** Rows read from a document. */
    documents: number;
    /** Of those, by the document's kind where the plan knows it. */
    document_kinds: Partial<Record<"pdf" | "epub" | "snapshot" | "text" | "other", number>>;
    /** Rows answered from title and abstract. */
    title_abstract: number;
    /** Rows with neither: they get a row failure and cost nothing. */
    no_input: number;
    /** Rows that cannot be filled (an item gone, an excluded library). */
    unavailable: number;
    /** The plan's exact cost in credits. */
    credits: number;
    prices: TableFillPricing;
    /** The table's pending work as planned. */
    pending: PendingWork;
    /** The balance when planned, from the account snapshot; null when unknown. */
    balance: number | null;
    /** Epoch ms after which the plan can no longer start. */
    expires_at: number;
}

export type TableFillPlanError =
    | "unknown_row"
    | "unknown_column"
    | "invalid_column"
    | "table_unavailable"
    | "read_only"
    | "pricing_unavailable"
    | "signed_out";

export type TableFillPlanResult =
    | { ok: true; plan: TableFillPlanSummary }
    | { ok: false; code: TableFillPlanError; message: string };

/** Why a planned row was never started. */
export type TableFillNotStartedReason =
    | "stopped"
    | "insufficient_credits"
    | "price_changed"
    | "account_changed"
    | "changed"
    | "unavailable"
    | "shutdown";

export interface TableFillOrigin {
    kind: "user" | "agent";
    run?: TableFillRunContext;
}

/** What a fill did, when it ended. */
export interface TableFillResult {
    /** Rows answered (cells written). */
    rows_answered: number;
    answered: number;
    not_reported: number;
    /** Answers read from title and abstract. */
    from_title_abstract: number;
    documents_read: number;
    credits_charged: number;
    /** Rows that failed as a whole, by failure code. */
    row_failures: Record<string, number>;
    /** The failed rows' ids, so a client can show them. */
    failed_row_ids: string[];
    /** Rows never started, by why. */
    not_started: Partial<Record<TableFillNotStartedReason, number>>;
    /** Rows answered whose commit did not land. */
    not_written: number;
    /** Cell writes the table declined, by reason. */
    skipped_cells: Record<string, number>;
    /** What stopped the job before it ran out of rows, if anything. */
    stopped_by?: TableFillNotStartedReason;
    /** The table's pending work after the fill; null when it could not be read. */
    pending: PendingWork | null;
}

export type TableFillJobState = "running" | "stopping" | "done";

/** A job's progress, published on every change. */
export interface TableFillJobSnapshot {
    job_id: string;
    plan_id: string;
    table: TableFillTarget & { title: string };
    origin: TableFillOrigin;
    state: TableFillJobState;
    /** Rows the job will work on. */
    rows_total: number;
    /** Rows finished: answered, failed or written as unavailable. */
    rows_done: number;
    rows_failed: number;
    /** Requests in flight. */
    in_flight: number;
    credits_charged: number;
    /** The plan's cost. */
    credits_planned: number;
    /** The balance left, from the account snapshot minus what was charged. */
    balance: number | null;
    started_at: number;
    /** Rough seconds until the last row finishes; null until a row has. */
    seconds_left: number | null;
    /** Set once the job ends. */
    result?: TableFillResult;
}

export type TableFillStartError =
    | "plan_not_found"
    | "plan_expired"
    | "fill_in_progress"
    | "table_unavailable"
    | "read_only"
    | "signed_out"
    | "nothing_to_fill"
    /** A chat run's fill: the user stopped the run before the job started. */
    | "stopped";

export type TableFillStartResult =
    | { ok: true; job: TableFillJobSnapshot }
    | {
          ok: false;
          code: TableFillStartError;
          message: string;
          /** For `fill_in_progress`: the job that holds the table. */
          job_id?: string;
      };

// ---------------------------------------------------------------------------
// The provider operations `fill_plan` and `fill`
// ---------------------------------------------------------------------------

/**
 * A plan as `fill_plan` answers it: the plan summary without the plugin's
 * local identity of the table (the request named it), plus the question
 * columns the plan answers.
 */
export interface TableFillWirePlan {
    plan_id: string;
    rows: number;
    cells: number;
    documents: number;
    document_kinds: TableFillPlanSummary["document_kinds"];
    title_abstract: number;
    no_input: number;
    unavailable: number;
    /** The question columns the plan answers, in table order. */
    columns: string[];
    credits: number;
    prices: TableFillPricing;
    pending: PendingWork;
    balance: number | null;
    /** Epoch ms. */
    expires_at: number;
}

/** A job's progress as `fill` answers it. */
export interface TableFillProgress {
    state: TableFillJobState;
    rows_total: number;
    rows_done: number;
    rows_failed: number;
    in_flight: number;
    credits_charged: number;
    credits_planned: number;
    seconds_left: number | null;
}

/** The progress counts of a snapshot. */
export function fillProgress(snapshot: TableFillJobSnapshot): TableFillProgress {
    return {
        state: snapshot.state,
        rows_total: snapshot.rows_total,
        rows_done: snapshot.rows_done,
        rows_failed: snapshot.rows_failed,
        in_flight: snapshot.in_flight,
        credits_charged: snapshot.credits_charged,
        credits_planned: snapshot.credits_planned,
        seconds_left: snapshot.seconds_left,
    };
}

/** The runtime notification a job publishes its snapshots on. */
export const TABLE_FILL_CHANGED_EVENT = "table-fill:changed";
