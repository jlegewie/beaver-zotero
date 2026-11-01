import { describe, expect, it } from "vitest";
import contract from "../../fixtures/artifacts/provider-contract.json";
import { tableChangeLines } from "@beaver/agent-core/run-state/tableEditCopy";

describe("the change list of an edit", () => {
    it("colours additions, changes and removals and counts the cells they touch", () => {
        const columns = (contract as any[]).find((c) => c.name === "apply-edit-columns").response.changes;
        expect(tableChangeLines(columns)).toEqual([
            { tone: "remove", text: "Removed column “Open access” · 2 answers, 1 of them yours" },
            { tone: "change", text: "Changed column “Design” (question, options) · 2 answers out of date · 1 answer relabelled · 1 answer cleared" },
            { tone: "add", text: "Added column “Country”" },
        ]);
    });
    it("names sources by kind and name, and refreshes by what they added and left out", () => {
        const sources = (contract as any[]).find((c) => c.name === "apply-edit-sources").response.changes;
        expect(tableChangeLines(sources)).toEqual([
            { tone: "remove", text: "Removed collection “Cash transfers” · 2 rows" },
            { tone: "add", text: "Added 2 papers · 1 restored" },
            { tone: "add", text: "Added tag “cash” · 0 new papers · 2 already in the table" },
        ]);
        const refresh = (contract as any[]).find((c) => c.name === "apply-edit-refresh").response.changes;
        expect(tableChangeLines(refresh)).toEqual([
            { tone: "add", text: "Refreshed collection “Cash transfers” · 1 new paper · 1 removed paper left out · 1 no longer in it, kept" },
        ]);
    });
    it("names the user's answers a removed option cleared", () => {
        const change = { op: "update_column", column: "design", header: "Design", fields: ["options"], stale: 0, cleared: 2, user_cleared: 1, relabelled: 0 } as const;
        expect(tableChangeLines([change])).toEqual([
            { tone: "change", text: "Changed column “Design” (options) · 2 answers cleared, 1 of them yours" },
        ]);
        expect(tableChangeLines([{ ...change, cleared: 1 }, { ...change, user_cleared: 2 }]).map((line) => line.text)).toEqual([
            "Changed column “Design” (options) · 1 answer cleared, yours",
            "Changed column “Design” (options) · 2 answers cleared, all yours",
        ]);
    });
    it("reads title, description and row removals", () => {
        expect(tableChangeLines([{ op: "title", title: "X" }, { op: "description" }, { op: "remove_rows", rows: 1 }])).toEqual([
            { tone: "change", text: "Renamed the table to “X”" },
            { tone: "change", text: "Rewrote the description" },
            { tone: "remove", text: "Removed 1 row" },
        ]);
    });
});
