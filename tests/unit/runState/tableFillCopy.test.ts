import { describe, expect, it } from "vitest";
import type { PendingWork } from "@beaver/agent-core/layouts/tableFill";
import type { TableFillJobSnapshot, TableFillPlanSummary, TableFillResult } from "@beaver/agent-core/protocol/tableFillProtocol";
import {
    balanceLine,
    creditsText,
    failedRowsLink,
    fillButtonLabel,
    fillButtonRows,
    formatCredits,
    pendingLines,
    planCostLine,
    planRowLine,
    pricingSentence,
    progressLine,
    resultSummary,
    resultNeedsAttention,
    resultText,
    resultTone,
    runningLabel,
    timeLeftText,
} from "@beaver/agent-core/run-state/tableFillCopy";

const pending = (over: Partial<PendingWork> = {}): PendingWork => ({
    rows: 0,
    cells: 0,
    new_rows: 0,
    columns: [],
    retry_rows: 0,
    blocked_rows: 0,
    ...over,
});

const plan = (over: Partial<TableFillPlanSummary> = {}): TableFillPlanSummary => ({
    plan_id: "p",
    table: { libraryID: 1, key: "K", title: "T" },
    scope: { kind: "pending" },
    rows: 46,
    cells: 92,
    documents: 43,
    document_kinds: { pdf: 43 },
    title_abstract: 3,
    no_input: 0,
    unavailable: 0,
    credits: 8.75,
    prices: { document: 0.2, title_abstract: 0.05 },
    pending: pending({ rows: 46 }),
    balance: 100,
    expires_at: 0,
    ...over,
});

const result = (over: Partial<TableFillResult> = {}): TableFillResult => ({
    rows_answered: 44,
    answered: 80,
    not_reported: 8,
    from_title_abstract: 0,
    documents_read: 44,
    credits_charged: 8.8,
    row_failures: { encrypted: 2 },
    failed_row_ids: ["a", "b"],
    not_started: {},
    not_written: 0,
    skipped_cells: {},
    pending: null,
    ...over,
});

const job = (over: Partial<TableFillJobSnapshot> = {}): TableFillJobSnapshot => ({
    job_id: "j",
    plan_id: "p",
    table: { libraryID: 1, key: "K", title: "T" },
    origin: { kind: "user" },
    state: "running",
    rows_total: 46,
    rows_done: 12,
    rows_failed: 0,
    in_flight: 3,
    credits_charged: 2.4,
    credits_planned: 9.2,
    balance: 97.6,
    started_at: 0,
    seconds_left: 300,
    ...over,
});

describe("table fill copy", () => {
    it("says credit for one and credits otherwise", () => {
        expect([creditsText(1), creditsText(0.6), creditsText(0)]).toEqual(["1 credit", "0.6 credits", "0 credits"]);
    });

    it("formats credits briefly", () => {
        expect([formatCredits(9.2), formatCredits(0.05), formatCredits(6), formatCredits(0.30000000000000004)]).toEqual(["9.2", "0.05", "6", "0.3"]);
    });

    it("states the price in one sentence", () => {
        expect(pricingSentence({ document: 0.2, title_abstract: 0.05 })).toBe(
            "Filling costs 0.2 credits per item, charged as each item is filled. Items that can't be read are free.",
        );
        expect(pricingSentence({ document: 0.2, title_abstract: 0.05 }, 3)).toMatch(/title and abstract costs 0.05\.$/);
    });

    it("lights the button for new and stale work only, plus rows a document would improve", () => {
        expect(fillButtonRows(pending({ rows: 10, retry_rows: 4 }), 2)).toBe(12);
        expect(fillButtonRows(pending({ rows: 1, retry_rows: 1 }))).toBe(0);
        // An improvable row already pending is counted once.
        expect(fillButtonRows(pending({ rows: 1 }), 1, 1)).toBe(1);
        expect(fillButtonLabel(46)).toBe("Fill 46 rows");
        expect(fillButtonLabel(1)).toBe("Fill 1 row");
        expect(fillButtonLabel(0)).toBe("Fill");
    });

    it("describes a plan: what it fills, what it reads, what it costs and how far the balance reaches", () => {
        expect(planCostLine(plan({ credits: 9.2 }))).toBe("Fill 46 items · 9.2 credits");
        expect(planRowLine(plan())).toBe("Reads 46 items: 43 from the PDF, 3 from title and abstract");
        expect(planRowLine(plan({ document_kinds: { pdf: 40, epub: 3 }, no_input: 1, unavailable: 1, rows: 48 }))).toBe(
            "Reads 46 items: 43 from their documents, 3 from title and abstract. 2 items can't be read and are skipped",
        );
        expect(
            pendingLines(
                plan({
                    pending: pending({
                        rows: 10,
                        new_rows: 3,
                        columns: [
                            { id: "n", header: "Sample", reason: "new", cells: 10 },
                            { id: "m", header: "Method", reason: "changed", cells: 4 },
                        ],
                    }),
                }),
            ),
        ).toEqual(["3 new items", "Not yet answered: Sample", "Changed column: Method"]);
        // Unreadable rows are skipped, not filled.
        expect(planCostLine(plan({ rows: 4, documents: 2, title_abstract: 1, unavailable: 1, credits: 0.45 }))).toBe("Fill 3 items · 0.45 credits");
        expect(pendingLines(plan({ scope: { kind: "retry_failed" }, rows: 2 }))).toEqual(["Retry 2 items that failed last time"]);
        expect(balanceLine(plan({ credits: 9.2, balance: 6, documents: 46, title_abstract: 0 }))).toBe("Your 6 credits cover about 30 of 46 items");
        expect(balanceLine(plan())).toBeNull();
        expect(planCostLine(plan({ rows: 5, documents: 5, title_abstract: 0, credits: 1 }))).toBe("Fill 5 items · 1 credit");
        expect(balanceLine(plan({ credits: 9.2, balance: 1, documents: 46, title_abstract: 0 }))).toBe("Your 1 credit covers about 5 of 46 items");
        expect(balanceLine(plan({ balance: null }))).toBeNull();
    });

    it("shows a running fill and its stop", () => {
        expect(runningLabel(job())).toBe("Stop · 12/46");
        expect(runningLabel(job({ state: "stopping" }))).toBe("Stopping… finishing 3 items");
        expect(timeLeftText(300)).toBe("About 5 minutes left");
        expect(timeLeftText(20)).toBe("Less than a minute left");
        expect(timeLeftText(null)).toBeNull();
    });

    it("sums up a finished fill", () => {
        expect(resultText(job({ state: "done", result: result() }))).toBe("Filled 44 rows · 2 couldn't be read");
        expect(resultText(job({ state: "done", rows_done: 30, result: result({ failed_row_ids: [], stopped_by: "insufficient_credits", credits_charged: 6 }) }))).toBe(
            "Out of credits after 30 of 46 items",
        );
        expect(resultText(job({ state: "done", rows_done: 30, result: result({ failed_row_ids: [], stopped_by: "stopped", credits_charged: 6 }) }))).toBe(
            "Stopped after 30 of 46 items",
        );
        expect(resultText(job({ state: "done", result: result({ failed_row_ids: [], stopped_by: "price_changed" }) }))).toBe(
            "Prices changed; fill again to see the new cost",
        );
        expect(resultText(job({ state: "done", result: result({ failed_row_ids: [], skipped_cells: { column_changed: 2 } }) }))).toBe(
            "Filled 44 rows · 2 answers left for the next fill",
        );
        expect(resultText(job({ state: "done", result: result({ failed_row_ids: [], not_written: 1 }) }))).toBe(
            "Filled 44 rows · 1 item could not be saved",
        );
    });

    it("says why a fill stopped: the server, an excluded library, a read-only library, a missing table", () => {
        const stopped = (stopped_by: TableFillResult["stopped_by"]) =>
            resultText(job({ state: "done", rows_done: 2, rows_total: 3, result: result({ failed_row_ids: [], stopped_by }) }));
        expect(stopped("unavailable")).toBe("The fill stopped: Beaver could not reach its server after 2 of 3 items");
        expect(stopped("library_excluded")).toBe("The fill stopped after 2 of 3 items because a library was excluded from Beaver");
        expect(stopped("read_only")).toBe("The fill stopped after 2 of 3 items because the library became read-only");
        expect(stopped("table_unavailable")).toBe("The fill stopped after 2 of 3 items because the table is no longer available");
    });

    it("names the rows a stopped fill could not read", () => {
        const stopped = (over: Partial<TableFillResult>) =>
            resultText(job({ state: "done", rows_done: 7, rows_total: 12, result: result({ credits_charged: 1.4, ...over }) }));
        expect(stopped({ stopped_by: "stopped" })).toBe("Stopped after 7 of 12 items · 2 couldn't be read");
        expect(stopped({ stopped_by: "insufficient_credits", failed_row_ids: ["a"] })).toBe(
            "Out of credits after 7 of 12 items · 1 couldn't be read",
        );
        expect(stopped({ stopped_by: "read_only" })).toBe(
            "The fill stopped after 7 of 12 items because the library became read-only; 2 couldn't be read",
        );
    });

    it("names the papers a stopped fill answered but could not save", () => {
        expect(resultText(job({ state: "done", rows_done: 3, rows_total: 3, result: result({ failed_row_ids: [], stopped_by: "read_only", not_written: 1 }) }))).toBe(
            "The fill stopped after 3 of 3 items because the library became read-only; 1 item could not be saved",
        );
        expect(resultText(job({ state: "done", rows_done: 30, result: result({ failed_row_ids: [], stopped_by: "stopped", credits_charged: 6, not_written: 2 }) }))).toBe(
            "Stopped after 30 of 46 items; 2 items could not be saved",
        );
    });

    it("says what a running fill is doing now, with an estimate only for a long one", () => {
        expect(progressLine(job({ rows_done: 0, seconds_left: null }))).toEqual({ status: "Starting to read 46 items", failed: null });
        expect(progressLine(job({ rows_done: 5, rows_total: 12, seconds_left: 45 }))).toEqual({ status: "Reading 5 of 12 items", failed: null });
        expect(progressLine(job({ rows_done: 5, rows_total: 12, seconds_left: 119 })).status).toBe("Reading 5 of 12 items");
        expect(progressLine(job({ rows_done: 8, rows_total: 40, seconds_left: 240 })).status).toBe(
            "Reading 8 of 40 items · about 4 minutes left",
        );
        expect(progressLine(job({ rows_done: 5, rows_total: 12, rows_failed: 1, seconds_left: 30 }))).toEqual({
            status: "Reading 5 of 12 items",
            failed: "1 failed",
        });
    });

    it("says a stopping fill is finishing the papers already underway", () => {
        expect(progressLine(job({ state: "stopping", in_flight: 3 })).status).toBe("Stopping: finishing 3 items already underway");
        expect(progressLine(job({ state: "stopping", in_flight: 1 })).status).toBe("Stopping: finishing 1 item already underway");
        expect(progressLine(job({ state: "stopping", in_flight: 0 })).status).toBe("Stopping");
    });

    it("tells a clean result from one the user stopped and one with something to act on", () => {
        const done = (over: Partial<TableFillResult>) => job({ state: "done", result: result(over) });
        expect(resultTone(done({ failed_row_ids: [] }))).toBe("clean");
        expect(resultTone(done({ failed_row_ids: [], skipped_cells: { column_changed: 2 } }))).toBe("clean");
        expect(resultTone(done({ failed_row_ids: [], stopped_by: "stopped" }))).toBe("stopped");
        expect(resultTone(done({}))).toBe("warning");
        expect(resultTone(done({ failed_row_ids: [], not_written: 1 }))).toBe("warning");
        expect(resultTone(done({ failed_row_ids: [], stopped_by: "insufficient_credits" }))).toBe("warning");
        expect(failedRowsLink(1)).toBe("Show 1 failed");
        expect(failedRowsLink(2)).toBe("Show 2 failed");
    });

    it("sums up a finished fill in a few words, without its cost or its failures", () => {
        const done = (over: Partial<TableFillResult>, at: Partial<TableFillJobSnapshot> = {}) =>
            resultSummary(job({ state: "done", rows_done: 7, rows_total: 12, ...at, result: result(over) }));
        expect(done({ rows_answered: 12, failed_row_ids: [] })).toBe("Filled 12 rows");
        expect(done({ rows_answered: 10 })).toBe("Filled 10 rows");
        expect(done({ stopped_by: "stopped" })).toBe("Stopped after 7 of 12 items");
        expect(done({ stopped_by: "insufficient_credits" })).toBe("Out of credits after 7 of 12 items");
        expect(done({ stopped_by: "read_only" })).toBe("The fill stopped after 7 of 12 items because the library became read-only");
        expect(done({ rows_answered: 10, not_written: 1 })).toBe("Filled 10 rows · 1 item not saved");
    });
});

describe("resultNeedsAttention", () => {
    const clean = result({ row_failures: {}, failed_row_ids: [] });
    const done = (over: Partial<TableFillResult> = {}) => job({ state: "done", result: { ...clean, ...over } });

    it("is false for a clean result, which reads as the rows filled", () => {
        expect(resultNeedsAttention(done())).toBe(false);
        expect(resultText(done())).toBe("Filled 44 rows");
    });

    it("is true without a result", () => {
        expect(resultNeedsAttention(job({ state: "done" }))).toBe(true);
    });

    it("is true for a fill that stopped, by the user or for any other reason", () => {
        expect(resultNeedsAttention(done({ stopped_by: "stopped" }))).toBe(true);
        expect(resultNeedsAttention(done({ stopped_by: "insufficient_credits" }))).toBe(true);
        expect(resultNeedsAttention(done({ stopped_by: "unavailable" }))).toBe(true);
    });

    it("is false for a stop reason the result line does not name", () => {
        // `changed` is not a stop the result line reports, so the line reads clean.
        expect(resultText(done({ stopped_by: "changed" }))).toBe("Filled 44 rows");
        expect(resultNeedsAttention(done({ stopped_by: "changed" }))).toBe(false);
    });

    it("is true when rows could not be read", () => {
        expect(resultNeedsAttention(done({ failed_row_ids: ["a"] }))).toBe(true);
    });

    it("is true when papers could not be saved", () => {
        expect(resultNeedsAttention(done({ not_written: 1 }))).toBe(true);
    });

    it("is true when answers were left for the next fill, and false for an empty count", () => {
        expect(resultNeedsAttention(done({ skipped_cells: { column_changed: 2 } }))).toBe(true);
        expect(resultNeedsAttention(done({ skipped_cells: { column_changed: 0 } }))).toBe(false);
    });
});
