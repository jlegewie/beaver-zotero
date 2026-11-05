/**
 * The words a client shows for a table fill: the Fill button, the plan a
 * popover or card approves, the progress and the result. Shared so a fill
 * reads the same in the tab and in chat.
 */

import type { PendingWork } from "../layouts/tableFill";
import type {
    TableFillJobSnapshot,
    TableFillPlanSummary,
    TableFillPricing,
    TableFillResult,
} from "../protocol/tableFillProtocol";

/** Credits as a short number: `9.2`, `0.05`, `6`. */
export function formatCredits(credits: number): string {
    const rounded = Math.round(credits * 100) / 100;
    return rounded.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** "1 credit", "0.6 credits". */
export function creditsText(credits: number): string {
    const text = formatCredits(credits);
    return `${text} ${text === "1" ? "credit" : "credits"}`;
}

function count(n: number, one: string, many = `${one}s`): string {
    return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** The pricing sentence, the same everywhere a fill is priced. */
export function pricingSentence(
    prices: TableFillPricing,
    titleAbstractRows = 0,
): string {
    const sentence = `Filling costs ${creditsText(prices.document)} per paper, charged as each paper is filled. Papers that can't be read are free.`;
    if (titleAbstractRows > 0 && prices.title_abstract !== prices.document)
        return `${sentence} A paper answered from its title and abstract costs ${formatCredits(prices.title_abstract)}.`;
    return sentence;
}

/**
 * The rows the Fill button names: none when there is no new or stale work
 * and no row a document would improve, so a failure that keeps failing does
 * not keep asking; otherwise every row a fill would work on, retries
 * included, as its plan will say. `improvableRows` are rows a document would
 * improve; `alsoPending` of them are already among the pending rows.
 */
export function fillButtonRows(
    pending: PendingWork,
    improvableRows = 0,
    alsoPending = 0,
): number {
    if (pending.rows - pending.retry_rows + improvableRows <= 0) return 0;
    return pending.rows + improvableRows - alsoPending;
}

/** The Fill button's label when no fill runs. */
export function fillButtonLabel(rows: number): string {
    return rows > 0 ? `Fill ${count(rows, "row")}` : "Fill";
}

/** What a plan fills, by kind: new papers, new columns, changed questions. */
export function pendingLines(
    plan: Pick<TableFillPlanSummary, "pending" | "scope" | "rows">,
): string[] {
    if (plan.scope.kind === "retry_failed")
        return [`Retry ${count(plan.rows, "paper")} that failed last time`];
    if (plan.scope.kind === "cells") return [];
    if (plan.scope.limit)
        return [`A trial: the first ${count(plan.rows, "row")} with work to do`];
    const pending = plan.pending;
    const lines: string[] = [];
    if (pending.new_rows > 0) lines.push(`${count(pending.new_rows, "new paper")}`);
    // Unanswered cells in rows that are not new: a column added since, or
    // cells an earlier fill did not reach.
    const unanswered = pending.columns.filter((c) => c.reason === "new");
    const changed = pending.columns.filter((c) => c.reason !== "new");
    if (unanswered.length)
        lines.push(
            `Not yet answered: ${unanswered.map((c) => c.header).join(", ")}`,
        );
    if (changed.length)
        lines.push(
            `${changed.length === 1 ? "Changed column" : "Changed columns"}: ${changed.map((c) => c.header).join(", ")}`,
        );
    if (pending.retry_rows > 0)
        lines.push(`${count(pending.retry_rows, "paper")} to retry`);
    return lines;
}

/** "Reads 46 papers: 43 from the PDF, 3 from title and abstract". */
export function planRowLine(
    plan: Pick<
        TableFillPlanSummary,
        | "rows"
        | "documents"
        | "document_kinds"
        | "title_abstract"
        | "no_input"
        | "unavailable"
    >,
): string {
    const read = plan.documents + plan.title_abstract;
    const parts: string[] = [];
    if (plan.documents) {
        const kinds = Object.entries(plan.document_kinds ?? {}).filter(
            ([, n]) => n > 0,
        );
        const only = kinds.length === 1 ? kinds[0][0] : undefined;
        const source =
            only === "pdf"
                ? "the PDF"
                : only === "epub"
                  ? "the EPUB"
                  : only === "snapshot"
                    ? "the web snapshot"
                    : "their documents";
        parts.push(`${plan.documents.toLocaleString("en-US")} from ${source}`);
    }
    if (plan.title_abstract)
        parts.push(
            `${plan.title_abstract.toLocaleString("en-US")} from title and abstract`,
        );
    let line = `Reads ${count(read, "paper")}${parts.length ? `: ${parts.join(", ")}` : ""}`;
    const unreadable = plan.no_input + plan.unavailable;
    if (unreadable)
        line += `. ${count(unreadable, "paper")} can't be read and ${unreadable === 1 ? "is" : "are"} skipped`;
    return line;
}

/** The approval button: "Fill 46". */
export function fillActionLabel(
    plan: Pick<TableFillPlanSummary, "rows" | "documents" | "title_abstract">,
): string {
    return `Fill ${papersRead(plan).toLocaleString("en-US")}`;
}

/** "Fill 46 papers · 9.2 credits". */
export function planCostLine(
    plan: Pick<TableFillPlanSummary, "rows" | "credits" | "documents" | "title_abstract">,
): string {
    return `Fill ${count(papersRead(plan), "paper")} · ${creditsText(plan.credits)}`;
}

/**
 * The papers a plan reads (a document, or title and abstract); rows that
 * cannot be read are only marked. All rows when none can be read.
 */
function papersRead(plan: Pick<TableFillPlanSummary, "rows" | "documents" | "title_abstract">): number {
    return plan.documents + plan.title_abstract || plan.rows;
}

/**
 * How far the balance reaches, when the fill costs more than it: "Your 6
 * credits cover about 30 of 46 papers". Null when the balance covers it or
 * is unknown.
 */
export function balanceLine(
    plan: Pick<
        TableFillPlanSummary,
        "credits" | "balance" | "documents" | "title_abstract" | "prices"
    >,
): string | null {
    if (plan.balance == null || plan.credits <= plan.balance) return null;
    const paying = plan.documents + plan.title_abstract;
    const perPaper = paying > 0 ? plan.credits / paying : plan.prices.document;
    const covered = perPaper > 0 ? Math.floor(plan.balance / perPaper + 1e-9) : paying;
    const balance = creditsText(plan.balance);
    return `Your ${balance} ${balance.endsWith("credit") ? "covers" : "cover"} about ${Math.min(covered, paying)} of ${paying} papers`;
}

/** "About 3 minutes left". */
export function timeLeftText(seconds: number | null): string | null {
    if (seconds == null) return null;
    if (seconds < 60) return "Less than a minute left";
    const minutes = Math.round(seconds / 60);
    return `About ${count(minutes, "minute")} left`;
}

/** A fill this close to its end shows no estimate: it is over before one helps. */
const ESTIMATE_MIN_SECONDS = 120;

/**
 * What a running fill is doing now, for the line under its title: "Starting
 * to read 12 papers", "Reading 8 of 40 papers · about 4 minutes left",
 * "Stopping: finishing 3 papers already underway". The estimate shows only
 * for a fill long enough to leave and come back to. `failed` counts the rows
 * that could not be read so far ("1 failed"), apart so a client can mark it.
 */
export function progressLine(job: TableFillJobSnapshot): { status: string; failed: string | null } {
    const failed = job.rows_failed > 0 ? `${job.rows_failed.toLocaleString("en-US")} failed` : null;
    if (job.state === "stopping")
        return {
            status:
                job.in_flight > 0
                    ? `Stopping: finishing ${count(job.in_flight, "paper")} already underway`
                    : "Stopping",
            failed,
        };
    const papers = count(job.rows_total, "paper");
    if (job.rows_done === 0) return { status: `Starting to read ${papers}`, failed };
    let status = `Reading ${job.rows_done.toLocaleString("en-US")} of ${papers}`;
    const seconds = job.seconds_left;
    if (seconds != null && seconds >= ESTIMATE_MIN_SECONDS)
        status += ` · about ${count(Math.round(seconds / 60), "minute")} left`;
    return { status, failed };
}

/**
 * How a finished fill ended, for its glyph: `clean` when every row it worked
 * on was filled and saved, `stopped` when the user stopped it, `warning` when
 * rows failed, were not saved, or something else stopped it.
 */
export function resultTone(job: TableFillJobSnapshot): "clean" | "stopped" | "warning" {
    const result = job.result;
    if (!result) return "warning";
    if (result.failed_row_ids.length || result.not_written) return "warning";
    if (result.stopped_by === "stopped") return "stopped";
    return result.stopped_by ? "warning" : "clean";
}

/** The link to a finished fill's failed rows: "Show 2 failed". */
export function failedRowsLink(failed: number): string {
    return `Show ${failed.toLocaleString("en-US")} failed`;
}

/** The running button: "Stop · 12/46", or "Stopping… finishing 3 papers". */
export function runningLabel(job: TableFillJobSnapshot): string {
    if (job.state === "stopping")
        return job.in_flight > 0
            ? `Stopping… finishing ${count(job.in_flight, "paper")}`
            : "Stopping…";
    return `Stop · ${job.rows_done}/${job.rows_total}`;
}

/**
 * Why a fill stopped before running out of rows, naming the rows that could
 * not be read before it did; null when it did not stop.
 */
function stoppedText(job: TableFillJobSnapshot, result: TableFillResult): string | null {
    const failed = result.failed_row_ids.length;
    const unread = failed ? `${failed.toLocaleString("en-US")} couldn't be read` : null;
    // Lines that end in what was spent name the failures before it; the
    // sentences take them after.
    const spent = [unread, creditsText(result.credits_charged)].filter(Boolean).join(" · ");
    const after = afterText(job);
    if (result.stopped_by === "insufficient_credits") return `Out of credits ${after} · ${spent}`;
    if (result.stopped_by === "stopped") return `Stopped ${after} · ${spent}`;
    const sentence = stopSentence(result, after);
    return sentence && unread ? `${sentence}; ${unread}` : sentence;
}

function afterText(job: TableFillJobSnapshot): string {
    return `after ${job.rows_done} of ${count(job.rows_total, "paper")}`;
}

/** A stop that neither the user nor the balance caused, as a sentence. */
function stopSentence(result: TableFillResult, after: string): string | null {
    switch (result.stopped_by) {
        case "price_changed":
            return "Prices changed; fill again to see the new cost";
        case "account_changed":
            return "The fill stopped because the account changed";
        case "unavailable":
            return `The fill stopped: Beaver could not reach its server ${after}`;
        case "shutdown":
            return `The fill stopped when Beaver closed, ${after}`;
        case "library_excluded":
            return `The fill stopped ${after} because a library was excluded from Beaver`;
        case "read_only":
            return `The fill stopped ${after} because the library became read-only`;
        case "table_unavailable":
            return `The fill stopped ${after} because the table is no longer available`;
    }
    return null;
}

/**
 * A finished fill's result in a few words, for a surface that links to the
 * failed rows itself and leaves the cost to the tool call and the table:
 * "Filled 12 rows", "Stopped after 7 of 12 papers", "Out of credits after 7
 * of 12 papers".
 */
export function resultSummary(job: TableFillJobSnapshot): string {
    const result = job.result;
    if (!result) return runningLabel(job);
    const after = afterText(job);
    const line =
        result.stopped_by === "insufficient_credits"
            ? `Out of credits ${after}`
            : result.stopped_by === "stopped"
              ? `Stopped ${after}`
              : (stopSentence(result, after) ?? `Filled ${count(result.rows_answered, "row")}`);
    return result.not_written ? `${line} · ${count(result.not_written, "paper")} not saved` : line;
}

/** The result line of a finished fill. */
export function resultText(job: TableFillJobSnapshot): string {
    const result = job.result;
    if (!result) return runningLabel(job);
    const stopped = stoppedText(job, result);
    // A stop counts the papers it worked on, saved or not: name the unsaved ones.
    if (stopped)
        return result.not_written
            ? `${stopped}; ${count(result.not_written, "paper")} could not be saved`
            : stopped;
    const credits = creditsText(result.credits_charged);
    const failed = result.failed_row_ids.length;
    const parts = [`Filled ${count(result.rows_answered, "row")}`];
    if (failed) parts.push(`${failed.toLocaleString("en-US")} couldn't be read`);
    if (result.not_written)
        parts.push(`${count(result.not_written, "paper")} could not be saved`);
    const skipped = Object.values(result.skipped_cells).reduce((a, b) => a + b, 0);
    if (skipped) parts.push(`${count(skipped, "answer")} left for the next fill`);
    parts.push(credits);
    return parts.join(" · ");
}
