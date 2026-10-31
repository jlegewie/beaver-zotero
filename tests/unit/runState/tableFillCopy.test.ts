import { describe, expect, it } from "vitest";
import type { PendingWork } from "@beaver/agent-core/layouts/tableFill";
import type { TableFillJobSnapshot, TableFillPlanSummary, TableFillResult } from "@beaver/agent-core/protocol/tableFillProtocol";
import {
    balanceLine,
    creditsText,
    fillButtonLabel,
    fillButtonRows,
    formatCredits,
    pendingLines,
    planCostLine,
    planRowLine,
    pricingSentence,
    resultText,
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
            "Filling costs 0.2 credits per paper, charged as each paper is filled. Papers that can't be read are free.",
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
        expect(planCostLine(plan({ credits: 9.2 }))).toBe("Fill 46 papers · 9.2 credits");
        expect(planRowLine(plan())).toBe("Reads 46 papers: 43 from the PDF, 3 from title and abstract");
        expect(planRowLine(plan({ document_kinds: { pdf: 40, epub: 3 }, no_input: 1, unavailable: 1, rows: 48 }))).toBe(
            "Reads 46 papers: 43 from their documents, 3 from title and abstract. 2 papers can't be read and are skipped",
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
        ).toEqual(["3 new papers", "Not yet answered: Sample", "Changed column: Method"]);
        // Unreadable rows are skipped, not filled.
        expect(planCostLine(plan({ rows: 4, documents: 2, title_abstract: 1, unavailable: 1, credits: 0.45 }))).toBe("Fill 3 papers · 0.45 credits");
        expect(pendingLines(plan({ scope: { kind: "retry_failed" }, rows: 2 }))).toEqual(["Retry 2 papers that failed last time"]);
        expect(balanceLine(plan({ credits: 9.2, balance: 6, documents: 46, title_abstract: 0 }))).toBe("Your 6 credits cover about 30 of 46 papers");
        expect(balanceLine(plan())).toBeNull();
        expect(planCostLine(plan({ rows: 5, documents: 5, title_abstract: 0, credits: 1 }))).toBe("Fill 5 papers · 1 credit");
        expect(balanceLine(plan({ credits: 9.2, balance: 1, documents: 46, title_abstract: 0 }))).toBe("Your 1 credit covers about 5 of 46 papers");
        expect(balanceLine(plan({ balance: null }))).toBeNull();
    });

    it("shows a running fill and its stop", () => {
        expect(runningLabel(job())).toBe("Stop · 12/46");
        expect(runningLabel(job({ state: "stopping" }))).toBe("Stopping… finishing 3 papers");
        expect(timeLeftText(300)).toBe("About 5 minutes left");
        expect(timeLeftText(20)).toBe("Less than a minute left");
        expect(timeLeftText(null)).toBeNull();
    });

    it("sums up a finished fill", () => {
        expect(resultText(job({ state: "done", result: result() }))).toBe("Filled 44 rows · 2 couldn't be read · 8.8 credits");
        expect(resultText(job({ state: "done", rows_done: 30, result: result({ stopped_by: "insufficient_credits", credits_charged: 6 }) }))).toBe(
            "Out of credits after 30 of 46 papers · 6 credits",
        );
        expect(resultText(job({ state: "done", rows_done: 30, result: result({ stopped_by: "stopped", credits_charged: 6 }) }))).toBe(
            "Stopped after 30 of 46 papers · 6 credits",
        );
        expect(resultText(job({ state: "done", result: result({ stopped_by: "price_changed" }) }))).toBe(
            "Prices changed; fill again to see the new cost",
        );
        expect(resultText(job({ state: "done", result: result({ failed_row_ids: [], skipped_cells: { column_changed: 2 } }) }))).toBe(
            "Filled 44 rows · 2 answers left for the next fill · 8.8 credits",
        );
        expect(resultText(job({ state: "done", result: result({ failed_row_ids: [], not_written: 1 }) }))).toBe(
            "Filled 44 rows · 1 paper could not be saved · 8.8 credits",
        );
    });
});
