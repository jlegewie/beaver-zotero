import { describe, expect, it, vi } from "vitest";
import type { PendingWork } from "@beaver/agent-core/layouts/tableFill";
import type { TableFillJobSnapshot, TableFillPlanSummary, TableFillResult } from "@beaver/agent-core/protocol/tableFillProtocol";
import {
    affordableRowsBound,
    balanceShortfall,
    columnFillCostText,
    fillPartLabel,
    trialWithinBalance,
    creditsActionLabel,
    creditsText,
    failedRowsLink,
    fillButtonLabel,
    fillButtonRows,
    formatCredits,
    hasNoCredits,
    noCreditsText,
    pendingLines,
    planSourcesLine,
    planTitle,
    planRowLine,
    pricingSentence,
    progressLine,
    resultSummary,
    resultNeedsAttention,
    readsAsStopped,
    refillNotice,
    resultText,
    resultTone,
    runningLabel,
    showsRefillNotice,
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
        expect(planTitle(plan())).toBe("Fill 46 items");
        expect(planSourcesLine(plan())).toBe("43 from PDF · 3 from title and abstract");
        expect(planSourcesLine(plan({ document_kinds: { pdf: 40, epub: 3 }, no_input: 1, unavailable: 1 }))).toBe(
            "43 from full text · 3 from title and abstract · 2 can't be read",
        );
        expect(planSourcesLine(plan({ documents: 0, title_abstract: 0 }))).toBeNull();
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
        ).toEqual([
            { label: "New items", value: "3" },
            { label: "New column", value: "Sample" },
            { label: "Changed", value: "Method" },
        ]);
        // A table never filled: every row is new, and the heading already says so.
        expect(pendingLines(plan({ pending: pending({ rows: 13, new_rows: 13 }) }))).toEqual([]);
        // A column that already has answers names its empty cells instead.
        expect(
            pendingLines(
                plan({ pending: pending({ rows: 2, columns: [{ id: "n", header: "Sample", reason: "new", cells: 2 }] }) }),
                new Set(["n"]),
            ),
        ).toEqual([{ label: "Empty cells", value: "Sample" }]);
        // Unreadable rows are skipped, not filled.
        expect(planTitle(plan({ rows: 4, documents: 2, title_abstract: 1, unavailable: 1 }))).toBe("Fill 3 items");
        expect(pendingLines(plan({ scope: { kind: "retry_failed" }, rows: 2 }))).toEqual([{ value: "Retry 2 items that failed last time" }]);
        expect(planTitle(plan({ rows: 5, documents: 5, title_abstract: 0 }))).toBe("Fill 5 items");
    });

    it("bounds the rows a balance surely pays for by the dearest price the fill pays", () => {
        const fill = { rows: 46, documents: 46, title_abstract: 0, credits: 9.2 };
        const prices = { document: 0.2, title_abstract: 0.05 };
        expect(affordableRowsBound(fill, prices, 6)).toBe(30);
        expect(affordableRowsBound(fill, prices, 9.2)).toBeNull();
        expect(affordableRowsBound(fill, prices, null)).toBeNull();
        expect(affordableRowsBound(fill, prices, 0.1)).toBe(0);
        // Mixed: every row priced as a document, so the bound never runs out.
        const mixed = { rows: 10, documents: 5, title_abstract: 5, credits: 1.25 };
        expect(affordableRowsBound(mixed, prices, 1)).toBe(5);
        // Abstracts only: their own price.
        expect(affordableRowsBound({ rows: 10, documents: 0, title_abstract: 10, credits: 0.5 }, prices, 0.3)).toBe(6);
        // Without the prices, the credits spread over the documents stand in: never below a row's price.
        expect(affordableRowsBound(fill, null, 6)).toBe(30);
        expect(affordableRowsBound(mixed, null, 1)).toBe(4);
    });

    it("warns of a balance short of the fill, naming the part it covers where the surface can fill only that", () => {
        const fill = { rows: 46, documents: 46, title_abstract: 0, credits: 9.2 };
        const prices = { document: 0.2, title_abstract: 0.05 };
        expect(balanceShortfall(fill, prices, 6, { partial: true })).toEqual({
            text: "Your 6 credits cover 30 of 46 items. The rest can be filled once you add credits.",
            blocked: false,
            affordable: 30,
            part: { rows: 30, items: 30, of: 46, credits: 6 },
        });
        expect(balanceShortfall(fill, prices, 1, { partial: true })!.text).toBe(
            "Your 1 credit covers 5 of 46 items. The rest can be filled once you add credits.",
        );
        // A surface that can only fill everything: the fill stops partway.
        expect(balanceShortfall(fill, prices, 6)).toEqual({
            text: "This fill needs 9.2 credits and you have 6. It stops when your credits run out.",
            blocked: false,
            affordable: 30,
            part: null,
        });
        expect(balanceShortfall(fill, prices, 9.2)).toBeNull();
        expect(balanceShortfall(fill, prices, null)).toBeNull();
        // Items the fill reads: an unreadable row is not one of them.
        expect(balanceShortfall({ ...fill, rows: 47 }, prices, 6, { partial: true })!.part).toEqual({
            rows: 30,
            items: 30,
            of: 46,
            credits: 6,
        });
        // A plan's exact part wins over the bound, asked for only once the balance falls short.
        const exactPart = vi.fn(() => ({ rows: 32, items: 31, credits: 5.95 }));
        expect(balanceShortfall(fill, prices, 6, { partial: true, exactPart })!.part).toEqual({
            rows: 32,
            items: 31,
            of: 46,
            credits: 5.95,
        });
        balanceShortfall(fill, prices, 10, { exactPart: () => { throw new Error("not asked"); } });
        expect(balanceShortfall(fill, prices, 6, { partial: true, exactPart: () => null })!.part!.rows).toBe(30);
        // Not one item: blocked, with the no-credits text.
        expect(balanceShortfall(fill, prices, 0.1, { partial: true })).toEqual({
            text: "Filling uses Beaver credits: 0.2 per item. You have 0.1 credits.",
            blocked: true,
            affordable: null,
            part: null,
        });
        // Enough for a cheap row but not the first at the dearer price: no part to offer.
        const mixed = { rows: 2, documents: 1, title_abstract: 1, credits: 0.25 };
        expect(balanceShortfall(mixed, prices, 0.1, { partial: true })).toEqual({
            text: "This fill needs 0.25 credits and you have 0.1. It stops when your credits run out.",
            blocked: false,
            affordable: 0,
            part: null,
        });
        // Prices still loading: a mixed fill may still pay for an abstract, so it is not blocked.
        expect(balanceShortfall(mixed, null, 0.1)!.blocked).toBe(false);
        // A single kind is priced exactly by its credits: blocked as with the prices.
        expect(balanceShortfall(fill, null, 0.1)!.blocked).toBe(true);
        // Running fills hold part of the account's balance: the warning says how much, at most.
        expect(
            balanceShortfall({ rows: 3, documents: 2, title_abstract: 1, credits: 0.45 }, prices, 0.3, {
                accountBalance: 5,
                partial: true,
            })!.text,
        ).toBe(
            "Fills already running may use up to 4.7 of your 5 credits; the rest covers 1 of 3 items. The rest can be filled once you add credits.",
        );
        expect(fillPartLabel({ rows: 1300, items: 1234, of: 2000, credits: 1 })).toBe("Fill 1,234 of 2,000");
    });

    it("offers a trial only where the balance can finish it", () => {
        const short = (affordable: number | null, blocked = false, part = true) => ({
            text: "",
            blocked,
            affordable,
            part: part && affordable ? { rows: affordable, items: affordable, of: 46, credits: 1 } : null,
        });
        expect(trialWithinBalance(5, null)).toBe(5);
        expect(trialWithinBalance(5, short(6))).toBe(5);
        expect(trialWithinBalance(5, short(5))).toBeNull();
        expect(trialWithinBalance(5, short(null))).toBe(5);
        expect(trialWithinBalance(5, short(null, true))).toBeNull();
        expect(trialWithinBalance(null, null)).toBeNull();
        // Exactly the trial, with no partial fill offered instead: the trial stays.
        expect(trialWithinBalance(5, short(5, false, false))).toBe(5);
        // Not even the first row: no trial.
        expect(trialWithinBalance(5, short(0, false, false))).toBeNull();
    });

    it("prices a column the editor adds or asks anew at most at the document price", () => {
        const prices = { document: 0.35, title_abstract: 0.1 };
        expect(columnFillCostText(200, prices, true)).toBe(
            "Filling this column reads 200 items again: up to 70 credits. Add your other columns first; one fill answers them all.",
        );
        expect(columnFillCostText(1, prices, false)).toBe(
            "Filling this column reads 1 item: up to 0.35 credits. Add your other columns first; one fill answers them all.",
        );
        expect(columnFillCostText(0, prices, true)).toBeNull();
        expect(columnFillCostText(10, null, true)).toBeNull();
    });

    it("says why a plan cannot start only when the balance cannot pay for one item", () => {
        // The cheapest item the plan pays for sets the bar: 0.05 for title and abstract.
        expect(noCreditsText(plan(), 0)).toBe("Filling uses Beaver credits: 0.2 per item. You have 0 credits.");
        expect(noCreditsText(plan(), 0.04)).not.toBeNull();
        // Short because running fills hold the account's credits: says how much, at most, and that waiting helps.
        expect(noCreditsText(plan(), 0, 1)).toBe(
            "Filling uses Beaver credits: 0.2 per item. Fills already running may use up to 1 of your 1 credit. Wait for them to finish or add credits.",
        );
        expect(noCreditsText(plan(), 0.02, 2.02)).toBe(
            "Filling uses Beaver credits: 0.2 per item. Fills already running may use up to 2 of your 2.02 credits. Wait for them to finish or add credits.",
        );
        // A hold below the display precision is rounding residue, not a running fill.
        expect(noCreditsText(plan(), 0.01, 0.012)).toBe("Filling uses Beaver credits: 0.2 per item. You have 0.01 credits.");
        expect(noCreditsText(plan(), 0.05)).toBeNull();
        // Only documents: one costs 0.2.
        expect(noCreditsText(plan({ title_abstract: 0 }), 0.1)).toBe(
            "Filling uses Beaver credits: 0.2 per item. You have 0.1 credits.",
        );
        expect(noCreditsText(plan({ title_abstract: 0 }), 0.2)).toBeNull();
        // Only title and abstract: priced at theirs.
        expect(noCreditsText(plan({ documents: 0, title_abstract: 3, credits: 0.15 }), 0.01)).toBe(
            "Filling uses Beaver credits: 0.05 per item. You have 0.01 credits.",
        );
        // Unknown balance, or a plan that costs nothing: never blocked here.
        expect(noCreditsText(plan(), null)).toBeNull();
        expect(noCreditsText(plan({ credits: 0, documents: 0, title_abstract: 0, no_input: 46 }), 0)).toBeNull();
    });

    it("offers to get credits with none to spend and to add credits to a balance", () => {
        expect(hasNoCredits(0)).toBe(true);
        expect(hasNoCredits(0.001)).toBe(true);
        expect(hasNoCredits(0.01)).toBe(false);
        expect(hasNoCredits(null)).toBe(false);
        expect(creditsActionLabel(0)).toBe("Get credits");
        expect(creditsActionLabel(null)).toBe("Get credits");
        expect(creditsActionLabel(0.1)).toBe("Add credits");
        expect(creditsActionLabel(6)).toBe("Add credits");
    });

    it("shows a running fill and its stop", () => {
        expect(runningLabel(job())).toBe("Stop · 12/46");
        expect(runningLabel(job({ state: "stopping" }))).toBe("Stopping… finishing 3 items");
        expect(timeLeftText(300)).toBe("About 5 minutes left");
        expect(timeLeftText(20)).toBe("Less than a minute left");
        expect(timeLeftText(null)).toBeNull();
    });

    it("sums up a finished fill", () => {
        expect(resultText(job({ state: "done", result: result() }))).toBe("Filled 44 of 46 items · 2 couldn't be read");
        expect(resultText(job({ state: "done", result: result({ rows_answered: 46, row_failures: {}, failed_row_ids: [] }) }))).toBe("Filled 46 items");
        expect(resultText(job({ state: "done", rows_done: 30, result: result({ rows_answered: 30, failed_row_ids: [], stopped_by: "insufficient_credits", not_started: { insufficient_credits: 16 }, credits_charged: 6 }) }))).toBe(
            "Out of credits after 30 of 46 items · the rest stay pending",
        );
        expect(resultText(job({ state: "done", rows_done: 30, result: result({ rows_answered: 30, failed_row_ids: [], stopped_by: "stopped", not_started: { stopped: 16 }, credits_charged: 6 }) }))).toBe(
            "Stopped after 30 of 46 items",
        );
        expect(resultText(job({ state: "done", result: result({ failed_row_ids: [], stopped_by: "price_changed" }) }))).toBe(
            "Prices changed; fill again to see the new cost",
        );
        expect(resultText(job({ state: "done", result: result({ failed_row_ids: [], skipped_cells: { column_changed: 2 } }) }))).toBe(
            "Filled 44 of 46 items · 2 answers left for the next fill",
        );
        expect(resultText(job({ state: "done", result: result({ failed_row_ids: [], not_written: 1 }) }))).toBe(
            "Filled 44 of 46 items · 1 item could not be saved",
        );
    });

    it("says why a fill stopped: the server, an excluded library, a read-only library, a missing table", () => {
        const stopped = (stopped_by: TableFillResult["stopped_by"]) =>
            resultText(job({ state: "done", rows_done: 2, rows_total: 3, result: result({ rows_answered: 2, failed_row_ids: [], stopped_by }) }));
        expect(stopped("unavailable")).toBe("The fill stopped: Beaver could not reach its server after 2 of 3 items");
        expect(stopped("library_excluded")).toBe("The fill stopped after 2 of 3 items because a library was excluded from Beaver");
        expect(stopped("read_only")).toBe("The fill stopped after 2 of 3 items because the library became read-only");
        expect(stopped("table_unavailable")).toBe("The fill stopped after 2 of 3 items because the table is no longer available");
    });

    it("names the rows a stopped fill could not read, counting the items it filled", () => {
        const stopped = (over: Partial<TableFillResult>) =>
            resultText(job({ state: "done", rows_done: 9, rows_total: 12, result: result({ rows_answered: 7, credits_charged: 1.4, ...over }) }));
        expect(stopped({ stopped_by: "stopped", not_started: { stopped: 3 } })).toBe("Stopped after 7 of 12 items · 2 couldn't be read");
        expect(stopped({ stopped_by: "insufficient_credits", failed_row_ids: ["a"] })).toBe(
            "Out of credits after 7 of 12 items · 1 couldn't be read · the rest stay pending",
        );
        expect(stopped({ stopped_by: "read_only" })).toBe(
            "The fill stopped after 7 of 12 items because the library became read-only; 2 couldn't be read",
        );
    });

    it("names the papers a stopped fill answered but could not save", () => {
        expect(resultText(job({ state: "done", rows_done: 3, rows_total: 3, result: result({ rows_answered: 3, failed_row_ids: [], stopped_by: "read_only", not_written: 1 }) }))).toBe(
            "The fill stopped after 3 of 3 items because the library became read-only; 1 item could not be saved",
        );
        expect(resultText(job({ state: "done", rows_done: 30, result: result({ rows_answered: 30, failed_row_ids: [], stopped_by: "stopped", not_started: { stopped: 16 }, credits_charged: 6, not_written: 2 }) }))).toBe(
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
        expect(resultTone(done({ failed_row_ids: [], stopped_by: "stopped", not_started: { stopped: 2 } }))).toBe("stopped");
        // A Stop that came once every item had started left nothing undone.
        expect(resultTone(done({ failed_row_ids: [], stopped_by: "stopped" }))).toBe("clean");
        expect(resultTone(done({}))).toBe("warning");
        expect(resultTone(done({ failed_row_ids: [], not_written: 1 }))).toBe("warning");
        expect(resultTone(done({ failed_row_ids: [], stopped_by: "insufficient_credits" }))).toBe("warning");
        expect(failedRowsLink(1)).toBe("Show 1 failed");
        expect(failedRowsLink(2)).toBe("Show 2 failed");
    });

    it("sums up a finished fill in a few words, without its cost or its failures", () => {
        const done = (over: Partial<TableFillResult>, at: Partial<TableFillJobSnapshot> = {}) =>
            resultSummary(job({ state: "done", rows_done: 7, rows_total: 12, ...at, result: result(over) }));
        expect(done({ rows_answered: 12, failed_row_ids: [] })).toBe("Filled 12 items");
        expect(done({ rows_answered: 10 })).toBe("Filled 10 of 12 items");
        expect(done({ rows_answered: 7, stopped_by: "stopped", not_started: { stopped: 5 } })).toBe("Stopped after 7 of 12 items");
        expect(done({ rows_answered: 7, stopped_by: "insufficient_credits" })).toBe("Out of credits after 7 of 12 items");
        expect(done({ rows_answered: 7, stopped_by: "read_only" })).toBe("The fill stopped after 7 of 12 items because the library became read-only");
        expect(done({ rows_answered: 10, not_written: 1 })).toBe("Filled 10 of 12 items · 1 item not saved");
    });
});

describe("resultNeedsAttention", () => {
    const clean = result({ row_failures: {}, failed_row_ids: [] });
    const done = (over: Partial<TableFillResult> = {}) => job({ state: "done", result: { ...clean, ...over } });

    it("is false for a clean result, which reads as the items filled", () => {
        expect(resultNeedsAttention(done())).toBe(false);
        expect(resultText(done())).toBe("Filled 44 of 46 items");
    });

    it("is true without a result", () => {
        expect(resultNeedsAttention(job({ state: "done" }))).toBe(true);
    });

    it("is true for a fill that stopped, by the user or for any other reason", () => {
        expect(resultNeedsAttention(done({ stopped_by: "stopped", not_started: { stopped: 2 } }))).toBe(true);
        expect(resultNeedsAttention(done({ stopped_by: "insufficient_credits" }))).toBe(true);
        expect(resultNeedsAttention(done({ stopped_by: "unavailable" }))).toBe(true);
    });

    it("reads a stop as one only when items were left unstarted, for a result and for a record", () => {
        expect(readsAsStopped("stopped", { stopped: 3 })).toBe(true);
        expect(readsAsStopped("stopped", {})).toBe(false);
        expect(readsAsStopped("stopped", null)).toBe(false);
        expect(readsAsStopped("insufficient_credits", {})).toBe(true);
        expect(readsAsStopped(null, { stopped: 3 })).toBe(false);
    });

    it("is false for a Stop that came once every item had started", () => {
        // Nothing was left unstarted: the fill reads as finished, by the items it filled.
        expect(resultText(done({ stopped_by: "stopped" }))).toBe("Filled 44 of 46 items");
        expect(resultNeedsAttention(done({ stopped_by: "stopped" }))).toBe(false);
        expect(resultText(job({ state: "done", rows_done: 60, rows_total: 60, result: result({ rows_answered: 55, failed_row_ids: ["a", "b", "c", "d", "e"], stopped_by: "stopped" }) }))).toBe(
            "Filled 55 of 60 items · 5 couldn't be read",
        );
    });

    it("is false for a stop reason the result line does not name", () => {
        // `changed` is not a stop the result line reports, so the line reads clean.
        expect(resultText(done({ stopped_by: "changed" }))).toBe("Filled 44 of 46 items");
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

describe("the refill alert", () => {
    it("says a changed column costs a whole fill, and points to the trial when one is offered", () => {
        expect(refillNotice(5)).toBe(
            "Each paper is read again, so filling one column costs as much as filling all of them. Finish your column changes first, then try 5 rows to check the answers.",
        );
        expect(refillNotice(null)).toBe(
            "Each paper is read again, so filling one column costs as much as filling all of them. Finish your column changes first.",
        );
    });

    it("shows for a plan that reads answered rows again, never on a retry or a trial", () => {
        expect(showsRefillNotice({ scope: { kind: "pending" }, rereads: 26 })).toBe(true);
        expect(showsRefillNotice({ scope: { kind: "cells", columns: ["c1"] }, rereads: 26 })).toBe(true);
        expect(showsRefillNotice({ scope: { kind: "pending" }, rereads: 0 })).toBe(false);
        expect(showsRefillNotice({ scope: { kind: "retry_failed" }, rereads: 3 })).toBe(false);
        expect(showsRefillNotice({ scope: { kind: "pending", limit: 5 }, rereads: 5 })).toBe(false);
    });
});
