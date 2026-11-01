import { describe, expect, it } from "vitest";
import type { ExternalReference } from "@beaver/agent-core/types/externalReferences";
import {
    allocateRowId,
    anchorColumn,
    cellIdFor,
    cellInvariantError,
    cellSortKey,
    compareSortKeys,
    cellValueText,
    columnAlign,
    evidenceHeading,
    isUncitedAnswer,
    defaultHiddenColumnIds,
    filterRows,
    isCellEmpty,
    isColumnSortable,
    isExtractionColumn,
    isFillableColumn,
    isStale,
    isTitleAbstractOnly,
    needsReview,
    isRowInLibrary,
    normalizeSelectLabel,
    readSpec,
    rowActionTarget,
    rowActions,
    rowDecision,
    rowInvariantError,
    rowInScope,
    selectLabelsInColumn,
    sortRows,
    staleReason,
    stripCitationTags,
    summarizeCoverage,
    TABLE_SPEC_VERSION,
    toCsv,
    toPlainText,
    validateTableSpec,
    type Cell,
    type CellValue,
    type Column,
    type Row,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";

function row(id: string, cells: Row["cells"]): Row {
    return { id, cells };
}

/** An answered cell; the producer filled it unless told otherwise. */
function answered(
    value: CellValue,
    provenance: Cell["provenance"] = "system",
): Cell {
    return { outcome: "answered", provenance, value } as Cell;
}

const spec: TableSpec = {
    id: "t1",
    columns: [
        { id: "ref", header: "Reference", type: "reference" },
        { id: "year", header: "Year", type: "date" },
        { id: "cites", header: "Citations", type: "text" },
        {
            id: "type",
            header: "Type",
            type: "select",
            options: [{ label: "Article" }, { label: "Book" }],
        },
        { id: "oa", header: "Open access", type: "boolean" },
        { id: "methods", header: "Methods", type: "text" },
    ],
    rows: [
        row("a", {
            ref: answered(
                {
                    kind: "reference",
                    display_name: "Smith 2020",
                    subtitle: "Alpha",
                },
                "system",
            ),
            year: answered({ kind: "date", value: "2020" }, "system"),
            cites: answered({ kind: "text", text: "120" }),
            type: answered({ kind: "select", label: "Article" }),
            oa: answered({ kind: "boolean", value: true }),
            methods: answered({ kind: "text", text: "Survey, n = 1,200" }),
        }),
        row("b", {
            ref: answered(
                { kind: "reference", display_name: "Jones 2018" },
                "system",
            ),
            year: answered({ kind: "date", value: "2018-05" }, "system"),
            cites: answered({ kind: "text", text: "7" }),
            type: answered({ kind: "select", label: "Book" }),
            oa: answered({ kind: "boolean", value: false }),
        }),
        row("c", {
            ref: answered(
                { kind: "reference", display_name: "adams 2022" },
                "system",
            ),
            year: answered({ kind: "date", value: "2022-01-15" }, "system"),
            type: answered({ kind: "select", label: "Article" }),
            methods: answered({ kind: "text", text: "Interviews" }),
        }),
    ],
};

describe("ids", () => {
    it("allocates opaque row ids that avoid the ones taken", () => {
        const first = allocateRowId();
        expect(first).toMatch(/^r[0-9a-f]{10}$/);
        const taken = new Set([first]);
        for (let i = 0; i < 20; i += 1) {
            const next = allocateRowId(taken);
            expect(taken.has(next)).toBe(false);
            taken.add(next);
        }
    });

    it("addresses a cell by row and column id", () => {
        expect(cellIdFor("r1a2b3c4d5e", "year")).toBe("r1a2b3c4d5e/year");
    });
});

describe("readSpec", () => {
    it("reads a table without a version as the first format, and a corrupt file as invalid", () => {
        expect(readSpec({ id: "t1", columns: [], rows: [] })).toEqual({
            ok: false,
            reason: "unsupported_version",
            specVersion: 1,
        });
        expect(readSpec({ broken: true })).toMatchObject({ ok: false, reason: "invalid" });
        expect(readSpec({ id: "t1", spec_version: 1, columns: [], rows: [] })).toMatchObject({
            reason: "unsupported_version",
        });
    });

    const stored = {
        id: "t1",
        spec_version: TABLE_SPEC_VERSION,
        columns: [{ id: "a", header: "A", type: "text" }],
        rows: [{ id: "r", cells: {} }],
    };

    it("opens a spec written by this build", () => {
        expect(readSpec(stored)).toEqual({ ok: true, spec: stored });
    });

    it("refuses a spec of an older or newer format and reports the version it saw", () => {
        // No version means the first format, which this build has no reader for.
        const { spec_version: _version, ...unversioned } = stored;
        expect(readSpec(unversioned)).toEqual({
            ok: false,
            reason: "unsupported_version",
            specVersion: 1,
        });
        for (const specVersion of [1, TABLE_SPEC_VERSION + 1]) {
            expect(readSpec({ ...stored, spec_version: specVersion })).toEqual({
                ok: false,
                reason: "unsupported_version",
                specVersion,
            });
        }
    });

    it("keeps a role, outcome or provenance it does not recognise", () => {
        const future = {
            ...stored,
            columns: [
                { id: "a", header: "A", type: "text", role: "risk_of_bias" },
            ],
            rows: [
                {
                    id: "r",
                    cells: {
                        a: {
                            outcome: "disputed",
                            provenance: "delegated",
                            value: { kind: "text", text: "x" },
                        },
                    },
                },
            ],
        };
        const result = readSpec(future);
        expect(result.ok).toBe(true);
        // The spec comes back unchanged, so an old client can hand a stored
        // table on without flattening what it did not understand.
        expect(result.ok && result.spec).toEqual(future);
    });

    it("rejects something that is not a table, and says why", () => {
        expect(readSpec(null)).toMatchObject({
            ok: false,
            reason: "invalid",
        });
        expect(readSpec([stored])).toMatchObject({ reason: "invalid" });
        expect(readSpec({ ...stored, id: "" })).toMatchObject({
            reason: "invalid",
        });
        expect(readSpec({ ...stored, columns: {} })).toMatchObject({
            reason: "invalid",
        });
        expect(readSpec({ ...stored, rows: "none" })).toMatchObject({
            reason: "invalid",
        });
        expect(readSpec({ ...stored, rows: [{ cells: {} }] })).toMatchObject({
            reason: "invalid",
        });
        expect(readSpec({ ...stored, rows: [{ id: "r" }] })).toMatchObject({
            reason: "invalid",
        });
        // The reason is human-readable, so a caller can say what is wrong with
        // the file rather than only that something is.
        const detail = readSpec("nope");
        expect(
            detail.ok === false && detail.reason === "invalid"
                ? detail.detail
                : "",
        ).toMatch(/not an object/);
    });
});

describe("column vocabulary", () => {
    it("reads case, spacing and trailing punctuation as one option", () => {
        const key = normalizeSelectLabel("Quasi-experiment");
        expect(key).toBe("quasi experiment");
        for (const spelling of [
            "quasi-experiment",
            "Quasi_Experiment",
            "  QUASI   EXPERIMENT  ",
            "Quasi experiment.",
        ]) {
            expect(normalizeSelectLabel(spelling)).toBe(key);
        }
        expect(normalizeSelectLabel("RCT.")).toBe(normalizeSelectLabel("rct"));
        expect(normalizeSelectLabel("Include?")).toBe("include");
    });

    it("keeps genuinely different labels apart", () => {
        expect(normalizeSelectLabel("include")).not.toBe(
            normalizeSelectLabel("included"),
        );
        expect(normalizeSelectLabel("n/a")).not.toBe(
            normalizeSelectLabel("na"),
        );
        // A label made only of punctuation or separators would otherwise
        // normalize to the empty string, making every such label one option.
        expect(normalizeSelectLabel("?")).toBe("?");
        expect(normalizeSelectLabel("...")).not.toBe(normalizeSelectLabel("!"));
        expect(normalizeSelectLabel("-")).toBe("-");
        expect(normalizeSelectLabel("-")).not.toBe(normalizeSelectLabel("_"));
    });
});

describe("scope", () => {
    const columns: Column[] = [
        { id: "ref", header: "Item", type: "reference" },
        {
            id: "decision",
            header: "Decision",
            type: "select",
            role: "decision",
        },
        { id: "sample", header: "Sample", type: "text" },
    ];
    const decided = (cell: Cell | undefined): Row =>
        row("r", cell ? { decision: cell } : {});

    it("keeps every row in scope when the table has no decision column", () => {
        const plain: TableSpec = {
            id: "t",
            columns: [columns[0], columns[2]],
            rows: [row("r", {})],
        };
        expect(rowDecision(plain, plain.rows[0])).toBeUndefined();
        expect(rowInScope(plain, plain.rows[0])).toBe(true);
    });

    it("scopes rows by the user's decision, matched under the select key", () => {
        const table: TableSpec = { id: "t", columns, rows: [] };
        const include = decided({
            outcome: "answered",
            provenance: "user",
            value: { kind: "select", label: "Include." },
        });
        expect(rowDecision(table, include)).toBe("include");
        expect(rowInScope(table, include)).toBe(true);
        const exclude = decided({
            outcome: "answered",
            provenance: "user",
            value: { kind: "select", label: "Exclude" },
        });
        expect(rowInScope(table, exclude)).toBe(false);
        // Only a user decision is an override; an undecided row is out of scope.
        const filled = decided(
            answered({ kind: "select", label: "Include" }, "document"),
        );
        expect(rowDecision(table, filled)).toBeUndefined();
        expect(rowInScope(table, filled)).toBe(false);
        expect(rowInScope(table, decided(undefined))).toBe(false);
    });
});

describe("column roles", () => {
    const column = (role?: string, extra: Partial<Column> = {}): Column => ({
        id: "c",
        header: "C",
        type: "select",
        ...(role !== undefined ? { role } : {}),
        ...extra,
    });

    it("fills extraction and criterion columns, and scopes only extraction columns", () => {
        expect(isExtractionColumn(column())).toBe(true);
        expect(isFillableColumn(column())).toBe(true);
        expect(isExtractionColumn(column("criterion"))).toBe(false);
        expect(isFillableColumn(column("criterion"))).toBe(true);
        expect(isExtractionColumn(column("decision"))).toBe(false);
        expect(isFillableColumn(column("decision"))).toBe(false);
        expect(isFillableColumn(column(undefined, { system: true }))).toBe(false);
    });

    it("ignores a role this version does not know", () => {
        const future = column("some_future_role");
        expect(isExtractionColumn(future)).toBe(false);
        expect(isFillableColumn(future)).toBe(false);
    });

    it("keeps an unknown role through readSpec", () => {
        const raw = {
            id: "t",
            spec_version: TABLE_SPEC_VERSION,
            columns: [column("some_future_role")],
            rows: [],
        };
        const read = readSpec(structuredClone(raw));
        expect(read.ok && read.spec.columns[0].role).toBe("some_future_role");
    });
});

describe("defaults", () => {
    it("treats every column as sortable unless it opts out", () => {
        expect(
            isColumnSortable({ id: "r", header: "", type: "reference" }),
        ).toBe(true);
        expect(isColumnSortable({ id: "l", header: "", type: "link" })).toBe(
            true,
        );
        expect(
            isColumnSortable({
                id: "r",
                header: "",
                type: "reference",
                sortable: false,
            }),
        ).toBe(false);
        expect(isColumnSortable({ id: "n", header: "", type: "text" })).toBe(
            true,
        );
    });

    it("right-aligns dates by default", () => {
        expect(columnAlign({ id: "d", header: "", type: "date" })).toBe(
            "end",
        );
        expect(columnAlign({ id: "t", header: "", type: "text" })).toBe(
            "start",
        );
        expect(
            columnAlign({
                id: "n",
                header: "",
                type: "date",
                align: "start",
            }),
        ).toBe("start");
    });

    it("reads an unattempted, failed or cleared cell as empty and a finding as not", () => {
        expect(isCellEmpty(undefined)).toBe(true);
        expect(
            isCellEmpty({
                outcome: "failed",
                provenance: "model",
                error_code: "no_locator",
                error: "The answer cited no passage.",
            }),
        ).toBe(true);
        expect(isCellEmpty({ outcome: "cleared", provenance: "user" })).toBe(
            true,
        );
        expect(
            isCellEmpty({ outcome: "not_reported", provenance: "model" }),
        ).toBe(false);
        expect(isCellEmpty(answered({ kind: "boolean", value: false }))).toBe(
            false,
        );
    });
});

describe("sortRows", () => {
    it("sorts a quantity column numerically and puts empty cells last in both directions", () => {
        expect(
            sortRows(spec, { column_id: "cites", direction: "asc" }).map(
                (r) => r.id,
            ),
        ).toEqual(["b", "a", "c"]);
        expect(
            sortRows(spec, { column_id: "cites", direction: "desc" }).map(
                (r) => r.id,
            ),
        ).toEqual(["a", "b", "c"]);
    });

    it("sorts every text column numeric-aware, worded answers with the words", () => {
        const order = (texts: string[]) =>
            texts
                .map((text) => answered({ kind: "text", text }))
                .map((cell) => ({ cell, key: cellSortKey(cell) }))
                .sort((a, b) => compareSortKeys(a.key, b.key))
                .map(({ cell }) => (cell.value as { text: string }).text);
        expect(order(["120", "9", "over 100", "about 4", "10–20", "21.9", "about 12"])).toEqual([
            "9", "10–20", "21.9", "120", "about 4", "about 12", "over 100",
        ]);
        // Thousands groups and decimals compare as numbers.
        expect(order(["1,200", "950", "12,000,000", "12,500", "1.5", "1.25", "815,383"])).toEqual([
            "1.25", "1.5", "950", "1,200", "12,500", "815,383", "12,000,000",
        ]);
        expect(order(["1", "0.5", ".1", ".05", "+2", "-3", "−4"])).toEqual([
            "−4", "-3", ".05", ".1", "0.5", "1", "+2",
        ]);
        // A total order: answers that open with a number first, by it, then
        // the rest; every arrival order of the same answers sorts alike.
        const mixed = ["+10", "<2", "2", "about 4", "≥3", "1,200", "Kenya", ".5"];
        const expected = [".5", "2", "+10", "1,200", "<2", "≥3", "about 4", "Kenya"];
        for (let shift = 0; shift < mixed.length; shift++) {
            const rotated = [...mixed.slice(shift), ...mixed.slice(0, shift)];
            expect(order(rotated)).toEqual(expected);
            expect(order([...rotated].reverse())).toEqual(expected);
        }
        expect(order(["+10", "<2", "2"])).toEqual(["2", "+10", "<2"]);
        // Case and accents aside, digit runs as numbers.
        expect(order(["Study 10", "study 9", "Étude 2", "etude 1"])).toEqual([
            "etude 1", "Étude 2", "study 9", "Study 10",
        ]);
        expect(cellSortKey(answered({ kind: "text", text: "Over 100" }))).toEqual({
            text: "over 100",
        });
        expect(cellSortKey(answered({ kind: "text", text: "1,200" }))).toEqual({
            text: "1,200",
            lead: 1200,
        });
    });

    it("sorts ISO dates of mixed precision lexically", () => {
        expect(
            sortRows(spec, { column_id: "year", direction: "asc" }).map(
                (r) => r.id,
            ),
        ).toEqual(["b", "a", "c"]);
    });

    it("sorts a reference by the title it shows, else its short label", () => {
        expect(
            cellSortKey(
                answered({
                    kind: "reference",
                    display_name: "Adams 2020",
                    title: "Zeta title",
                }),
            ),
        ).toBe("zeta title");
        expect(
            cellSortKey(
                answered({ kind: "reference", display_name: "Adams 2020" }),
            ),
        ).toBe("adams 2020");
    });

    it("sorts text case-insensitively", () => {
        expect(
            cellSortKey(answered({ kind: "reference", display_name: "Zed" })),
        ).toBe("zed");
        expect(
            sortRows(spec, { column_id: "ref", direction: "asc" }).map(
                (r) => r.id,
            ),
        ).toEqual(["c", "b", "a"]);
    });

    it("sorts booleans false before true and keeps input order among equals", () => {
        expect(
            sortRows(spec, { column_id: "oa", direction: "asc" }).map(
                (r) => r.id,
            ),
        ).toEqual(["b", "a", "c"]);
        expect(
            sortRows(spec, { column_id: "type", direction: "asc" }).map(
                (r) => r.id,
            ),
        ).toEqual(["a", "c", "b"]);
    });

    it("returns the rows unchanged without a sort or for an unknown column", () => {
        expect(sortRows(spec, undefined)).toBe(spec.rows);
        expect(sortRows(spec, { column_id: "nope", direction: "asc" })).toBe(
            spec.rows,
        );
    });
});

describe("filterRows", () => {
    it("matches text by case-insensitive substring", () => {
        expect(
            filterRows(spec, [
                { column_id: "methods", kind: "contains", text: "survey" },
            ]).map((r) => r.id),
        ).toEqual(["a"]);
    });

    it("filters a quantity column as text, and ranges only dates", () => {
        expect(
            filterRows(spec, [
                { column_id: "cites", kind: "contains", text: "12" },
            ]).map((r) => r.id),
        ).toEqual(["a"]);
        // A range is for dates: a quantity's text is not compared as a number.
        expect(
            filterRows(spec, [
                { column_id: "cites", kind: "range", min: 7, max: 119 },
            ]).map((r) => r.id),
        ).toEqual([]);
        expect(
            filterRows(spec, [
                { column_id: "year", kind: "range", min: "2020" },
            ]).map((r) => r.id),
        ).toEqual(["a", "c"]);
    });

    it("filters select membership and boolean equality", () => {
        expect(
            filterRows(spec, [
                { column_id: "type", kind: "in", labels: ["Book"] },
            ]).map((r) => r.id),
        ).toEqual(["b"]);
        expect(
            filterRows(spec, [
                { column_id: "oa", kind: "equals", value: true },
            ]).map((r) => r.id),
        ).toEqual(["a"]);
    });

    it("filters on emptiness and ANDs multiple filters", () => {
        expect(
            filterRows(spec, [
                { column_id: "cites", kind: "empty", empty: true },
            ]).map((r) => r.id),
        ).toEqual(["c"]);
        expect(
            filterRows(spec, [
                { column_id: "type", kind: "in", labels: ["Article"] },
                { column_id: "methods", kind: "empty", empty: false },
                { column_id: "cites", kind: "empty", empty: false },
            ]).map((r) => r.id),
        ).toEqual(["a"]);
    });

    it("ignores filters on unknown columns", () => {
        expect(
            filterRows(spec, [
                { column_id: "nope", kind: "contains", text: "x" },
            ]),
        ).toBe(spec.rows);
    });

    it("lists distinct select labels in first-seen order", () => {
        expect(selectLabelsInColumn(spec, "type")).toEqual(["Article", "Book"]);
    });
});

describe("validateTableSpec", () => {
    it("accepts a well-formed spec", () => {
        expect(validateTableSpec(spec)).toEqual([]);
    });

    it("reports duplicate ids, unknown columns and sort columns", () => {
        const bad: TableSpec = {
            id: "t",
            columns: [
                { id: "a", header: "A", type: "text" },
                { id: "a", header: "A2", type: "text" },
            ],
            rows: [
                row("r", { zzz: answered({ kind: "text", text: "x" }) }),
                row("r", {}),
            ],
            sort: { column_id: "missing", direction: "asc" },
        };
        expect(validateTableSpec(bad).map((i) => i.code)).toEqual([
            "duplicate_column_id",
            "unknown_sort_column",
            "unknown_column",
            "duplicate_row_id",
        ]);
    });

    it("reports a value kind that disagrees with the column type", () => {
        const bad: TableSpec = {
            id: "t",
            columns: [{ id: "n", header: "N", type: "date" }],
            rows: [row("r", { n: answered({ kind: "text", text: "12" }) })],
        };
        expect(validateTableSpec(bad)).toMatchObject([
            { code: "value_kind_mismatch", row_id: "r", column_id: "n" },
        ]);
    });

    it("checks select labels only when the column declares options", () => {
        const declared: TableSpec = {
            ...spec,
            rows: [
                row("r", {
                    type: answered({ kind: "select", label: "Preprint" }),
                }),
            ],
        };
        expect(validateTableSpec(declared)).toMatchObject([
            { code: "unknown_select_label" },
        ]);

        const free: TableSpec = {
            id: "t",
            columns: [{ id: "type", header: "T", type: "select" }],
            rows: [
                row("r", {
                    type: answered({ kind: "select", label: "Preprint" }),
                }),
            ],
        };
        expect(validateTableSpec(free)).toEqual([]);
    });

    it("reports a cell that breaks an outcome or provenance invariant", () => {
        const text = { kind: "text", text: "Survey" } as const;
        const filler = { outcome: "answered", provenance: "model", value: text } as const;
        const broken = {
            answeredWithoutValue: { outcome: "answered", provenance: "model" },
            notReportedWithValue: { outcome: "not_reported", provenance: "model", value: text },
            failedWithoutError: { outcome: "failed", provenance: "model" },
            failedWithoutCode: { outcome: "failed", provenance: "model", error: "x" },
            errorOnAnswer: { ...answered(text), error: "x" },
            errorCodeOnNotReported: { outcome: "not_reported", provenance: "model", error_code: "deadline" },
            reasoningOnFailure: {
                outcome: "failed",
                provenance: "model",
                error_code: "no_locator",
                error: "x",
                reasoning: "why",
            },
            evidenceOnUserCell: {
                ...answered(text, "user"),
                evidence: [{ document: "u-D", locator: "s1", quote: "Survey" }],
            },
            documentsOnSystemCell: { ...answered(text), documents: ["u-D"] },
            evidenceOutsideItsDocuments: {
                ...filler,
                documents: ["u-D"],
                evidence: [{ document: "u-E", locator: "s1", quote: "Survey" }],
            },
            evidenceWithoutLocator: {
                ...filler,
                documents: ["u-D"],
                evidence: [{ document: "u-D", quote: "Survey" }],
            },
            unknownConfidence: { ...filler, confidence: "certain" },
            clearedByFiller: { outcome: "cleared", provenance: "model" },
            unknownOutcome: { outcome: "pending", provenance: "model" },
            unknownProvenance: { ...answered(text), provenance: "extracted" },
        } as unknown as Record<string, Cell>;
        const bad: TableSpec = {
            id: "t",
            columns: [{ id: "m", header: "M", type: "text" }],
            rows: Object.entries(broken).map(([id, cell]) =>
                row(id, { m: cell }),
            ),
        };
        expect(
            validateTableSpec(bad)
                .filter((i) => i.code === "invalid_cell")
                .map((i) => [i.code, i.row_id, i.column_id]),
        ).toEqual(Object.keys(broken).map((id) => ["invalid_cell", id, "m"]));
        expect(cellInvariantError(broken.failedWithoutError)).toMatch(
            /error and an error code exactly when its outcome is failed/,
        );
        expect(cellInvariantError(broken.errorCodeOnNotReported)).toMatch(
            /error and an error code exactly when its outcome is failed/,
        );
        expect(cellInvariantError(broken.evidenceOutsideItsDocuments)).toMatch(
            /names one of the cell's documents/,
        );
    });

    it("reports a row whose documents or failure are malformed", () => {
        const rows = [
            { id: "documents", documents: [""], cells: {} },
            { id: "failure", failure: { code: "encrypted" }, cells: {} },
        ] as unknown as Row[];
        expect(rowInvariantError(rows[0])).toMatch(/list of document ids/);
        expect(
            validateTableSpec({ id: "t", columns: [], rows }).map((i) => [i.code, i.row_id]),
        ).toEqual([
            ["invalid_row", "documents"],
            ["invalid_row", "failure"],
        ]);
        expect(
            rowInvariantError({ id: "ok", documents: ["u-D"], failure: { code: "encrypted", message: "Locked." }, cells: {} }),
        ).toBeUndefined();
    });

    it("accepts every well-formed outcome", () => {
        const good: TableSpec = {
            id: "t",
            columns: [{ id: "m", header: "M", type: "text" }],
            rows: [
                row("doc", {
                    m: {
                        outcome: "answered",
                        provenance: "model",
                        value: { kind: "text", text: "Survey" },
                        documents: ["u-D"],
                        evidence: [
                            { document: "u-D", locator: "s1", quote: "A survey", page: 0, context: "Table 1. Methods" },
                        ],
                        reasoning: "Stated in the methods.",
                        confidence: "low",
                        stale: true,
                    },
                }),
                // A key this build does not know is kept and ignored.
                row("unknownKey", {
                    m: {
                        outcome: "answered",
                        provenance: "model",
                        value: { kind: "text", text: "Not discussed" },
                        documents: ["u-D"],
                        absent: true,
                        reasoning: "No section on it.",
                    } as unknown as Cell,
                }),
                row("meta", {
                    m: {
                        outcome: "not_reported",
                        provenance: "model",
                        reasoning: "The abstract gives no method.",
                    },
                }),
                row("failed", {
                    m: {
                        outcome: "failed",
                        provenance: "model",
                        error: "The answer cited no passage.",
                        error_code: "no_locator",
                    },
                }),
                row("cleared", {
                    m: { outcome: "cleared", provenance: "user" },
                }),
                row("unattempted", {}),
            ],
        };
        expect(validateTableSpec(good)).toEqual([]);
    });

    it("reports duplicate sources, a second items source and an unknown row origin", () => {
        const sourced: TableSpec = {
            id: "t",
            columns: [{ id: "m", header: "M", type: "text" }],
            sources: [
                { id: "s1", type: "items", ids: ["u-AAAA1111"] },
                {
                    id: "s1",
                    type: "library",
                    scope: { kind: "tag", library_ref: "u", tag: "x" },
                },
                { id: "s2", type: "items", ids: ["u-BBBB2222"] },
            ],
            rows: [
                {
                    id: "r",
                    cells: {},
                    origin: [
                        { source: "s2", date: "2026-10-01" },
                        { source: "s9", date: "2026-10-01" },
                    ],
                },
            ],
        };
        expect(
            validateTableSpec(sourced).map((i) => [i.code, i.row_id]),
        ).toEqual([
            ["duplicate_source_id", undefined],
            ["multiple_items_sources", undefined],
            ["unknown_origin_source", "r"],
        ]);
    });
});

describe("plain text", () => {
    const cited =
        'Survey of 1,200 adults <citation id="u-ABCD1234" loc="s12"/> in 2019.';
    const citedSpec: TableSpec = {
        id: "t",
        columns: [{ id: "m", header: "Methods", type: "text" }],
        rows: [row("a", { m: answered({ kind: "text", text: cited }) })],
    };

    it("leaves citation markup out of the text form of a value", () => {
        expect(cellValueText({ kind: "text", text: cited })).toBe(
            "Survey of 1,200 adults in 2019.",
        );
        expect(stripCitationTags("nothing to strip")).toBe("nothing to strip");
    });

    it("sorts on the prose rather than on the markup in front of it", () => {
        expect(
            cellSortKey(
                answered({
                    kind: "text",
                    text: '<citation external_id="W1"/>Zeta',
                }),
            ),
        ).toEqual({ text: "zeta" });
    });

    it("does not let a text filter match the citation tags", () => {
        expect(
            filterRows(citedSpec, [
                { column_id: "m", kind: "contains", text: "citation" },
            ]),
        ).toEqual([]);
        expect(
            filterRows(citedSpec, [
                { column_id: "m", kind: "contains", text: "adults in" },
            ]).map((r) => r.id),
        ).toEqual(["a"]);
    });

    it("exports a CSV cell without the tags", () => {
        expect(toCsv(citedSpec)).toBe(
            'Methods,Methods — state\r\n"Survey of 1,200 adults in 2019.",system',
        );
    });
});

describe("toCsv", () => {
    it("writes headers, value text, empty cells and escapes fields", () => {
        const csv = toCsv(
            spec,
            sortRows(spec, { column_id: "cites", direction: "desc" }),
        );
        expect(csv.split("\r\n")).toEqual([
            "Reference,Reference — state,Year,Year — state,Citations,Citations — state,Type,Type — state,Open access,Open access — state,Methods,Methods — state",
            'Smith 2020 — Alpha,system,2020,system,120,system,Article,system,true,system,"Survey, n = 1,200",system',
            "Jones 2018,system,2018-05,system,7,system,Book,system,false,system,,",
            "adams 2022,system,2022-01-15,system,,,Article,system,,,Interviews,system",
        ]);
    });

    it("writes evidence, reasoning and state beside the value, never confidence, escaping formula-like text", () => {
        const table: TableSpec = {
            id: "outcomes",
            columns: [{ id: "a", header: "=Header", type: "text" }],
            rows: [
                { id: "unattempted", cells: {} },
                {
                    id: "finding",
                    cells: {
                        a: {
                            outcome: "not_reported",
                            provenance: "model",
                            reasoning: "=Nothing on sample size",
                        },
                    },
                },
                {
                    id: "answer",
                    documents: ["u-DOC1"],
                    cells: {
                        a: {
                            outcome: "answered",
                            provenance: "model",
                            value: { kind: "text", text: "120 adults" },
                            documents: ["u-DOC1"],
                            confidence: "low",
                            stale: true,
                            evidence: [
                                {
                                    document: "u-DOC1",
                                    locator: "s1",
                                    page: 3,
                                    quote: 'The study enrolled "120" participants.',
                                    context: "Table 1. Sample",
                                },
                                { document: "u-DOC1", locator: "s9", quote: "120 adults" },
                            ],
                        },
                    },
                },
                {
                    id: "silent",
                    documents: ["u-DOC1"],
                    cells: {
                        a: {
                            outcome: "answered",
                            provenance: "model",
                            value: { kind: "text", text: "Not discussed" },
                            documents: ["u-DOC1"],
                            confidence: "high",
                        },
                    },
                },
                {
                    id: "failed",
                    cells: {
                        a: {
                            outcome: "failed",
                            provenance: "model",
                            error_code: "no_locator",
                            error: "no passage",
                        },
                    },
                },
            ],
        };
        const lines = toCsv(table).split("\r\n");
        expect(lines[0]).toBe(
            "'=Header,'=Header — evidence,'=Header — reasoning,'=Header — state",
        );
        expect(lines[1]).toBe(",,,");
        expect(lines[2]).toBe(
            "Not reported,,'=Nothing on sample size,not_reported; title and abstract; model",
        );
        expect(lines[3]).toBe(
            '120 adults,"u-DOC1 s1: The study enrolled ""120"" participants. [Table 1. Sample]\nu-DOC1 s9: 120 adults",,stale; model',
        );
        expect(lines[4]).toBe("Not discussed,,,model");
        expect(lines[5]).toBe(",,,failed; no passage; model");
        expect(toCsv(table)).not.toMatch(/confidence|\blow\b|\bhigh\b/);
    });

});

describe("anchor column", () => {
    it("prefers the declared anchor, then the first reference column, then the first column", () => {
        const columns: Column[] = [
            { id: "year", header: "Year", type: "date" },
            { id: "item", header: "Item", type: "reference" },
        ];
        const base: TableSpec = { id: "t", columns, rows: [] };
        expect(anchorColumn(base)?.id).toBe("item");
        expect(anchorColumn({ ...base, anchor_column_id: "year" })?.id).toBe(
            "year",
        );
        // An anchor id that does not exist falls back rather than yielding nothing.
        expect(anchorColumn({ ...base, anchor_column_id: "nope" })?.id).toBe(
            "item",
        );
        expect(anchorColumn({ ...base, columns: [columns[0]] })?.id).toBe(
            "year",
        );
    });
});

describe("row actions", () => {
    const spec: TableSpec = {
        id: "t",
        columns: [{ id: "item", header: "Item", type: "reference" }],
        rows: [],
        capabilities: { row_actions: ["import", "reveal", "open"] },
    };

    function mkRow(partial: Partial<Row>): Row {
        return { id: "r", cells: {}, ...partial };
    }

    const item = { library_ref: "u", library_id: 1, zotero_key: "K" };
    const file = { library_ref: "u", library_id: 1, zotero_key: "F" };
    const libraryCopy = { library_id: 1, zotero_key: "K" };
    const externalRef: ExternalReference = {
        source: "openalex",
        source_id: "W1",
        title: "Alpha",
        library_items: [],
    };

    it("treats a Zotero object, an explicit flag and an external reference with a library copy as in-library", () => {
        expect(isRowInLibrary(mkRow({ ref: { kind: "item", ...item } }))).toBe(
            true,
        );
        expect(isRowInLibrary(mkRow({}))).toBe(false);
        expect(isRowInLibrary(mkRow({ in_library: true }))).toBe(true);
        expect(
            isRowInLibrary(
                mkRow({
                    ref: {
                        kind: "external",
                        source: "openalex",
                        source_id: "W1",
                        reference: {
                            ...externalRef,
                            library_items: [libraryCopy],
                        },
                    },
                }),
            ),
        ).toBe(true);
        expect(
            isRowInLibrary(
                mkRow({
                    ref: {
                        kind: "external",
                        source: "openalex",
                        source_id: "W1",
                    },
                }),
            ),
        ).toBe(false);
    });

    it("offers import only off-library and only with the payload to import", () => {
        const external = mkRow({
            id: "ext",
            ref: {
                kind: "external",
                source: "openalex",
                source_id: "W1",
                reference: externalRef,
            },
        });
        expect(rowActions(spec, external)).toEqual(["import"]);
        expect(rowActionTarget(external, "import")).toEqual({
            kind: "import_reference",
            reference: externalRef,
        });
        // No bibliographic payload: nothing to import, whatever the table says.
        expect(
            rowActions(
                spec,
                mkRow({
                    ref: {
                        kind: "external",
                        source: "openalex",
                        source_id: "W1",
                    },
                }),
            ),
        ).toEqual([]);
    });

    it("reveals and opens an external row through its library copy once it has one", () => {
        const inLibrary = mkRow({
            ref: {
                kind: "external",
                source: "openalex",
                source_id: "W1",
                reference: { ...externalRef, library_items: [libraryCopy] },
            },
        });
        expect(rowActions(spec, inLibrary)).toEqual(["reveal", "open"]);
        expect(rowActionTarget(inLibrary, "reveal")).toEqual({
            kind: "reveal_item",
            ref: { ...libraryCopy, library_ref: undefined },
        });
        expect(rowActionTarget(inLibrary, "open")?.kind).toBe("open_item");
    });

    it("opens a library item's named file, and lets the host pick one otherwise", () => {
        const withFile = mkRow({
            ref: { kind: "item", ...item },
            documents: ["u-F"],
        });
        expect(rowActions(spec, withFile)).toEqual(["reveal", "open"]);
        // The document id names its library portably; the item's rowid
        // stands for it in the same library.
        expect(rowActionTarget(withFile, "open")).toEqual({
            kind: "open_file",
            ref: { library_ref: "u", library_id: 1, zotero_key: "F" },
        });
        const withoutFile = mkRow({ ref: { kind: "item", ...item } });
        expect(rowActionTarget(withoutFile, "open")).toEqual({
            kind: "open_item",
            ref: item,
        });
        expect(rowActionTarget(withFile, "import")).toBeUndefined();
    });

    it("targets a ref from another device by its library_ref, with the unresolved rowid", () => {
        const travelled = mkRow({
            ref: { kind: "item", library_ref: "g42", zotero_key: "K" },
        });
        expect(rowActionTarget(travelled, "reveal")).toEqual({
            kind: "reveal_item",
            ref: { library_ref: "g42", library_id: 0, zotero_key: "K" },
        });
    });

    it("withdraws a Zotero row's verbs when the producer marks it out of the library", () => {
        // `in_library: false` is the producer knowing better — the item was
        // deleted or is out of reach — so reveal and open go with it.
        const gone = mkRow({
            ref: { kind: "item", ...item },
            in_library: false,
        });
        expect(rowActions(spec, gone)).toEqual([]);
    });

    it("lets a row narrow the table's verbs, and offers none without a ref", () => {
        const inLib = mkRow({
            ref: { kind: "item", ...item },
            actions: ["reveal"],
        });
        expect(rowActions(spec, inLib)).toEqual(["reveal"]);
        expect(rowActions(spec, mkRow({ in_library: true }))).toEqual([]);
    });
});

describe("anchor cells and row kinds", () => {
    const item = { library_ref: "u", library_id: 1, zotero_key: "K" };
    const reference = answered({ kind: "reference", display_name: "Alpha 2020" }, "system");

    it("hides system columns until asked", () => {
        const spec: TableSpec = {
            id: "t",
            columns: [
                { id: "ref", header: "Item", type: "reference" },
                { id: "_year", header: "Year", type: "date", system: true },
            ],
            rows: [],
        };
        expect(defaultHiddenColumnIds(spec)).toEqual(["_year"]);
    });

    it("accepts only a reference in the anchor cell of an item row", () => {
        const spec: TableSpec = {
            id: "t",
            anchor_column_id: "title",
            columns: [{ id: "title", header: "Title", type: "text" }],
            rows: [
                {
                    id: "rK",
                    ref: { kind: "item", ...item },
                    cells: { title: answered({ kind: "text", text: "Alpha" }, "system") },
                },
            ],
        };
        expect(validateTableSpec(spec).map((i) => [i.code, i.row_id])).toEqual([
            ["anchor_kind_mismatch", "rK"],
        ]);
    });

    it("rejects a row that is neither a Zotero item nor an external work", () => {
        for (const ref of [
            { kind: "attachment", ...item },
            { kind: "annotation", ...item, attachment: item },
            { kind: "file", ext_key: "AB12CD34" },
        ]) {
            const spec: TableSpec = {
                id: "t",
                columns: [{ id: "item", header: "Item", type: "reference" }],
                rows: [{ id: "r", ref: ref as never, cells: { item: reference } }],
            };
            expect(validateTableSpec(spec).map((i) => i.code)).toEqual(["invalid_row"]);
        }
    });

    it("includes a reference's title in its text, for search and export", () => {
        expect(
            cellValueText({
                kind: "reference",
                display_name: "Alpha 2020",
                title: "Sampling hard-to-reach groups",
                subtitle: "Alpha, A.",
            }),
        ).toBe("Alpha 2020 — Sampling hard-to-reach groups — Alpha, A.");
        expect(
            cellValueText({
                kind: "reference",
                display_name: "Same",
                title: "Same",
            }),
        ).toBe("Same");
    });
});

describe("column progress validation", () => {
    it("flags an impossible progress pair and an unknown anchor column", () => {
        const spec: TableSpec = {
            id: "t",
            anchor_column_id: "nope",
            columns: [
                {
                    id: "sample",
                    header: "Sample",
                    type: "text",
                    status: "filling",
                    progress: { done: 12, total: 9 },
                },
            ],
            rows: [],
        };
        expect(
            validateTableSpec(spec)
                .map((i) => i.code)
                .sort(),
        ).toEqual(["invalid_column_progress", "unknown_anchor_column"]);
    });
});

describe("column types", () => {
    it("have no number type: a column of one is not a supported definition", () => {
        const spec: TableSpec = {
            id: "t",
            columns: [{ id: "n", header: "N", type: "number" as never }],
            rows: [],
        };
        expect(validateTableSpec(spec).map((i) => i.code)).toEqual(["invalid_column_definition"]);
    });
});

describe("evidence heading and uncited answers", () => {
    const base = { provenance: "model", documents: ["u-D"] } as const;

    it("heads passages by outcome alone", () => {
        expect(evidenceHeading({ ...base, outcome: "not_reported" } as Cell)).toBe("Closest passages");
        for (const value of [
            { kind: "boolean", value: false },
            { kind: "select", label: "Not discussed" },
            { kind: "text", text: "12" },
        ])
            expect(evidenceHeading({ ...base, outcome: "answered", value } as Cell)).toBe("Evidence");
    });

    it("tells a document answer without passages apart", () => {
        const answer = { ...base, outcome: "answered", value: { kind: "boolean", value: false } } as Cell;
        expect(isUncitedAnswer(answer)).toBe(true);
        expect(isUncitedAnswer({ ...answer, evidence: [{ document: "u-D", locator: "s1", quote: "q" }] })).toBe(false);
        expect(isUncitedAnswer({ ...answer, documents: undefined })).toBe(false);
        expect(isUncitedAnswer({ ...answer, provenance: "user", documents: undefined })).toBe(false);
        expect(isUncitedAnswer({ ...base, outcome: "not_reported" } as Cell)).toBe(false);
    });
});

describe("coverage", () => {
    it("separates filled, not-reported, failed and title-and-abstract cells, and counts no review mark", () => {
        const spec: TableSpec = {
            id: "t",
            columns: [
                { id: "a", header: "A", type: "text" },
                {
                    id: "b",
                    header: "B",
                    type: "text",
                    description: "What is B?",
                },
                { id: "_year", header: "Year", type: "date", system: true },
            ],
            rows: [
                {
                    id: "r1",
                    documents: ["u-D1"],
                    cells: {
                        a: answered({ kind: "text", text: "x" }),
                        b: { outcome: "not_reported", provenance: "model", documents: ["u-D1"], confidence: "low" },
                    },
                },
                {
                    id: "r2",
                    failure: { code: "encrypted", message: "Locked." },
                    cells: {
                        a: {
                            outcome: "failed",
                            provenance: "model",
                            error_code: "no_locator",
                            error: "no passage",
                        },
                        b: answered({ kind: "text", text: "2" }, "model"),
                    },
                },
                {
                    id: "r3",
                    cells: { a: { outcome: "cleared", provenance: "user" } },
                },
            ],
        };
        expect(summarizeCoverage(spec)).toEqual({
            rows: 3,
            cells: 9,
            filled: 2,
            empty: 7,
            notReported: 1,
            error: 1,
            errorRows: 1,
            titleAbstractOnly: 1,
        });
        expect(isTitleAbstractOnly(spec.rows[1].cells.b)).toBe(true);
        expect(isTitleAbstractOnly(spec.rows[0].cells.a)).toBe(false);
    });

    it("says why a cell is stale: the question, or the row's documents, never for a user's cell", () => {
        const read = (documents?: string[], extra: Record<string, unknown> = {}) =>
            ({
                outcome: "answered",
                provenance: "model",
                value: { kind: "text", text: "x" },
                ...(documents ? { documents } : {}),
                ...extra,
            }) as Cell;
        const named = { documents: ["u-A"] };
        expect(staleReason(named, read(["u-A"]))).toBeUndefined();
        expect(staleReason(named, read(["u-A"], { stale: true }))).toBe("question");
        // a) another attachment; b) a second one; c) a title/abstract row gains one.
        expect(staleReason({ documents: ["u-B"] }, read(["u-A"]))).toBe("document");
        expect(staleReason({ documents: ["u-A", "u-B"] }, read(["u-A"]))).toBe("document");
        expect(staleReason(named, read())).toBe("document");
        expect(isStale({}, read())).toBe(false);
        expect(isStale(named, answered({ kind: "text", text: "x" }, "user"))).toBe(false);
        expect(
            isStale(named, { outcome: "failed", provenance: "model", error_code: "x", error: "x" }),
        ).toBe(false);
    });

    it("computes the review mark (kept for evaluation) on a filler answer or blank read from a document, below high confidence, outside text columns", () => {
        const cell = (confidence: string, extra: Record<string, unknown> = {}) =>
            ({
                outcome: "answered",
                provenance: "model",
                value: { kind: "boolean", value: false },
                documents: ["u-D"],
                confidence,
                ...extra,
            }) as Cell;
        expect(needsReview({ type: "boolean" }, cell("medium"))).toBe(true);
        expect(needsReview({ type: "select" }, cell("low"))).toBe(true);
        expect(needsReview({ type: "date" }, cell("high"))).toBe(false);
        expect(needsReview({ type: "text" }, cell("low"))).toBe(false);
        // From title and abstract.
        expect(needsReview({ type: "boolean" }, cell("low", { documents: undefined }))).toBe(false);
        expect(needsReview({ type: "boolean" }, cell("low", { documents: [] }))).toBe(false);
        expect(
            needsReview({ type: "date" }, cell("medium", { outcome: "not_reported", value: undefined })),
        ).toBe(true);
        expect(needsReview({ type: "boolean" }, cell("low", { provenance: "user", documents: undefined }))).toBe(false);
        expect(needsReview({ type: "boolean" }, undefined)).toBe(false);
    });

    it("counts only the rows it is given, so a footer can report the filtered view", () => {
        const spec: TableSpec = {
            id: "t",
            columns: [{ id: "a", header: "A", type: "text" }],
            rows: [
                {
                    id: "r1",
                    cells: { a: answered({ kind: "text", text: "x" }) },
                },
                { id: "r2", cells: {} },
            ],
        };
        expect(summarizeCoverage(spec, [spec.rows[0]])).toMatchObject({
            rows: 1,
            cells: 1,
            filled: 1,
            empty: 0,
        });
    });
});
