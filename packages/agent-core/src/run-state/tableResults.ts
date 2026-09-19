import type { AgentRun } from "../agents/types";
import type { TableRecord } from "../protocol/artifactProtocol";

/** Tools that change a stored table; their cards and the artifacts list are table-shaped. */
const TABLE_WRITE_TOOL_NAMES = new Set([
    "create_table",
    "edit_rows",
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
    /** True when the answer created the table rather than editing an existing one. */
    created: boolean;
}

/**
 * Collect the tables an answer wrote, one entry per table in the order they
 * were first written. Several writes to one table (create, then fill) fold into
 * one entry that keeps its first tool call for identity and its last record
 * for display, so the list reports the table as the answer left it.
 */
export function collectTableArtifacts(
    runs: ReadonlyArray<Pick<AgentRun, "id" | "model_messages">>,
): TableArtifact[] {
    const byKey = new Map<string, TableArtifact>();
    for (const run of runs) {
        for (const message of run.model_messages ?? []) {
            if (message.kind !== "request") continue;
            for (const part of message.parts) {
                if (part.part_kind !== "tool-return") continue;
                if (!isTableWriteToolName(part.tool_name)) continue;
                const record = tableRecordFromMetadata(part.metadata);
                if (!record) continue;
                const existing = byKey.get(record.reference.key);
                byKey.set(record.reference.key, {
                    runId: existing?.runId ?? run.id,
                    toolcallId: existing?.toolcallId ?? part.tool_call_id,
                    record,
                    created:
                        existing?.created === true ||
                        part.tool_name === "create_table",
                });
            }
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

/** Compact status copy for table tools, independent of persisted document state. */
export function tableResultMessages(value: unknown): string[] {
    const result = tableResultBody(value);
    const messages: string[] = [];
    switch (result.error_code ?? result.status) {
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
        case "provider_unavailable":
        case "provider_offline":
        case "disconnected":
        case "unsupported_op":
            messages.push(
                "Table provider unavailable. Reconnect a supported Zotero provider to continue in chat.",
            );
            break;
    }
    if (result.ok === false && messages.length === 0) {
        messages.push(
            typeof result.error === "string"
                ? result.error
                : "The table operation could not be completed.",
        );
    }
    if (result.saved === false || result.repair_warning) {
        messages.push(
            "Changes are committed. Local bookkeeping needs repair; use Check / repair table in the item pane.",
        );
    }
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
