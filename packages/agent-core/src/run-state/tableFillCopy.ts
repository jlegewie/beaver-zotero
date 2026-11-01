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

/** The running button: "Stop · 12/46", or "Stopping… finishing 3 papers". */
export function runningLabel(job: TableFillJobSnapshot): string {
    if (job.state === "stopping")
        return job.in_flight > 0
            ? `Stopping… finishing ${count(job.in_flight, "paper")}`
            : "Stopping…";
    return `Stop · ${job.rows_done}/${job.rows_total}`;
}

/** The result line of a finished fill. */
export function resultText(job: TableFillJobSnapshot): string {
    const result = job.result;
    if (!result) return runningLabel(job);
    const credits = creditsText(result.credits_charged);
    const papers = (n: number) => count(n, "paper");
    switch (result.stopped_by) {
        case "insufficient_credits":
            return `Out of credits after ${job.rows_done} of ${papers(job.rows_total)} · ${credits}`;
        case "price_changed":
            return "Prices changed; fill again to see the new cost";
        case "account_changed":
            return "The fill stopped because the account changed";
        case "unavailable":
            return `The fill stopped: Beaver could not reach its server after ${job.rows_done} of ${papers(job.rows_total)}`;
        case "shutdown":
            return `The fill stopped when Beaver closed, after ${job.rows_done} of ${papers(job.rows_total)}`;
        case "stopped":
            return `Stopped after ${job.rows_done} of ${papers(job.rows_total)} · ${credits}`;
    }
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
