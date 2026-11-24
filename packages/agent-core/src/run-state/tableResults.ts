import type { AgentRun } from "../agents/types";
import type { TableRecord } from "../protocol/artifactProtocol";
import { isJobDeferral } from "../protocol/jobCallProtocol";

/** Tools that change a stored table; their cards and the artifacts list are table-shaped. */
const TABLE_WRITE_TOOL_NAMES = new Set([
    "create_table",
    "edit_table",
    "fill_table",
]);

export function isTableToolName(name: string): boolean {
    return name === "read_table" || TABLE_WRITE_TOOL_NAMES.has(name);
}

export function isTableWriteToolName(name: string): boolean {
    return TABLE_WRITE_TOOL_NAMES.has(name);
}

/** The `TableRecord` a tool return carries in its view model, if any. */
export function tableRecordFromMetadata(
    metadata: Record<string, unknown> | undefined,
): TableRecord | null {
    const view = metadata?.view as
        | { view_type?: unknown; record?: TableRecord }
        | undefined;
    const record = view?.view_type === "table" ? view.record : undefined;
    return record?.reference?.kind === "table" ? record : null;
}

/** One table an answer wrote, for the end-of-run artifacts list. */
export interface TableArtifact {
    runId: string;
    /** First tool call in the answer that wrote this table. */
    toolcallId: string;
    /** Latest observation of the table within the answer. */
    record: TableRecord;
    /** The run whose tool call returned `record`; a continued answer spans several. */
    recordRunId: string;
    /** True when the answer created the table rather than editing an existing one. */
    created: boolean;
}

/**
 * Collect the tables an answer wrote, one entry per table in the order they
 * were first written. Several writes to one table (create, then fill) fold into
 * one entry that keeps its first tool call for identity and its last record
 * for display, so the list reports the table as the answer left it.
 *
 * Only the answer's own calls count: a later message that closes a parked
 * call carries its return, but that answer did not write the table. A fill
 * call the answer left open (stopped, or left to its table) has no return
 * yet; its table comes from the state it parked with.
 */
export function collectTableArtifacts(
    runs: ReadonlyArray<Pick<AgentRun, "id" | "model_messages" | "parked">>,
): TableArtifact[] {
    const calls = new Set<string>();
    for (const run of runs) {
        for (const message of run.model_messages ?? []) {
            if (message.kind !== "response") continue;
            for (const part of message.parts) {
                if (part.part_kind === "tool-call" && isTableWriteToolName(part.tool_name)) calls.add(part.tool_call_id);
            }
        }
    }
    const byKey = new Map<string, TableArtifact>();
    const returned = new Set<string>();
    const add = (runId: string, toolCallId: string, toolName: string, record: TableRecord) => {
        const existing = byKey.get(record.reference.key);
        byKey.set(record.reference.key, {
            runId: existing?.runId ?? runId,
            toolcallId: existing?.toolcallId ?? toolCallId,
            record,
            recordRunId: runId,
            created: existing?.created === true || toolName === "create_table",
        });
    };
    for (const run of runs) {
        for (const message of run.model_messages ?? []) {
            if (message.kind !== "request") continue;
            for (const part of message.parts) {
                if (part.part_kind !== "tool-return") continue;
                if (!isTableWriteToolName(part.tool_name) || !calls.has(part.tool_call_id)) continue;
                returned.add(part.tool_call_id);
                const record = tableRecordFromMetadata(part.metadata);
                if (record) add(run.id, part.tool_call_id, part.tool_name, record);
            }
        }
    }
    for (const run of runs) {
        for (const deferral of run.parked?.requests ?? []) {
            if (!isJobDeferral(deferral) || !calls.has(deferral.tool_call_id) || returned.has(deferral.tool_call_id)) continue;
            const table = deferral.state?.table;
            if (!table || byKey.has(table)) continue;
            add(run.id, deferral.tool_call_id, deferral.tool_name, {
                reference: { kind: "table", key: table, title: deferral.state?.title ?? "" },
                change: "",
                summary: deferral.state?.rows ? { rows: deferral.state.rows } : {},
                run: "fill",
            });
        }
    }
    return [...byKey.values()];
}

export function tableResultBody(value: unknown): Record<string, unknown> {
    let body = value;
    if (typeof body === "string") {
        try {
            body = JSON.parse(body);
        } catch {
            return {};
        }
    }
    return body && typeof body === "object"
        ? (body as Record<string, unknown>)
        : {};
}

/**
 * Compact status copy for table tools, independent of persisted document
 * state. `toolName` words a fill card's outcome as a fill rather than a
 * creation.
 */
export function tableResultMessages(value: unknown, toolName?: string): string[] {
    const result = tableResultBody(value);
    const messages: string[] = [];
    const fill = toolName === "fill_table";
    switch (result.error_code ?? result.status) {
        case "declined":
            messages.push(fill ? "The fill was declined. Nothing was filled." : "The table was declined. Nothing was created.");
            break;
        case "card_timed_out":
            messages.push(
                fill
                    ? "The fill card was not answered in time. Nothing was filled."
                    : "The table card was not answered in time. Nothing was created.",
            );
            break;
        case "card_unreachable":
            messages.push(
                fill ? "The fill card could not be shown. Nothing was filled." : "The table card could not be shown. Nothing was created.",
            );
            break;
        case "credits_declined":
            // Also a run with no credits, or a confirmation nobody answered.
            messages.push("No more credits can be spent in this run, so nothing was filled.");
            break;
        case "schema_changed":
            messages.push(
                "Extraction paused because the questions or population changed. Request a new plan in chat and review its approval.",
            );
            break;
        case "uncommitted":
        case "confirmed_uncommitted":
            messages.push(
                "Answers were produced but were not saved to the table. Executed work may still be charged. Review current questions and answers before requesting further work.",
            );
            break;
        case "outcome_unknown":
            messages.push(
                "The operation may have completed. Inspect Zotero and select the table if it exists. Do not create a replacement or repeat extraction automatically. For edits, inspect current state before requesting another change; an earlier write may still finish.",
            );
            break;
        case "conflict":
            messages.push(
                "The table changed while this operation was running. Review the current table before requesting changes again.",
            );
            break;
        case "zotero_unresponsive":
            messages.push(
                "Zotero stopped responding, so the table operation did not finish. Anything already saved stays in the table.",
            );
            break;
        case "provider_unavailable":
        case "provider_offline":
        case "zotero_offline":
        case "disconnected":
        case "unsupported_op":
            messages.push(
                "Table provider unavailable. Reconnect a supported Zotero provider to continue in chat.",
            );
            break;
    }
    // Created with the fill: the table was created, and the fill did not run. The
    // error itself is written for the model.
    if (typeof result.fill_error === "string" && result.fill_error)
        messages.push("The table was created, but the fill did not run. Ask Beaver to fill it.");
    if (result.ok === false && messages.length === 0) {
        messages.push(
            typeof result.error === "string"
                ? result.error
                : "The table operation could not be completed.",
        );
    }
    // `saved: false` / `repair_warning` (the write committed, its local
    // bookkeeping did not) is not a chat status: opening the table repairs it,
    // and the table tab reports what is still pending.
    if (result.recording_warning) {
        messages.push(
            "The confirmed table outcome is unchanged, but saving its chat result failed. Do not repeat the table change to repair chat history.",
        );
    }
    const rejected =
        typeof result.rejected_count === "number"
            ? result.rejected_count
            : Array.isArray(result.rejected)
              ? result.rejected.length
              : 0;
    if (rejected > 0)
        messages.push(
            `${rejected} row change${rejected === 1 ? " was" : "s were"} rejected.${result.ok === false ? "" : " Other accepted changes remain in the table."}`,
        );
    if (result.status === "partial")
        messages.push(
            "Work is partially complete. Earlier committed answers remain in the table.",
        );
    return messages;
}
