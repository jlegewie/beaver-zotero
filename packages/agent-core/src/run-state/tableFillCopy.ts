/**
 * The words a client shows for a table fill: the Fill button, the plan a
 * popover or card approves, the progress and the result. Shared so a fill
 * reads the same in the tab and in chat.
 */

import type { PendingWork } from "../layouts/tableFill";
import type {
    TableFillJobSnapshot,
    TableFillNotStartedReason,
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

/**
 * Whether a fill reads as stopped early. A Stop that came once every item had
 * started left nothing undone, so the fill reads as finished.
 * `notStarted` is the result's `not_started` (a record's `rows_not_started`).
 */
export function readsAsStopped(
    stoppedBy: string | null | undefined,
    notStarted: Partial<Record<string, number>> | null | undefined,
): boolean {
    return !!stoppedBy && !(stoppedBy === "stopped" && !notStarted?.stopped);
}

/** What stopped a fill, as its result reads (see {@link readsAsStopped}). */
export function shownStop(result: TableFillResult): TableFillNotStartedReason | undefined {
    return readsAsStopped(result.stopped_by, result.not_started) ? result.stopped_by : undefined;
}

/** The items a fill wrote answers for: "Filled 12 items", "Filled 11 of 12 items". */
export function filledText(answered: number, total: number): string {
    return answered === total ? `Filled ${count(total, "item")}` : `Filled ${answered.toLocaleString("en-US")} of ${count(total, "item")}`;
}

/** The pricing sentence, the same everywhere a fill is priced. */
export function pricingSentence(
    prices: TableFillPricing,
    titleAbstractRows = 0,
): string {
    const sentence = `Filling costs ${creditsText(prices.document)} per item, charged as each item is filled. Items that can't be read are free.`;
    if (titleAbstractRows > 0 && prices.title_abstract !== prices.document)
        return `${sentence} An item answered from its title and abstract costs ${formatCredits(prices.title_abstract)}.`;
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

/** One line of what a plan fills: a short label and its value, or a sentence. */
export interface PendingLine {
    label?: string;
    value: string;
}

/**
 * What a plan fills, by kind: new items, new columns, empty cells, changed
 * questions, retries. `answeredColumns` holds the columns with any answer in
 * the table: a column with unanswered cells reads as new only when it has
 * none, else its empty cells are named (cells an earlier fill did not reach).
 * New items are named only beside other work: when they are all there is
 * (a table never filled), the plan's heading already says it.
 */
export function pendingLines(
    plan: Pick<TableFillPlanSummary, "pending" | "scope" | "rows">,
    answeredColumns: ReadonlySet<string> = new Set(),
): PendingLine[] {
    if (plan.scope.kind === "retry_failed")
        return [{ value: `Retry ${count(plan.rows, "item")} that failed last time` }];
    if (plan.scope.kind === "cells") return [];
    if (plan.scope.limit)
        return [{ value: `Trial run on the first ${count(plan.rows, "row")} with work to do` }];
    const pending = plan.pending;
    const lines: PendingLine[] = [];
    const headers = (columns: { header: string }[]) => columns.map((c) => c.header).join(", ");
    if (pending.new_rows > 0 && pending.new_rows < pending.rows)
        lines.push({ label: "New items", value: pending.new_rows.toLocaleString("en-US") });
    const unanswered = pending.columns.filter((c) => c.reason === "new");
    const added = unanswered.filter((c) => !answeredColumns.has(c.id));
    const gaps = unanswered.filter((c) => answeredColumns.has(c.id));
    const changed = pending.columns.filter((c) => c.reason !== "new");
    if (added.length)
        lines.push({ label: added.length === 1 ? "New column" : "New columns", value: headers(added) });
    if (gaps.length) lines.push({ label: "Empty cells", value: headers(gaps) });
    if (changed.length) lines.push({ label: "Changed", value: headers(changed) });
    if (pending.retry_rows > 0) lines.push({ label: "Retry", value: count(pending.retry_rows, "item") });
    return lines;
}

/**
 * The alert on a fill that reads answered papers again for a new or changed
 * question: a paper costs the same however many columns are filled. With a
 * trial on offer (`trialRows`), it points to it. The cost stands beside it,
 * so it names no number of credits.
 */
export function refillNotice(trialRows: number | null): string {
    const head = "Each paper is read again, so filling one column costs as much as filling all of them.";
    return trialRows
        ? `${head} Finish your column changes first, then try ${trialRows} rows to check the answers.`
        : `${head} Finish your column changes first.`;
}

/**
 * Whether a plan shows {@link refillNotice}: it reads answered rows again
 * for a new or changed question. Never on a trial, which is the advice, or
 * on a retry of failed rows.
 */
export function showsRefillNotice(plan: Pick<TableFillPlanSummary, "scope" | "rereads">): boolean {
    if (plan.scope.kind === "retry_failed") return false;
    if (plan.scope.kind === "pending" && plan.scope.limit) return false;
    return (plan.rereads ?? 0) > 0;
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
    let line = `Reads ${count(read, "item")}${parts.length ? `: ${parts.join(", ")}` : ""}`;
    const unreadable = plan.no_input + plan.unavailable;
    if (unreadable)
        line += `. ${count(unreadable, "item")} can't be read and ${unreadable === 1 ? "is" : "are"} skipped`;
    return line;
}

/** The approval button: "Fill 46". */
export function fillActionLabel(
    plan: Pick<TableFillPlanSummary, "rows" | "documents" | "title_abstract">,
): string {
    return `Fill ${papersRead(plan).toLocaleString("en-US")}`;
}

/** A plan's heading: "Fill 46 items". */
export function planTitle(
    plan: Pick<TableFillPlanSummary, "rows" | "documents" | "title_abstract">,
): string {
    return `Fill ${count(papersRead(plan), "item")}`;
}

/**
 * Where a plan's answers come from, in a few words: "43 from PDF · 3 from
 * title and abstract · 2 can't be read". Null when nothing is read.
 */
export function planSourcesLine(
    plan: Pick<
        TableFillPlanSummary,
        "documents" | "document_kinds" | "title_abstract" | "no_input" | "unavailable"
    >,
): string | null {
    const parts: string[] = [];
    if (plan.documents) {
        const kinds = Object.entries(plan.document_kinds ?? {}).filter(([, n]) => n > 0);
        const only = kinds.length === 1 ? kinds[0][0] : undefined;
        const source =
            only === "pdf"
                ? "PDF"
                : only === "epub"
                  ? "EPUB"
                  : only === "snapshot"
                    ? "web snapshot"
                    : "full text";
        parts.push(`${plan.documents.toLocaleString("en-US")} from ${source}`);
    }
    if (plan.title_abstract)
        parts.push(`${plan.title_abstract.toLocaleString("en-US")} from title and abstract`);
    const unreadable = plan.no_input + plan.unavailable;
    if (unreadable) parts.push(`${unreadable.toLocaleString("en-US")} can't be read`);
    return parts.length ? parts.join(" · ") : null;
}

/**
 * The papers a plan reads (a document, or title and abstract); rows that
 * cannot be read are only marked. All rows when none can be read.
 */
function papersRead(plan: Pick<TableFillPlanSummary, "rows" | "documents" | "title_abstract">): number {
    return plan.documents + plan.title_abstract || plan.rows;
}

/**
 * What running fills may still charge, when `balance` is `accountBalance` less
 * that: "Fills already running may use up to 4.7 of your 5 credits". Null
 * when they hold nothing, or less than the display precision (rounding residue).
 * It is an upper bound: a row that fails, or reads only an abstract, charges less.
 */
export function runningFillsText(balance: number, accountBalance: number | null): string | null {
    const account = accountBalance ?? balance;
    const held = account - balance;
    if (held < 0.005) return null;
    return `Fills already running may use up to ${formatCredits(held)} of your ${creditsText(account)}`;
}

/** What a fill costs and reads, as a shortfall is worked out from it. */
export type FillCostCounts = Pick<TableFillPlanSummary, "rows" | "credits" | "documents" | "title_abstract">;

/**
 * Prices that stand in while the real ones are unknown: the fill's credits
 * spread over its documents (or, without any, its abstracts). A document
 * costs at least an abstract, so that is never less than a row's price.
 */
function boundingPrices(fill: FillCostCounts): TableFillPricing {
    const paying = fill.documents || fill.title_abstract;
    const price = paying > 0 ? fill.credits / paying : 0;
    return { document: price, title_abstract: price };
}

/**
 * The rows, counted from a fill's first, that the balance pays for whatever
 * order its rows come in: every row is priced at the dearest price the fill
 * pays. A lower bound, so a fill of that many rows never runs out of credits.
 * Null when the balance covers the whole fill or is unknown; 0 when it does
 * not reach one row at that price.
 */
export function affordableRowsBound(
    fill: FillCostCounts,
    prices: TableFillPricing | null,
    balance: number | null,
): number | null {
    if (balance == null || fill.credits <= balance + 1e-9) return null;
    const pricing = prices ?? boundingPrices(fill);
    const dearest = Math.max(
        fill.documents ? pricing.document : 0,
        fill.title_abstract ? pricing.title_abstract : 0,
    );
    if (dearest <= 0) return null;
    return Math.min(fill.rows - 1, Math.floor(balance / dearest + 1e-9));
}

/**
 * The part of a fill a short balance pays for: its first `rows` rows (the
 * limit an approval sends), shown as `items` of `of` items, costing at most
 * `credits`.
 */
export interface AffordablePart {
    rows: number;
    items: number;
    of: number;
    credits: number;
}

/** A balance that does not cover a fill, as a card or popover warns about it. */
export interface BalanceShortfall {
    /** The warning: what the balance covers, or that the fill stops when it runs out. */
    text: string;
    /** The balance cannot pay for a single item: the fill would stop before answering anything. */
    blocked: boolean;
    /** Rows from the fill's first that the balance surely pays for (0: not even the first); null when unknown. */
    affordable: number | null;
    /** The part the balance pays for, when the surface can fill only that (`partial`); null otherwise. */
    part: AffordablePart | null;
}

/** How {@link balanceShortfall} reads the balance's reach. */
export interface ShortfallOptions {
    /** The account's balance, when `balance` is less what running fills may still charge. */
    accountBalance?: number | null;
    /** The surface can fill only the part the balance pays for: the warning then names it. */
    partial?: boolean;
    /**
     * The part the balance pays for, exactly (a kept plan's own rows), in the
     * plan's items read; asked for only once the balance falls short. Null,
     * or absent, falls back to {@link affordableRowsBound}, in rows.
     */
    exactPart?: () => Omit<AffordablePart, "of"> | null;
}

/**
 * The warning when the balance does not cover a fill. Where the surface can
 * fill only the part the balance pays for (`partial`): "Your 1.6 credits
 * cover 8 of 23 items. The rest can be filled once you add credits."
 * Otherwise: "This fill needs 3.5 credits and you have 1.6. It stops when
 * your credits run out." With running fills holding part of the account's
 * balance, it says so. A balance short of one item is `blocked`, with
 * {@link noCreditsText}. Null when the balance covers the fill or is unknown.
 */
export function balanceShortfall(
    fill: FillCostCounts,
    prices: TableFillPricing | null,
    balance: number | null,
    { accountBalance = balance, partial = false, exactPart }: ShortfallOptions = {},
): BalanceShortfall | null {
    if (balance == null || fill.credits <= balance + 1e-9) return null;
    // Without the prices, a mixed fill's cheapest item is unknown: it may
    // still pay for an abstract, so it is not blocked.
    const pricing = prices ?? boundingPrices(fill);
    const noCredits =
        prices || !(fill.documents && fill.title_abstract)
            ? noCreditsText({ ...fill, prices: pricing }, balance, accountBalance)
            : null;
    if (noCredits) return { text: noCredits, blocked: true, affordable: null, part: null };
    const exact = exactPart?.();
    let part: AffordablePart | null = null;
    let affordable: number | null;
    // Shown in the items the fill reads, as its receipt counts them.
    const read = fill.documents + fill.title_abstract || fill.rows;
    if (exact && exact.rows < fill.rows) {
        affordable = exact.rows;
        if (exact.rows > 0) part = { ...exact, of: read };
    } else {
        affordable = affordableRowsBound(fill, prices, balance);
        const dearest = Math.max(fill.documents ? pricing.document : 0, fill.title_abstract ? pricing.title_abstract : 0);
        // The bound's rows may include an item that is not read, so the items
        // it names are at most what the part reads.
        if (affordable)
            part = {
                rows: affordable,
                items: Math.min(affordable, read),
                of: read,
                credits: Math.min(balance, affordable * dearest),
            };
    }
    const running = runningFillsText(balance, accountBalance);
    if (partial && part) {
        const covers = `${part.items.toLocaleString("en-US")} of ${count(part.of, "item")}`;
        const head = running ? `${running}; the rest covers ${covers}.` : `Your ${creditsText(balance)} ${creditsText(balance).endsWith("credit") ? "covers" : "cover"} ${covers}.`;
        return { text: `${head} The rest can be filled once you add credits.`, blocked: false, affordable, part };
    }
    const needs = `This fill needs ${creditsText(fill.credits)}`;
    const head = running ? `${needs}. ${running}.` : `${needs} and you have ${formatCredits(balance)}.`;
    return { text: `${head} It stops when your credits run out.`, blocked: false, affordable, part: null };
}

/**
 * The trial a card or popover offers beside a fill, given its shortfall: none
 * when the balance cannot pay for one item or runs out within the trial, or
 * when the partial fill it offers instead is no larger.
 */
export function trialWithinBalance(trialRows: number | null, shortfall: BalanceShortfall | null): number | null {
    if (!trialRows || shortfall?.blocked) return null;
    const affordable = shortfall?.affordable;
    if (affordable == null) return trialRows;
    return affordable > trialRows || (affordable === trialRows && !shortfall?.part) ? trialRows : null;
}

/** The primary button of a fill the balance covers only in part: "Fill 8 of 23". */
export function fillPartLabel(part: AffordablePart): string {
    return `Fill ${part.items.toLocaleString("en-US")} of ${part.of.toLocaleString("en-US")}`;
}

/**
 * What filling a column added or asked anew would cost, in the column
 * editor: "Filling this column reads 200 items again: up to 70 credits. Add
 * your other columns first; one fill answers them all." Every row is counted
 * at the document price, so it is an upper bound. Null without rows or prices.
 */
export function columnFillCostText(rows: number, prices: TableFillPricing | null, again: boolean): string | null {
    if (rows <= 0 || !prices) return null;
    const credits = rows * Math.max(prices.document, prices.title_abstract);
    return `Filling this column reads ${count(rows, "item")}${again ? " again" : ""}: up to ${creditsText(credits)}. Add your other columns first; one fill answers them all.`;
}

/** The price of the cheapest item a plan pays for; null when it pays for none. */
function cheapestItem(
    plan: Pick<TableFillPlanSummary, "documents" | "title_abstract" | "prices">,
): number | null {
    const prices: number[] = [];
    if (plan.documents) prices.push(plan.prices.document);
    if (plan.title_abstract) prices.push(plan.prices.title_abstract);
    return prices.length ? Math.min(...prices) : null;
}

/**
 * Why a plan cannot start when the balance cannot pay for a single item it
 * fills, so the fill would stop before answering anything: "Filling uses
 * Beaver credits: 0.2 per item. You have 0 credits." When running fills hold
 * the account's credits, that is the reason, and waiting for them is a way
 * out: "… Fills already running may use up to 2 of your 2.02 credits. Wait
 * for them to finish or add credits." Null when the balance pays for an item,
 * is unknown, or the plan costs nothing.
 */
export function noCreditsText(
    plan: Pick<TableFillPlanSummary, "credits" | "documents" | "title_abstract"> & { prices: TableFillPricing },
    balance: number | null,
    /** The account's balance, when `balance` is less what running fills may still charge. */
    accountBalance: number | null = balance,
): string | null {
    if (balance == null || plan.credits <= 0) return null;
    const cheapest = cheapestItem(plan);
    if (cheapest == null || balance + 1e-9 >= cheapest) return null;
    const price = `Filling uses Beaver credits: ${formatCredits(plan.documents ? plan.prices.document : plan.prices.title_abstract)} per item.`;
    const running = runningFillsText(balance, accountBalance);
    if (running) return `${price} ${running}. Wait for them to finish or add credits.`;
    return `${price} You have ${creditsText(accountBalance ?? balance)}.`;
}

/** What a table can still do without credits. */
export const FILL_BY_HAND_NOTE = "You can still add rows and edit cells by hand.";

/** The table tab's notice for an account without credits. */
export const NO_CREDITS_NOTICE = `Filling uses Beaver credits, and you have none. ${FILL_BY_HAND_NOTE}`;

/** Whether the balance reads as no credits at all ("0 credits"). False when unknown. */
export function hasNoCredits(balance: number | null): boolean {
    return balance != null && formatCredits(balance) === "0";
}

/**
 * The label of a way to buy credits: "Get credits" with none to spend (or an
 * unknown balance), "Add credits" to top up a balance.
 */
export function creditsActionLabel(balance: number | null): string {
    return balance == null || hasNoCredits(balance) ? "Get credits" : "Add credits";
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
                    ? `Stopping: finishing ${count(job.in_flight, "item")} already underway`
                    : "Stopping",
            failed,
        };
    const papers = count(job.rows_total, "item");
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
    const stop = shownStop(result);
    if (stop === "stopped") return "stopped";
    return stop ? "warning" : "clean";
}

/** The link to a finished fill's failed rows: "Show 2 failed". */
export function failedRowsLink(failed: number): string {
    return `Show ${failed.toLocaleString("en-US")} failed`;
}

/** The running button: "Stop · 12/46", or "Stopping… finishing 3 papers". */
export function runningLabel(job: TableFillJobSnapshot): string {
    if (job.state === "stopping")
        return job.in_flight > 0
            ? `Stopping… finishing ${count(job.in_flight, "item")}`
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
    const after = afterText(job, result);
    const stop = shownStop(result);
    // Rows a fill never started stay pending, so the next fill picks them up.
    if (stop === "insufficient_credits")
        return `Out of credits ${after}${unread ? ` · ${unread}` : ""} · the rest stay pending`;
    if (stop === "stopped") return unread ? `Stopped ${after} · ${unread}` : `Stopped ${after}`;
    const sentence = stopSentence(stop, after);
    return sentence && unread ? `${sentence}; ${unread}` : sentence;
}

/** How far a stopped fill got, counting the items it filled: "after 6 of 12 items". */
function afterText(job: TableFillJobSnapshot, result: TableFillResult): string {
    return `after ${result.rows_answered.toLocaleString("en-US")} of ${count(job.rows_total, "item")}`;
}

/** A stop that neither the user nor the balance caused, as a sentence. */
function stopSentence(stop: TableFillNotStartedReason | undefined, after: string): string | null {
    switch (stop) {
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
 * "Filled 12 items", "Stopped after 7 of 12 items", "Out of credits after 7
 * of 12 items".
 */
export function resultSummary(job: TableFillJobSnapshot): string {
    const result = job.result;
    if (!result) return runningLabel(job);
    const after = afterText(job, result);
    const stop = shownStop(result);
    const line =
        stop === "insufficient_credits"
            ? `Out of credits ${after}`
            : stop === "stopped"
              ? `Stopped ${after}`
              : (stopSentence(stop, after) ?? filledText(result.rows_answered, job.rows_total));
    return result.not_written ? `${line} · ${count(result.not_written, "item")} not saved` : line;
}

/** Answers the table declined to write, left for the next fill. */
function skippedAnswers(result: TableFillResult): number {
    return Object.values(result.skipped_cells).reduce((a, b) => a + b, 0);
}

/**
 * Whether a finished fill's result asks something of the user: it stopped
 * early, rows could not be read or saved, or answers were left for the next
 * fill. False only for a clean result, which {@link resultText} reduces to
 * the items filled.
 */
export function resultNeedsAttention(job: TableFillJobSnapshot): boolean {
    const result = job.result;
    if (!result) return true;
    return (
        stoppedText(job, result) !== null ||
        result.failed_row_ids.length > 0 ||
        result.not_written > 0 ||
        skippedAnswers(result) > 0
    );
}

/** The result line of a finished fill. */
export function resultText(job: TableFillJobSnapshot): string {
    const result = job.result;
    if (!result) return runningLabel(job);
    const stopped = stoppedText(job, result);
    // A stop counts the papers it worked on, saved or not: name the unsaved ones.
    if (stopped)
        return result.not_written
            ? `${stopped}; ${count(result.not_written, "item")} could not be saved`
            : stopped;
    const failed = result.failed_row_ids.length;
    const parts = [filledText(result.rows_answered, job.rows_total)];
    if (failed) parts.push(`${failed.toLocaleString("en-US")} couldn't be read`);
    if (result.not_written)
        parts.push(`${count(result.not_written, "item")} could not be saved`);
    const skipped = skippedAnswers(result);
    if (skipped) parts.push(`${count(skipped, "answer")} left for the next fill`);
    return parts.join(" · ");
}
