import type { TableSpec } from "../layouts/table";
import type { PendingWork } from "../layouts/tableFill";
import type { TableSummary } from "../layouts/tableMutations";
import type {
    TableFillProgress,
    TableFillResult,
    TableFillWirePlan,
} from "./tableFillProtocol";
import type {
    TableChange,
    TableColumnDraft,
    TableEditOperations,
    TablePreview,
    TableSourceEntryWire,
} from "./tableEditProtocol";

/** Historical identity observed in a message or tool result. */
export interface TableReference {
    kind: "table";
    key: string;
    title: string;
}

/** Stage counts of a table, as of the call that recorded them. */
export interface TableStages {
    rows: number;
    sources: number;
    /** Question columns; system columns are not counted. */
    columns: number;
    /** Rows with no document to read, which a fill answers from title and abstract. */
    rows_without_document: number;
    /**
     * Rows whose last fill stopped before they were answered (`Row.failure`).
     * Absent on records written before the field.
     */
    failed_rows?: number;
    /** The default row set of the next fill, and its cells. */
    remaining_rows: number;
    remaining_cells: number;
    answered: number;
    /** Filler answers read from the title and abstract only. */
    title_abstract_only: number;
    /** Failed answers; rows that could not be read are `failed_rows`. */
    failed: number;
    stale: number;
}

/** A question column as the recorded call left it. */
export interface TableRecordColumn {
    id: string;
    header: string;
    type: string;
    /** The column's question. */
    description?: string | null;
    /** `select` columns: the category labels. */
    options?: string[] | null;
    role?: string | null;
}

/** A source entry as the recorded call left it. */
export interface TableRecordSource {
    id: string;
    /** `items`, `library`, or a search type. */
    type: string;
    /** `library` entries: collection, tag or saved_search, and its display name. */
    kind?: string | null;
    name?: string | null;
    library_ref?: string | null;
    /** Rows this entry added; a row several entries found counts for each. */
    rows: number;
}

/**
 * What the fill a call started did, for the stage card. Cell counts unless
 * named rows. A fill still running when the call returned (`running`)
 * carries the counts it had then.
 */
export interface TableFillRecord {
    /** Absent on records of fills that ran inside the chat run: `done`. */
    status?: 'done' | 'running';
    /** Rows the fill planned. */
    rows: number;
    rows_filled: number;
    /**
     * Rows the fill could not answer: their document could not be read, the
     * model gave no answer, or time ran out. Rows without input are apart.
     */
    rows_failed: number;
    /**
     * Rows never started, by reason: stopped, insufficient_credits,
     * price_changed, account_changed, changed, unavailable, shutdown.
     */
    rows_not_started: Record<string, number>;
    /** Rows with neither a document nor an abstract (failure `no_source`). */
    rows_without_input: number;
    /** Rows answered whose commit did not land. */
    rows_not_written: number;
    /** Records of fills that ran inside the chat run only. */
    rows_uncertain?: number;
    answered: number;
    not_reported: number;
    /** Answered cells read from the title and abstract only. */
    from_title_abstract: number;
    /** Records of fills that ran inside the chat run only: failed answers (cells). */
    failed?: number;
    /** Cell writes the table refused, by reason. */
    skipped: Record<string, number>;
    documents_read: number;
    /** The fill's own credits, charged per paper; never part of the run's. */
    credits_charged: number;
    credits_planned?: number | null;
    /** Why the fill ended early, when it did. */
    stopped_by?: string | null;
    /**
     * How the credit confirmation that stopped the fill ended: `declined`,
     * `timed_out`, `unreachable` or `no_credits`. Absent unless credits
     * stopped it, and on records written before the field.
     */
    credit_confirmation?: string | null;
}

export interface TableRecord {
    reference: TableReference;
    change: string;
    /**
     * The table's description, sources and question columns as of the call.
     * Absent on records written before they were recorded.
     */
    description?: string | null;
    sources?: TableRecordSource[] | null;
    columns?: TableRecordColumn[] | null;
    summary: Partial<TableSummary>;
    changes?: Record<string, number>;
    /** An `edit_table` call's change list, as the plugin applied it. */
    edits?: TableChange[] | null;
    operation_id?: string | null;
    version?: number | null;
    saved?: boolean | null;
    /** Absent from records written before stage counts existed. */
    stages?: TableStages | null;
    /**
     * `none` when the call wrote the table without running the filler, `fill`
     * when it ran it; `fill` then carries the call's own counts.
     */
    run?: 'none' | 'fill' | null;
    fill?: TableFillRecord | null;
    next_step?: string | null;
    /** ISO time of the call the counts describe. */
    as_of?: string | null;
}

/** Portable stored-document provider envelopes. Optional nulls are wire defaults. */
export interface ArtifactRequest {
    event: "artifact_request";
    request_id: string;
    op: string;
    key?: string | null;
    keys?: string[] | null;
    kind?: "table" | null;
    library_ref?: string | null;
    /** `create`: bare key of the collection the new table is filed into. */
    collection_key?: string | null;
    title?: string | null;
    /** `create`: the table's description. */
    description?: string | null;
    /** `preview` and `create`: the source entries as approved, with their ids. */
    sources?: TableSourceEntryWire[] | null;
    /** `apply_edit`: the edits of one `edit_table` call. */
    operations?: TableEditOperations | null;
    meta?: {
        actor: "agent" | "user" | "system";
        run_id?: string | null;
        thread_id?: string | null;
        change?: string | null;
    } | null;
    operation_id?: string | null;
    to_version?: number | null;
    thread_id?: string | null;
    run_ids?: string[] | null;
    /**
     * `fill_plan`: explicit row ids (every question cell of those rows) and
     * question column ids; absent, the table's pending work. `preview` and
     * `create`: the new question columns.
     */
    rows?: string[] | null;
    columns?: string[] | TableColumnDraft[] | null;
    /** `fill`: the approved plan. */
    plan_id?: string | null;
    /** `fill`: the tool call that starts it; one tool call is one job. */
    tool_call_id?: string | null;
    /**
     * `fill`: answer `done` when the job ends (or `running` at the safety
     * deadline); without it, `running` once the job has started.
     */
    wait?: boolean | null;
}

export interface ArtifactVersion {
    version: number;
    actor: "agent" | "user" | "system";
    run_id?: string;
    thread_id?: string;
    change?: string;
    at: string;
    sha256: string;
    summary: TableSummary;
    sealed?: boolean;
    creation?: boolean;
}
export interface ArtifactItem {
    library_id: number;
    library_ref: string;
    zotero_key: string;
}
export type ArtifactListEntry = {
    key: string;
    kind: "table";
    unseen: ArtifactVersion[];
} & (
    | { unavailable: true; error_code: string }
    | {
          unavailable: false;
          title: string;
          zotero_item: ArtifactItem;
          version: number;
          sha256: string;
          summary: TableSummary;
      }
);
export interface ArtifactResponse {
    type: "artifact_response";
    request_id: string;
    op: string;
    ok: boolean;
    conflict?: boolean;
    error_code?: string;
    error?: string;
    version?: number;
    sha256?: string;
    spec?: TableSpec;
    summary?: TableSummary;
    versions?: ArtifactVersion[];
    items?: ArtifactListEntry[];
    zotero_item?: ArtifactItem;
    /** `create` and `apply_edit`: the operation had already committed. */
    replayed?: boolean;
    /**
     * `apply_edit`: the version this call's edit committed and its hash, the
     * identity an Undo of the edit must name. `version`/`sha256` describe the
     * table now; the two differ only on a replay after later writes.
     */
    edit_version?: number;
    edit_sha256?: string;
    saved?: boolean;
    outcome?: "unchanged" | "trimmed" | "trashed";
    trimmed_versions?: number[];
    trimmed_to?: number | null;
    retention_exhausted?: boolean;
    /** The table's pending work beside `summary` (read, create, apply_edit, revert). */
    pending?: PendingWork;
    /** `preview`. */
    preview?: TablePreview;
    /** `create` and `apply_edit`: what the write changed. */
    changes?: TableChange[];
    /** `fill_plan`. */
    plan?: TableFillWirePlan;
    /** `fill`: `done` with `result`, or `running`; both with the job's id and progress. */
    status?: "done" | "running";
    /** `fill`, and a `fill_in_progress` refusal: the job. */
    job_id?: string;
    progress?: TableFillProgress;
    result?: TableFillResult;
}

const contracts: Record<string, [string[], string[]]> = {
    list: [["keys"], ["kind", "thread_id"]],
    read: [["key"], []],
    versions: [["key"], []],
    preview: [["sources"], ["columns"]],
    create: [
        ["kind", "library_ref", "title", "sources", "meta", "operation_id"],
        ["collection_key", "description", "columns"],
    ],
    apply_edit: [["key", "operations", "meta", "operation_id"], []],
    revert: [["key", "to_version", "meta"], []],
    trim: [["key", "thread_id", "run_ids"], []],
    delete: [["key"], []],
    fill_plan: [["key"], ["rows", "columns"]],
    fill: [["plan_id", "tool_call_id", "wait"], []],
};
const handle = /^(u|g[1-9]\d*)-[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
const nonempty = (value: unknown): value is string =>
    typeof value === "string" && !!value.trim();
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);

/** Refuse malformed envelopes before touching identity, content, or receipts. */
export function validateArtifactRequest(
    raw: unknown,
): "invalid_request" | "unsupported_op" | null {
    if (
        !object(raw) ||
        raw.event !== "artifact_request" ||
        !nonempty(raw.request_id) ||
        !nonempty(raw.op)
    )
        return "invalid_request";
    if (!Object.hasOwnProperty.call(contracts, raw.op)) return "unsupported_op";
    const [required, optional] = contracts[raw.op];
    const fields = new Set(
        Object.values(contracts).flatMap(([r, o]) => [...r, ...o]),
    );
    for (const [name, value] of Object.entries(raw)) {
        if (["event", "request_id", "op"].includes(name)) continue;
        if (
            !fields.has(name) ||
            (value != null &&
                !required.includes(name) &&
                !optional.includes(name))
        )
            return "invalid_request";
    }
    if (required.some((name) => raw[name] == null)) return "invalid_request";
    if (
        raw.key != null &&
        (typeof raw.key !== "string" || !handle.test(raw.key))
    )
        return "invalid_request";
    if (
        raw.collection_key != null &&
        (typeof raw.collection_key !== "string" ||
            !/^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(raw.collection_key))
    )
        return "invalid_request";
    if (
        raw.keys != null &&
        (!Array.isArray(raw.keys) ||
            raw.keys.length > 200 ||
            new Set(raw.keys).size !== raw.keys.length ||
            raw.keys.some(
                (key) => typeof key !== "string" || !handle.test(key),
            ))
    )
        return "invalid_request";
    if (raw.kind != null && raw.kind !== "table") return "invalid_request";
    if (
        raw.library_ref != null &&
        (typeof raw.library_ref !== "string" ||
            !/^(u|g[1-9]\d*)$/.test(raw.library_ref))
    )
        return "invalid_request";
    for (const name of ["thread_id", "operation_id", "plan_id", "tool_call_id"])
        if (raw[name] != null && !nonempty(raw[name])) return "invalid_request";
    if (raw.wait != null && typeof raw.wait !== "boolean") return "invalid_request";
    const idLists: (readonly [string, number])[] =
        raw.op === "fill_plan" ? [["rows", 1000], ["columns", 30]] : [["rows", 1000]];
    for (const [name, max] of idLists) {
        const list = raw[name];
        if (
            list != null &&
            (!Array.isArray(list) ||
                !list.length ||
                list.length > max ||
                new Set(list).size !== list.length ||
                !list.every(nonempty))
        )
            return "invalid_request";
    }
    if (
        raw.op !== "fill_plan" &&
        raw.columns != null &&
        (!Array.isArray(raw.columns) || raw.columns.length > 30 || !raw.columns.every(object))
    )
        return "invalid_request";
    if (raw.sources != null) {
        if (
            !Array.isArray(raw.sources) ||
            !raw.sources.length ||
            raw.sources.length > 50 ||
            !raw.sources.every((source) => object(source) && nonempty(source.id) && nonempty(source.type))
        )
            return "invalid_request";
        const ids = raw.sources.map((source) => (source as { id: string }).id);
        if (new Set(ids).size !== ids.length) return "invalid_request";
    }
    if (raw.operations != null && !object(raw.operations)) return "invalid_request";
    if (raw.description != null && typeof raw.description !== "string")
        return "invalid_request";
    if (
        raw.to_version != null &&
        (!Number.isSafeInteger(raw.to_version) || (raw.to_version as number) < 1)
    )
        return "invalid_request";
    if (
        raw.run_ids != null &&
        (!Array.isArray(raw.run_ids) || !raw.run_ids.every(nonempty))
    )
        return "invalid_request";
    if (raw.title != null && typeof raw.title !== "string")
        return "invalid_request";
    if (raw.meta != null) {
        if (
            !object(raw.meta) ||
            !["agent", "user", "system"].includes(raw.meta.actor as string)
        )
            return "invalid_request";
        if (
            Object.keys(raw.meta).some(
                (key) =>
                    !["actor", "run_id", "thread_id", "change"].includes(key),
            )
        )
            return "invalid_request";
        for (const name of ["run_id", "thread_id"])
            if (raw.meta[name] != null && !nonempty(raw.meta[name]))
                return "invalid_request";
        if (raw.meta.change != null && typeof raw.meta.change !== "string")
            return "invalid_request";
        if (
            raw.meta.actor === "agent" &&
            (!nonempty(raw.meta.run_id) || !nonempty(raw.meta.thread_id))
        )
            return "invalid_request";
    }
    return null;
}
