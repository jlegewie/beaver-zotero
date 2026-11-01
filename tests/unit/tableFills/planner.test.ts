/**
 * Fill planning without Zotero: the document rule, which rows are looked up,
 * and the plan built in the backend planner's order.
 */
import { describe, expect, it } from "vitest";
import type { Cell, Row, TableSpec } from "@beaver/agent-core/layouts/table";
import { questionHash } from "@beaver/agent-core/layouts/table";
import {
    bestDocument,
    buildPlan,
    documentChanges,
    readFailureCode,
    rowReference,
    rowsToLookUp,
    type RowLookup,
} from "../../../src/services/tableFills/planner";

const fromAbstract = (text: string): Cell => ({ outcome: "answered", provenance: "model", value: { kind: "text", text } });
const fromDocument = (text: string, document: string): Cell => ({
    outcome: "answered",
    provenance: "model",
    value: { kind: "text", text },
    documents: [document],
});

function itemRow(id: string, extra: Partial<Row> = {}): Row {
    return {
        id,
        ref: { kind: "item", library_ref: "u", zotero_key: id.toUpperCase().padEnd(8, "X") },
        ...extra,
        cells: {
            _reference: {
                outcome: "answered",
                provenance: "system",
                value: { kind: "reference", display_name: `${id} 2020`, title: `Title ${id}`, subtitle: "Ames and Bo", venue: "J", item_type: "journalArticle" },
            },
            _year: { outcome: "answered", provenance: "system", value: { kind: "date", value: "2020-05" } },
            ...(extra.cells ?? {}),
        },
    };
}

function table(rows: Row[]): TableSpec {
    return {
        id: "t",
        title: "Trials",
        columns: [
            { id: "_reference", header: "Reference", type: "reference", system: true },
            { id: "_year", header: "Year", type: "date", system: true },
            { id: "method", header: "Method", type: "text", description: "What method?" },
            { id: "n", header: "Sample", type: "text", description: "How many?", revision: 2 },
        ],
        rows,
    };
}

const lookup = (documents: RowLookup["documents"], abstract = "An abstract."): RowLookup => ({ documents, abstract });

describe("bestDocument", () => {
    it("prefers the primary attachment, then a PDF over an EPUB over a snapshot", () => {
        expect(bestDocument([])).toBeUndefined();
        expect(
            bestDocument([
                { id: "u-SNAP", kind: "snapshot", primary: false },
                { id: "u-EPUB", kind: "epub", primary: false },
                { id: "u-PDF", kind: "pdf", primary: false },
            ]),
        ).toBe("u-PDF");
        expect(
            bestDocument([
                { id: "u-PDF", kind: "pdf", primary: false },
                { id: "u-EPUB", kind: "epub", primary: true },
            ]),
        ).toBe("u-EPUB");
        expect(
            bestDocument([
                { id: "u-PDF1", kind: "pdf", primary: false },
                { id: "u-PDF2", kind: "pdf", primary: false },
            ]),
        ).toBe("u-PDF1");
    });
});

describe("rowsToLookUp", () => {
    it("looks up selected item rows, rows with a failure and title-and-abstract rows without a document", () => {
        const spec = table([
            itemRow("sel"),
            itemRow("done", { documents: ["u-D"], cells: { method: fromDocument("x", "u-D"), n: fromDocument("1", "u-D") } }),
            itemRow("ta", { cells: { method: fromAbstract("x"), n: fromAbstract("1") } }),
            itemRow("blocked", { documents: ["u-B"], failure: { code: "encrypted", message: "x" } }),
        ]);
        const columns = spec.columns.filter((c) => !c.system);
        expect(rowsToLookUp(spec, {}, columns).map((row) => row.id)).toEqual(["sel", "ta", "blocked"]);
        expect(rowsToLookUp(spec, { rows: ["done"] }, columns).map((row) => row.id)).toEqual(["done"]);
    });
});

describe("documentChanges", () => {
    it("gives a row without a document one, and switches only a document that is gone", () => {
        const rows = [
            itemRow("none"),
            itemRow("kept", { documents: ["u-OLD"] }),
            itemRow("gone", { documents: ["u-GONE"] }),
            itemRow("nothing", { documents: ["u-GONE2"] }),
        ];
        const lookups = new Map<string, RowLookup>([
            ["none", lookup([{ id: "u-P", kind: "pdf", primary: false }])],
            ["kept", lookup([{ id: "u-OLD", kind: "epub", primary: false }, { id: "u-NEW", kind: "pdf", primary: true }])],
            ["gone", lookup([{ id: "u-R", kind: "pdf", primary: false }])],
            ["nothing", lookup([])],
        ]);
        expect(Object.fromEntries(documentChanges(rows, lookups))).toEqual({ none: ["u-P"], gone: ["u-R"] });
    });
});

describe("buildPlan", () => {
    it("selects a fully answered title-and-abstract row that gained a PDF, read from it", () => {
        const spec = table([itemRow("ta", { cells: { method: fromAbstract("Survey"), n: fromAbstract("12") } })]);
        const plan = buildPlan(spec, {}, new Map([["ta", lookup([{ id: "u-PDF", kind: "pdf", primary: true }])]]));
        expect(plan.documentUpdates).toEqual([{ row: "ta", documents: ["u-PDF"], before: [] }]);
        expect(plan.rows).toHaveLength(1);
        expect(plan.rows[0]).toMatchObject({ row: "ta", mode: "document", columns: ["method", "n"], documents: ["u-PDF"], document: { id: "u-PDF", kind: "pdf" } });
    });

    it("unblocks a blocked row whose document was replaced", () => {
        const spec = table([itemRow("b", { documents: ["u-GONE"], failure: { code: "encrypted", message: "x" } })]);
        const plan = buildPlan(spec, {}, new Map([["b", lookup([{ id: "u-NEW", kind: "pdf", primary: false }])]]));
        expect(plan.rows.map((row) => [row.row, row.mode, row.documents])).toEqual([["b", "document", ["u-NEW"]]]);
        expect(plan.documentUpdates).toEqual([{ row: "b", documents: ["u-NEW"], before: ["u-GONE"] }]);
    });

    it("keeps a blocked row out when its document is unchanged", () => {
        const spec = table([itemRow("b", { documents: ["u-P"], failure: { code: "encrypted", message: "x" } })]);
        const plan = buildPlan(spec, {}, new Map([["b", lookup([{ id: "u-P", kind: "pdf", primary: false }])]]));
        expect(plan.rows).toEqual([]);
    });

    it("answers a row without a document from its abstract, and fails one with neither", () => {
        const spec = table([itemRow("a"), itemRow("none")]);
        const plan = buildPlan(
            spec,
            {},
            new Map([
                ["a", lookup([], "We study things.")],
                ["none", lookup([], "")],
            ]),
        );
        expect(plan.rows.map((row) => [row.row, row.mode, row.error])).toEqual([
            ["a", "metadata", undefined],
            ["none", "no_input", "no_source"],
        ]);
        expect(plan.rows[0].abstract).toBe("We study things.");
    });

    it("marks rows it cannot fill: a lookup error, a named document that is gone with no replacement", () => {
        const spec = table([itemRow("x"), itemRow("gone", { documents: ["u-G"] })]);
        const plan = buildPlan(
            spec,
            {},
            new Map([
                ["x", { error: "item_not_found", documents: [] }],
                ["gone", lookup([])],
            ]),
        );
        expect(plan.rows.map((row) => [row.row, row.mode, row.error])).toEqual([
            ["x", "unavailable", "item_not_found"],
            ["gone", "unavailable", "not_found"],
        ]);
    });

    it("records each column's revision and question hash as planned", () => {
        const spec = table([itemRow("a")]);
        const plan = buildPlan(spec, {}, new Map([["a", lookup([], "x")]]));
        const n = plan.columns.find((c) => c.request.id === "n")!;
        expect(n.revision).toBe(2);
        expect(n.request).toEqual({ id: "n", header: "Sample", type: "text", description: "How many?", question_hash: questionHash(spec.columns[3]) });
        expect(plan.cells).toBe(2);
    });

    it("never sends a row that names several documents: it gets a blocking failure", () => {
        const spec = table([itemRow("two", { documents: ["u-P1", "u-P2"] })]);
        const plan = buildPlan(spec, { rows: ["two"] }, new Map([["two", lookup([{ id: "u-P1", kind: "pdf", primary: true }, { id: "u-P2", kind: "pdf", primary: false }])]]));
        expect(plan.rows.map((row) => [row.row, row.mode, row.error, row.document])).toEqual([["two", "unavailable", "multiple_documents", undefined]]);
    });

    it("keeps every document of a row naming several, even when the first is gone", () => {
        const spec = table([itemRow("two", { documents: ["u-GONE", "u-P2"] })]);
        const plan = buildPlan(spec, { rows: ["two"] }, new Map([["two", lookup([{ id: "u-P2", kind: "pdf", primary: true }])]]));
        expect(plan.documentUpdates).toEqual([]);
        expect(plan.rows.map((row) => [row.mode, row.error, row.documents])).toEqual([["unavailable", "multiple_documents", ["u-GONE", "u-P2"]]]);
    });

    it("reads a plain-text attachment a row already names, but never picks one", () => {
        const text = { id: "u-TXT", kind: "text" as const, primary: true };
        expect(bestDocument([text])).toBeUndefined();
        const spec = table([itemRow("t", { documents: ["u-TXT"] })]);
        const plan = buildPlan(spec, {}, new Map([["t", lookup([text])]]));
        expect(plan.rows[0]).toMatchObject({ mode: "document", document: { id: "u-TXT", kind: "text" } });
        expect(plan.documentUpdates).toEqual([]);
    });

    it("reads the document a row names even when the row has no ref", () => {
        const bare: Row = { id: "bare", documents: ["u-PDF11111"], cells: {} };
        const plan = buildPlan(table([bare]), {}, new Map());
        expect(plan.rows[0]).toMatchObject({ mode: "document", document: { id: "u-PDF11111" }, documents: ["u-PDF11111"] });
        expect(plan.documentUpdates).toEqual([]);
    });

    it("reads the document an external row already names, not its abstract", () => {
        const external: Row = {
            id: "ext",
            ref: { kind: "external", source: "openalex", source_id: "W1", reference: { abstract: "An abstract." } as never },
            documents: ["u-PDF22222"],
            cells: {},
        };
        const plan = buildPlan(table([external]), {}, new Map());
        expect(plan.rows[0]).toMatchObject({ mode: "document", document: { id: "u-PDF22222" }, documents: ["u-PDF22222"] });
    });

    it("fills only the named rows and columns", () => {
        const spec = table([itemRow("a", { documents: ["u-A"], cells: { method: fromDocument("x", "u-A"), n: fromDocument("1", "u-A") } }), itemRow("b")]);
        const plan = buildPlan(spec, { rows: ["a"], columns: ["n"] }, new Map([["a", lookup([{ id: "u-A", kind: "pdf", primary: true }])]]));
        expect(plan.rows.map((row) => [row.row, row.columns])).toEqual([["a", ["n"]]]);
    });
});

describe("rowReference", () => {
    it("reads the reference and year columns", () => {
        expect(rowReference(itemRow("a"))).toEqual({ title: "Title a", authors: "Ames and Bo", venue: "J", item_type: "journalArticle", year: "2020" });
    });
});

describe("readFailureCode", () => {
    it("reads a missing text layer as a PDF's failure only", () => {
        expect(readFailureCode("no_text_layer", "pdf")).toBe("no_text_layer");
        expect(readFailureCode("no_text_layer", "epub")).toBe("no_text");
        expect(readFailureCode("encrypted", "pdf")).toBe("encrypted");
    });
});
