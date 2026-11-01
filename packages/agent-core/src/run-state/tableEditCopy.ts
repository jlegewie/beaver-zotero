/**
 * The sentences of a table's change list, shared by every surface that shows
 * one (the `edit_table` tool display, later the tab's Undo toast), so they
 * read the same everywhere.
 */

import type { TableChange } from "../protocol/tableEditProtocol";

/** How a change line is coloured: additions, changes, removals. */
export type TableChangeTone = "add" | "change" | "remove";

export interface TableChangeLine {
    tone: TableChangeTone;
    text: string;
}

function plural(count: number, noun: string): string {
    return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

function quoted(text: string): string {
    return `“${text}”`;
}

function sourceLabel(change: { type?: string; kind?: string | null; name?: string | null }): string {
    if (!change.kind) return "selected papers";
    const kind = change.kind.replace("_", " ");
    return change.name ? `${kind} ${quoted(change.name)}` : kind;
}

/** One line per change, in the order applied. */
export function tableChangeLines(changes: readonly TableChange[]): TableChangeLine[] {
    const lines: TableChangeLine[] = [];
    for (const change of changes) {
        switch (change.op) {
            case "title":
                lines.push({ tone: "change", text: `Renamed the table to ${quoted(change.title)}` });
                break;
            case "description":
                lines.push({ tone: "change", text: "Rewrote the description" });
                break;
            case "add_column":
                lines.push({ tone: "add", text: `Added column ${quoted(change.header)}` });
                break;
            case "update_column": {
                const what = change.fields.length
                    ? change.fields.map((field) => (field === "header" ? "header" : field === "question" ? "question" : "options")).join(", ")
                    : "no change";
                const effects = [
                    change.stale ? `${plural(change.stale, "answer")} out of date` : null,
                    change.relabelled ? `${plural(change.relabelled, "answer")} relabelled` : null,
                    change.cleared ? `${plural(change.cleared, "answer")} cleared` : null,
                ].filter(Boolean);
                lines.push({
                    tone: "change",
                    text: `Changed column ${quoted(change.header)} (${what})${effects.length ? ` · ${effects.join(" · ")}` : ""}`,
                });
                break;
            }
            case "remove_column": {
                const yours = change.user_cleared ? `, ${change.user_cleared} of them yours` : "";
                lines.push({
                    tone: "remove",
                    text: `Removed column ${quoted(change.header)}${change.cleared ? ` · ${plural(change.cleared, "answer")}${yours}` : ""}`,
                });
                break;
            }
            case "add_source": {
                const parts = [
                    change.type === "items"
                        ? `Added ${plural(change.rows_added + change.rows_restored, "paper")}`
                        : `Added ${sourceLabel(change)} · ${plural(change.rows_added, "new paper")}`,
                    change.rows_restored ? `${change.rows_restored} restored` : null,
                    change.duplicates ? `${change.duplicates} already in the table` : null,
                    change.rejected.length ? `${change.rejected.length} could not be added` : null,
                ].filter(Boolean);
                lines.push({ tone: "add", text: parts.join(" · ") });
                break;
            }
            case "remove_source":
                lines.push({
                    tone: "remove",
                    text: `Removed ${sourceLabel(change)}${change.rows_removed ? ` · ${plural(change.rows_removed, "row")}` : ""}`,
                });
                break;
            case "refresh_source": {
                const parts = [
                    `Refreshed ${sourceLabel(change)} · ${plural(change.rows_added, "new paper")}`,
                    change.removed_skipped ? `${plural(change.removed_skipped, "removed paper")} left out` : null,
                    change.no_longer_found ? `${change.no_longer_found} no longer in it, kept` : null,
                ].filter(Boolean);
                lines.push({ tone: "add", text: parts.join(" · ") });
                break;
            }
            case "remove_rows":
                lines.push({ tone: "remove", text: `Removed ${plural(change.rows, "row")}` });
                break;
        }
    }
    return lines;
}
