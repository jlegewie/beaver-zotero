export function isTableToolName(name: string): boolean {
    return [
        "create_table",
        "read_table",
        "edit_rows",
        "edit_table",
        "fill_table",
    ].includes(name);
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
