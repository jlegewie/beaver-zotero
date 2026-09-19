import React from "react";
import type { TableView } from "@beaver/agent-core/run-state/toolResultViews";
import { useTableDisplay } from "../../../hooks/useTableDisplay";

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "3 rows · 2 columns", or null when the record carries no counts. */
export function formatTableCounts(summary: {
    rows?: number;
    columns?: number;
}): string | null {
    const parts: string[] = [];
    if (typeof summary.rows === "number") parts.push(plural(summary.rows, "row"));
    if (typeof summary.columns === "number")
        parts.push(plural(summary.columns, "column"));
    return parts.length ? parts.join(" · ") : null;
}

/**
 * "2 rows added · 1 column removed" from the record's counter map. Keys are
 * backend-defined `<noun>_<verb>` snake case; the noun is singularized for a
 * count of one so "1 rows added" never appears.
 */
function formatTableChanges(changes?: Record<string, number>): string | null {
    if (!changes) return null;
    const parts = Object.entries(changes)
        .filter(([, count]) => typeof count === "number" && count > 0)
        .map(([key, count]) => {
            const [noun, ...rest] = key.split("_");
            const word =
                count === 1 && noun.endsWith("s") ? noun.slice(0, -1) : noun;
            return `${count} ${[word, ...rest].join(" ")}`;
        });
    return parts.length ? parts.join(" · ") : null;
}

/**
 * Expanded body of a table tool card: what the call changed and the table's
 * size at that step, then how the table looks now when that differs.
 *
 * The historical observation stays as recorded; the current line is the only
 * part that follows the document, so a later rename or edit reads as "now …"
 * rather than rewriting what the call did. The header owns the title and the
 * open affordance.
 */
export function TableResultView({ view }: { view: TableView }) {
    const { record } = view;
    const current = useTableDisplay(record.reference.key);
    const counts = formatTableCounts(record.summary);
    const changes = formatTableChanges(record.changes);
    const currentDiffers =
        current?.status === "available" &&
        (current.title !== record.reference.title ||
            current.rows !== record.summary.rows ||
            current.columns !== record.summary.columns);
    return (
        <div className="display-flex flex-col gap-1 px-3 py-2 text-sm">
            {record.change && (
                <div className="font-color-primary">{record.change}</div>
            )}
            {counts && <div className="font-color-secondary">{counts}</div>}
            {changes && <div className="font-color-secondary">{changes}</div>}
            {currentDiffers && current.status === "available" && (
                <div className="font-color-secondary">
                    {`Now ${formatTableCounts(current)}`}
                    {current.title !== record.reference.title &&
                        ` · ${current.title}`}
                </div>
            )}
            {current?.status === "unavailable" && (
                <div role="status" className="font-color-tertiary">
                    {current.reason}
                </div>
            )}
            {record.saved === false && (
                <div role="status" className="font-color-secondary">
                    Changes are committed. Local bookkeeping needs repair; use
                    Check / repair table in the item pane.
                </div>
            )}
        </div>
    );
}
