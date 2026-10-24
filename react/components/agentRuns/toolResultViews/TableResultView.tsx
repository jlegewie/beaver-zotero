import React from "react";
import type { TableView } from "@beaver/agent-core/run-state/toolResultViews";
import { useTableDisplay } from "../../../hooks/useTableDisplay";

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `answered` in current summaries; `filled` in results recorded before it. */
type SummaryColumn = { system?: boolean; answered?: number; filled?: number };

/**
 * "3 rows · 2 columns", or null when the record carries no counts.
 *
 * Columns are the table's content columns: the reference and the questions.
 * System columns (year, DOI, row type) are metadata the backend adds and the
 * table shows in the expanded row, so counting them overstates the table the
 * user reads. `contentColumns` is a count already made that way;
 * otherwise system columns are subtracted using `columns_detail`.
 */
export function formatTableCounts(summary: {
    rows?: number;
    columns?: number;
    contentColumns?: number;
    columns_detail?: Record<string, SummaryColumn>;
}): string | null {
    const parts: string[] = [];
    if (typeof summary.rows === "number") parts.push(plural(summary.rows, "row"));
    if (typeof summary.contentColumns === "number") {
        parts.push(plural(summary.contentColumns, "column"));
    } else if (typeof summary.columns === "number") {
        const system = Object.values(summary.columns_detail ?? {}).filter(
            (column) => column?.system,
        ).length;
        parts.push(plural(Math.max(0, summary.columns - system), "column"));
    }
    return parts.length ? parts.join(" · ") : null;
}

/**
 * "2 rows added · 1 column removed" from the record's counter map. Keys are
 * backend-defined `<noun>_<verb>` snake case; the noun is singularized for a
 * count of one so "1 rows added" never appears.
 */
/**
 * "33 of 35 cells filled" over the content columns, or null without a
 * per-column summary. The record's own cell counter includes the system
 * columns, so it would not match the rows × columns the card states.
 */
function formatFilledCells(summary: TableView["record"]["summary"]): string | null {
    if (typeof summary.rows !== "number" || !summary.columns_detail) return null;
    const visible = Object.values(summary.columns_detail as Record<string, SummaryColumn>).filter(
        (column) => column && !column.system,
    );
    if (visible.length === 0) return null;
    const filled = visible.reduce((sum, column) => sum + (column.answered ?? column.filled ?? 0), 0);
    return `${filled} of ${plural(summary.rows * visible.length, "cell")} filled`;
}

function formatTableChanges(
    changes: Record<string, number> | undefined,
    summary: TableView["record"]["summary"],
): string | null {
    if (!changes) return null;
    // A call that added every row and column created the table: the counts
    // line already says how big it is, and what it adds is how much of the
    // table the call filled.
    const created =
        changes.rows_added === summary.rows &&
        changes.columns_added === summary.columns;
    if (created) return formatFilledCells(summary);
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
    const changes = formatTableChanges(record.changes, record.summary);
    // The card's header already names the tool ("Create table"), so a change
    // line that only restates it is dropped.
    const change = /^created? (the )?table\.?$/i.test(record.change?.trim() ?? "")
        ? null
        : record.change;
    const currentDiffers =
        current?.status === "available" &&
        (current.title !== record.reference.title ||
            current.rows !== record.summary.rows ||
            current.columns !== record.summary.columns);
    return (
        <div className="display-flex flex-col gap-1 px-3 py-2 text-sm">
            {change && <div className="font-color-primary">{change}</div>}
            {(counts || changes) && (
                <div className="font-color-secondary">
                    {[counts, changes].filter(Boolean).join(" · ")}
                </div>
            )}
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
