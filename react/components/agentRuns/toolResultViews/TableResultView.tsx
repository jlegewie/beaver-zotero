import React from "react";
import type { TableRecordColumn, TableRecordSource } from "@beaver/agent-core/protocol/artifactProtocol";
import type { TableView } from "@beaver/agent-core/run-state/toolResultViews";
import { tableChangeLines, type TableChangeTone } from "@beaver/agent-core/run-state/tableEditCopy";
import { ColumnOptionChips, ColumnTypeTag } from "../../tables/columnTypes";
import { sourceKindIcon } from "../../tables/sourceKinds";
import { Icon } from "../../icons/icons";

/** Additions green, changes amber, removals red. */
const TONE_CLASS: Record<TableChangeTone, string> = {
    add: "font-color-green",
    change: "font-color-orange",
    remove: "font-color-red",
};

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `answered` in current summaries; `filled` in results recorded before it. */
type SummaryColumn = { system?: boolean; answered?: number; filled?: number };

type TableRecord = TableView["record"];

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
 * The size line of a record: rows, then the columns the user reads — the
 * recorded question columns when the record names them, otherwise the content
 * columns counted from the summary.
 */
function formatSize(record: TableRecord): string | null {
    if (!record.columns) return formatTableCounts(record.summary);
    const parts: string[] = [];
    if (typeof record.summary.rows === "number") parts.push(plural(record.summary.rows, "row"));
    parts.push(plural(record.columns.length, "column"));
    return parts.join(" · ");
}

/**
 * "33 of 35 cells filled" over the content columns, "not filled yet" when
 * none is, or null without a per-column summary. The record's own cell
 * counter includes the system columns, so it would not match the rows ×
 * columns the card states.
 */
function formatFilledCells(record: TableRecord): string | null {
    const { summary } = record;
    if (typeof summary.rows !== "number" || !summary.columns_detail) return null;
    const detail = summary.columns_detail as Record<string, SummaryColumn>;
    const visible = record.columns
        ? record.columns.map((column) => detail[column.id] ?? {})
        : Object.values(detail).filter((column) => column && !column.system);
    if (visible.length === 0) return null;
    const filled = visible.reduce((sum, column) => sum + (column.answered ?? column.filled ?? 0), 0);
    if (filled === 0 && record.columns) return "not filled yet";
    return `${filled} of ${plural(summary.rows * visible.length, "cell")} filled`;
}

/**
 * "2 rows added · 1 column removed" from the record's counter map. Keys are
 * backend-defined `<noun>_<verb>` snake case; the noun is singularized for a
 * count of one so "1 rows added" never appears. A call that added every row
 * and column created the table: the size line already says how big it is, so
 * what it adds is how much of the table is filled.
 */
function formatTableChanges(record: TableRecord): string | null {
    const { changes, summary } = record;
    if (!changes) return null;
    const created =
        changes.rows_added === summary.rows &&
        changes.columns_added === summary.columns;
    if (created) return formatFilledCells(record);
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
 * The stage lines of a record that carries stage counts: how much of the
 * table a partial fill left, the rows that could not be read, the answers
 * read from the title and abstract only, and the answers that failed. Empty
 * for records written before stage counts existed.
 */
export function formatTableStages(record: TableRecord): string[] {
    const stages = record.stages;
    if (!stages) return [];
    const lines: string[] = [];
    // Before anything is answered every row remains; the size line says so.
    if (stages.answered > 0 && stages.remaining_rows > 0)
        lines.push(`${plural(stages.remaining_rows, "row")} still to fill`);
    const failedRows = stages.failed_rows ?? 0;
    if (failedRows > 0) lines.push(`${plural(failedRows, "paper")} could not be read`);
    if (stages.title_abstract_only > 0)
        lines.push(`${plural(stages.title_abstract_only, "answer")} from title and abstract only`);
    if (stages.failed > 0) lines.push(`${plural(stages.failed, "cell")} failed`);
    return lines;
}

/** Why rows were left unattempted, as the stage card says it. */
const NOT_STARTED_REASONS: Record<string, string> = {
    stopped: "the fill was stopped",
    insufficient_credits: "out of credits",
    price_changed: "prices changed",
    account_changed: "the account changed",
    changed: "they changed while the fill started",
    unavailable: "Beaver could not reach its server",
    shutdown: "Zotero was closed",
    // Records of fills that ran inside the chat run.
    deadline: "the fill ran out of time",
    credits: "more credits were not approved",
    cancel: "the run was stopped",
};

function notStartedReason(reason: string): string {
    return NOT_STARTED_REASONS[reason] ?? reason;
}

/** Why cell writes were skipped, as the stage card says it. */
const SKIP_REASONS: Record<string, string> = {
    user_cell: "edited by you",
    question_changed: "question changed during the fill",
    row_removed: "row removed during the fill",
    column_removed: "column removed during the fill",
    column_changed: "column changed during the fill",
    documents_changed: "document changed during the fill",
};

function formatCredits(credits: number): string {
    const rounded = Math.round(credits * 100) / 100;
    return `${rounded} credit${rounded === 1 ? "" : "s"}`;
}

/**
 * What the fill this call started did: rows filled of those planned, rows
 * failed, rows not started and why, rows without a document or abstract,
 * answers from title and abstract, skipped cells, and the fill's credits. A
 * fill still running when the call returned says so; its progress is in the
 * panel above the composer. Empty for a call that started no fill.
 */
export function formatFillLines(record: TableRecord): string[] {
    const fill = record.run === "fill" ? record.fill : null;
    if (!fill) return [];
    const lines: string[] = [];
    if (fill.status === "running") {
        lines.push(`Filling ${plural(fill.rows, "row")} in the background`);
        return lines;
    }
    lines.push(`Filled ${fill.rows_filled} of ${plural(fill.rows, "row")}`);
    if (fill.rows_failed > 0) lines.push(`${plural(fill.rows_failed, "row")} failed`);
    for (const [reason, rows] of Object.entries(fill.rows_not_started ?? {})) {
        if (rows > 0)
            lines.push(`${plural(rows, "row")} not started: ${notStartedReason(reason)}`);
    }
    const unsaved = fill.rows_not_written + (fill.rows_uncertain ?? 0);
    if (unsaved > 0) lines.push(`${plural(unsaved, "row")} answered but not confirmed saved`);
    if (fill.rows_without_input > 0)
        lines.push(`${plural(fill.rows_without_input, "row")} without a document or abstract`);
    if (fill.from_title_abstract > 0)
        lines.push(`${plural(fill.from_title_abstract, "answer")} from title and abstract only`);
    for (const [reason, cells] of Object.entries(fill.skipped ?? {})) {
        if (cells > 0) lines.push(`${plural(cells, "cell")} skipped: ${SKIP_REASONS[reason] ?? reason}`);
    }
    if (fill.credits_charged > 0) lines.push(`Table fill · ${formatCredits(fill.credits_charged)}`);
    return lines;
}

/** The name the create card gives a source. */
function sourceName(source: TableRecordSource): string {
    if (source.type === "items") return "Selected items";
    if (source.name) return source.name;
    return source.kind === "collection" ? "Collection" : source.kind === "tag" ? "Tag" : "Saved search";
}

/** One source entry: its kind icon, its name, and the rows it added. */
function SourceRow({ source }: { source: TableRecordSource }) {
    return (
        <div className="table-record-row">
            <div className="display-flex flex-row items-center gap-2 min-w-0">
                <Icon icon={sourceKindIcon(source.type, source.kind)} className="table-card-source-icon flex-none" />
                <span className="flex-1 min-w-0 truncate font-medium font-color-primary">
                    {sourceName(source)}
                </span>
                <span className="font-color-secondary flex-none">{plural(source.rows, "row")}</span>
            </div>
        </div>
    );
}

/** "8/12" when the column has answers, so a partly filled table shows where. */
function columnProgress(record: TableRecord, column: TableRecordColumn): string | null {
    const detail = (record.summary.columns_detail as Record<string, SummaryColumn> | undefined)?.[column.id];
    const answered = detail?.answered ?? detail?.filled ?? 0;
    const rows = record.summary.rows;
    return answered > 0 && typeof rows === "number" ? `${answered}/${rows}` : null;
}

/**
 * One question column, read like the create card's column summary: the
 * header with its type tag, the question, and a category column's options.
 */
function ColumnRow({ column, progress }: { column: TableRecordColumn; progress: string | null }) {
    return (
        <div className="table-record-row">
            <div className="display-flex flex-row items-center gap-2 min-w-0">
                <span className="flex-1 min-w-0 truncate font-medium font-color-primary">
                    {column.header}
                </span>
                {progress && <span className="font-color-secondary flex-none">{progress}</span>}
                <span className="flex-none">
                    <ColumnTypeTag type={column.type} />
                </span>
            </div>
            {column.description && (
                <div className="table-card-column-question font-color-secondary" title={column.description}>
                    {column.description}
                </div>
            )}
            {column.type === "select" && !!column.options?.length && (
                <ColumnOptionChips options={column.options} />
            )}
        </div>
    );
}

/**
 * Expanded body of a table tool card, rendered from the record alone: the
 * table's description, the sources its rows came from and its question
 * columns as the call left them, then its size and how much is filled.
 *
 * The record is the call's historical observation, so a later edit to the
 * table never rewrites what an earlier card says. The header owns the title
 * and the open affordance. Records written before sources and columns were
 * recorded show the counts alone.
 */
export function TableResultView({ view }: { view: TableView }) {
    const { record } = view;
    // The card's header already names the tool ("Create table"), so a change
    // line that only restates it is dropped.
    const change = /^(created?|read) (the )?table\.?$/i.test(record.change?.trim() ?? "")
        ? null
        : record.change;
    const statusLine = [formatSize(record), formatTableChanges(record)].filter(Boolean).join(" · ");
    const fillLines = formatFillLines(record);
    // A fill's own lines say what it answered from metadata; the table's
    // stage lines then add what is left and what failed overall.
    const stageLines = formatTableStages(record).filter(
        (line) => !(fillLines.length && line.endsWith("from title and abstract only")),
    );
    const sources = record.sources ?? [];
    const columns = record.columns ?? [];
    const edits = tableChangeLines(record.edits ?? []);
    return (
        <div className="table-record text-sm">
            {(change || record.description) && (
                <div className="table-record-section">
                    {change && <div className="font-color-primary">{change}</div>}
                    {record.description && (
                        <div className="font-color-secondary">{record.description}</div>
                    )}
                </div>
            )}
            {edits.length > 0 && (
                <div className="table-record-section">
                    <div className="table-record-label">Changes</div>
                    <div className="table-record-list">
                        {edits.map((line, index) => (
                            <div key={index} className={`table-record-change ${TONE_CLASS[line.tone]}`}>
                                {line.text}
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {sources.length > 0 && (
                <div className="table-record-section">
                    <div className="table-record-label">Sources</div>
                    <div className="table-record-list">
                        {sources.map((source) => (
                            <SourceRow key={source.id} source={source} />
                        ))}
                    </div>
                </div>
            )}
            {columns.length > 0 && (
                <div className="table-record-section">
                    <div className="table-record-label">Columns</div>
                    <div className="table-record-list">
                        {columns.map((column) => (
                            <ColumnRow
                                key={column.id}
                                column={column}
                                progress={columnProgress(record, column)}
                            />
                        ))}
                    </div>
                </div>
            )}
            {fillLines.length > 0 && (
                <div className="table-record-section">
                    <div className="table-record-label">Fill</div>
                    {fillLines.map((line, index) => (
                        <div key={line} className={index === 0 ? "font-color-primary" : "font-color-secondary"}>
                            {line}
                        </div>
                    ))}
                </div>
            )}
            {(statusLine || stageLines.length > 0) && (
                <div className="table-record-section">
                    {statusLine && <div className="font-color-primary">{statusLine}</div>}
                    {stageLines.map((line) => (
                        <div key={line} className="font-color-secondary">
                            {line}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
