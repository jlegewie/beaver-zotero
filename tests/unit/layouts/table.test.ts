import { describe, expect, it } from "vitest";
import type { ExternalReference } from "@beaver/agent-core/types/externalReferences";
import {
    allocateRowId,
    anchorColumn,
    annotationComment,
    annotationTitle,
    cellExpandedFields,
    cellIdFor,
    cellInvariantError,
    cellSortKey,
    cellValueText,
    columnAlign,
    defaultHiddenColumnIds,
    filterRows,
    isCellEmpty,
    isColumnSortable,
    isExtractionColumn,
    isFillableColumn,
    isMetadataOnly,
    isRowInLibrary,
    normalizeSelectLabel,
    readSpec,
    rowActionTarget,
    rowActions,
    rowDecision,
    rowInScope,
    rowPrimaryAction,
    rowTypeLabel,
    selectLabelsInColumn,
    sortRows,
    stripCitationTags,
    summarizeCoverage,
    TABLE_SPEC_VERSION,
    toCsv,
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

/** An answered cell; the filler read the attachment unless told otherwise. */
function answered(
    value: CellValue,
    provenance: Cell["provenance"] = "document",
): Cell {
    return { outcome: "answered", provenance, value };
}

const spec: TableSpec = {
    id: "t1",
    columns: [
        { id: "ref", header: "Reference", type: "reference" },
        { id: "year", header: "Year", type: "date" },
        { id: "cites", header: "Citations", type: "number" },
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
            cites: answered({ kind: "number", value: 120 }),
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
            cites: answered({ kind: "number", value: 7 }),
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
    const stored = {
        id: "t1",
        columns: [{ id: "a", header: "A", type: "text" }],
        rows: [{ id: "r", cells: {} }],
    };

    it("opens a spec written without a version and one written by this build", () => {
        expect(readSpec(stored)).toEqual({ ok: true, spec: stored });
        const versioned = { ...stored, spec_version: TABLE_SPEC_VERSION };
        expect(readSpec(versioned)).toEqual({ ok: true, spec: versioned });
    });

    it("refuses a spec from a newer format and reports the version it saw", () => {
        expect(
            readSpec({ ...stored, spec_version: TABLE_SPEC_VERSION + 1 }),
        ).toEqual({
            ok: false,
            reason: "unsupported_version",
            specVersion: TABLE_SPEC_VERSION + 1,
        });
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
        expect(isColumnSortable({ id: "n", header: "", type: "number" })).toBe(
            true,
        );
    });

    it("right-aligns numbers and dates by default", () => {
        expect(columnAlign({ id: "n", header: "", type: "number" })).toBe(
            "end",
        );
        expect(columnAlign({ id: "t", header: "", type: "text" })).toBe(
            "start",
        );
        expect(
            columnAlign({
                id: "n",
                header: "",
                type: "number",
                align: "start",
            }),
        ).toBe("start");
    });

    it("reads an unattempted, failed or cleared cell as empty and a finding as not", () => {
        expect(isCellEmpty(undefined)).toBe(true);
        expect(
            isCellEmpty({
                outcome: "failed",
                provenance: "document",
                error: "no text layer",
            }),
        ).toBe(true);
        expect(isCellEmpty({ outcome: "cleared", provenance: "user" })).toBe(
            true,
        );
        expect(
            isCellEmpty({ outcome: "not_reported", provenance: "document" }),
        ).toBe(false);
        expect(isCellEmpty(answered({ kind: "boolean", value: false }))).toBe(
            false,
        );
    });
});

describe("sortRows", () => {
    it("sorts numbers numerically and puts empty cells last in both directions", () => {
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

    it("applies inclusive ranges to numbers and dates, excluding empty cells", () => {
        expect(
            filterRows(spec, [
                { column_id: "cites", kind: "range", min: 7, max: 119 },
            ]).map((r) => r.id),
        ).toEqual(["b"]);
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
            columns: [{ id: "n", header: "N", type: "number" }],
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
        const broken: Record<string, Cell> = {
            answeredWithoutValue: {
                outcome: "answered",
                provenance: "document",
            },
            notReportedWithValue: {
                outcome: "not_reported",
                provenance: "document",
                value: text,
            },
            failedWithoutError: { outcome: "failed", provenance: "document" },
            errorOnAnswer: { ...answered(text), error: "x" },
            evidenceOnUserCell: {
                ...answered(text, "user"),
                evidence: [{ locator: "s1", quote: "Survey" }],
            },
            clearedByFiller: { outcome: "cleared", provenance: "document" },
            unknownOutcome: {
                outcome: "pending" as Cell["outcome"],
                provenance: "document",
            },
            unknownProvenance: {
                ...answered(text),
                provenance: "extracted" as Cell["provenance"],
            },
        };
        const bad: TableSpec = {
            id: "t",
            columns: [{ id: "m", header: "M", type: "text" }],
            rows: Object.entries(broken).map(([id, cell]) =>
                row(id, { m: cell }),
            ),
        };
        expect(
            validateTableSpec(bad).map((i) => [i.code, i.row_id, i.column_id]),
        ).toEqual(Object.keys(broken).map((id) => ["invalid_cell", id, "m"]));
        expect(cellInvariantError(broken.failedWithoutError)).toMatch(
            /error exactly when its outcome is failed/,
        );
    });

    it("accepts every well-formed outcome", () => {
        const good: TableSpec = {
            id: "t",
            columns: [{ id: "m", header: "M", type: "text" }],
            rows: [
                row("doc", {
                    m: {
                        ...answered({ kind: "text", text: "Survey" }),
                        evidence: [
                            { locator: "s1", quote: "A survey", page: 0 },
                        ],
                        reasoning: "Stated in the methods.",
                        unsure: true,
                        stale: true,
                    },
                }),
                row("meta", {
                    m: {
                        outcome: "not_reported",
                        provenance: "metadata",
                        evidence: [
                            { quote: "No method given", field: "abstract" },
                        ],
                    },
                }),
                row("failed", {
                    m: {
                        outcome: "failed",
                        provenance: "document",
                        error: "no text layer",
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
        ).toBe("zeta");
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
            'Methods,Methods — state\r\n"Survey of 1,200 adults in 2019.",document',
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
            'Smith 2020 — Alpha,system,2020,system,120,document,Article,document,true,document,"Survey, n = 1,200",document',
            "Jones 2018,system,2018-05,system,7,document,Book,document,false,document,,",
            "adams 2022,system,2022-01-15,system,,,Article,document,,,Interviews,document",
        ]);
    });

    it("writes evidence, reasoning and state beside the value, escaping formula-like text", () => {
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
                            provenance: "document",
                            reasoning: "=Nothing on sample size",
                        },
                    },
                },
                {
                    id: "answer",
                    cells: {
                        a: {
                            ...answered({ kind: "text", text: "120 adults" }),
                            unsure: true,
                            stale: true,
                            evidence: [
                                {
                                    locator: "s1",
                                    page: 3,
                                    quote: 'The study enrolled "120" participants.',
                                },
                                { quote: "120 adults", field: "abstract" },
                            ],
                        },
                    },
                },
                {
                    id: "failed",
                    cells: {
                        a: {
                            outcome: "failed",
                            provenance: "metadata",
                            error: "no abstract",
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
            "Not reported,,'=Nothing on sample size,not_reported; document",
        );
        expect(lines[3]).toBe(
            '120 adults,"""The study enrolled ""120"" participants."" (p. 4, s1)\n""120 adults"" (abstract)",,unsure; stale; document',
        );
        expect(lines[4]).toBe(",,,failed; no abstract; metadata");
    });
});

describe("anchor column", () => {
    it("prefers the declared anchor, then the first reference column, then the first column", () => {
        const columns: Column[] = [
            { id: "year", header: "Year", type: "number" },
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
            ref: { kind: "item", ...item, attachment: file },
        });
        expect(rowActions(spec, withFile)).toEqual(["reveal", "open"]);
        expect(rowActionTarget(withFile, "open")).toEqual({
            kind: "open_file",
            ref: file,
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
        expect(
            rowActions(
                spec,
                mkRow({
                    ref: {
                        kind: "annotation",
                        library_ref: "u",
                        library_id: 1,
                        zotero_key: "A",
                        attachment: file,
                    },
                    in_library: false,
                }),
            ),
        ).toEqual([]);
    });

    it("opens an attachment row itself and reveals it in the library", () => {
        const row = mkRow({
            ref: { kind: "attachment", ...file, parent_item: item },
        });
        expect(rowActions(spec, row)).toEqual(["reveal", "open"]);
        expect(rowActionTarget(row, "open")?.kind).toBe("open_file");
        expect(rowActionTarget(row, "reveal")?.ref.zotero_key).toBe("F");
    });

    it("opens an annotation in the reader and reveals its bibliographic item", () => {
        const annotation = { library_ref: "u", library_id: 1, zotero_key: "A" };
        const row = mkRow({
            ref: {
                kind: "annotation",
                ...annotation,
                attachment: file,
                parent_item: item,
            },
        });
        expect(rowPrimaryAction(row)).toBe("open");
        expect(rowActionTarget(row, "open")).toEqual({
            kind: "open_annotation",
            ref: annotation,
            attachment: file,
        });
        expect(rowActionTarget(row, "reveal")).toEqual({
            kind: "reveal_item",
            ref: item,
        });
        // Without a bibliographic item, the attachment is what there is to reveal.
        const standalone = mkRow({
            ref: { kind: "annotation", ...annotation, attachment: file },
        });
        expect(rowActionTarget(standalone, "reveal")?.ref).toEqual(file);
    });

    it("offers a context-file row only its file: neither in the library nor importable", () => {
        const contextFile = mkRow({
            id: "file",
            ref: { kind: "file", ext_key: "AB12CD34", label: "notes.pdf" },
        });
        expect(isRowInLibrary(contextFile)).toBe(false);
        expect(rowActions(spec, contextFile)).toEqual(["open"]);
        expect(rowActionTarget(contextFile, "open")).toEqual({
            kind: "open_external_file",
            ext_key: "AB12CD34",
        });
        expect(rowPrimaryAction(contextFile)).toBe("open");
    });

    it("lets a row narrow the table's verbs, and offers none without a ref", () => {
        const inLib = mkRow({
            ref: { kind: "item", ...item },
            actions: ["reveal"],
        });
        expect(rowActions(spec, inLib)).toEqual(["reveal"]);
        expect(rowActions(spec, mkRow({ in_library: true }))).toEqual([]);
        expect(rowPrimaryAction(mkRow({}))).toBeUndefined();
    });
});

describe("row types and expanded fields", () => {
    const typeColumn = {
        id: "_type",
        header: "Type",
        type: "select" as const,
        role: "row_type" as const,
        system: true as const,
    };
    const item = (id: string): Row => ({
        id,
        ref: { kind: "item", library_ref: "u", library_id: 1, zotero_key: id },
        cells: {},
    });
    const annotation: Row = {
        id: "a",
        ref: {
            kind: "annotation",
            library_ref: "u",
            library_id: 1,
            zotero_key: "A",
            attachment: { library_ref: "u", library_id: 1, zotero_key: "F" },
        },
        cells: {},
    };

    it("hides system columns until the table mixes row kinds, then shows the type column", () => {
        const uniform: TableSpec = {
            id: "t",
            columns: [
                { id: "ref", header: "Item", type: "reference" },
                typeColumn,
                { id: "_year", header: "Year", type: "date", system: true },
            ],
            rows: [item("K1"), item("K2")],
        };
        expect(defaultHiddenColumnIds(uniform)).toEqual(["_type", "_year"]);
        const mixed = { ...uniform, rows: [item("K1"), annotation] };
        expect(defaultHiddenColumnIds(mixed)).toEqual(["_year"]);
    });

    it("labels non-item rows by kind and leaves item types to the producer", () => {
        expect(rowTypeLabel(item("K"), undefined)).toBeUndefined();
        expect(
            rowTypeLabel(annotation, {
                kind: "annotation",
                annotation_type: "underline",
            }),
        ).toBe("Underline");
        expect(
            rowTypeLabel(
                {
                    id: "f",
                    ref: {
                        kind: "attachment",
                        library_ref: "u",
                        library_id: 1,
                        zotero_key: "F",
                    },
                    cells: {},
                },
                { kind: "reference", display_name: "x", content_kind: "pdf" },
            ),
        ).toBe("PDF");
        expect(
            rowTypeLabel(
                {
                    id: "e",
                    ref: {
                        kind: "external",
                        source: "openalex",
                        source_id: "W",
                    },
                    cells: {},
                },
                undefined,
            ),
        ).toBe("Search result");
        expect(
            rowTypeLabel(
                {
                    id: "x",
                    ref: { kind: "file", ext_key: "AB12CD34" },
                    cells: {},
                },
                undefined,
            ),
        ).toBe("Local file");
    });

    it("titles an annotation by what it has: passage, comment, or its place", () => {
        expect(
            annotationTitle({
                kind: "annotation",
                annotation_type: "highlight",
                text: "A passage",
                comment: "A note",
            }),
        ).toBe("A passage");
        expect(
            annotationTitle({
                kind: "annotation",
                annotation_type: "note",
                comment: "A note",
            }),
        ).toBe("A note");
        expect(
            annotationTitle({
                kind: "annotation",
                annotation_type: "image",
                page_label: "4",
            }),
        ).toBe("Area on p. 4");
        expect(annotationTitle({ kind: "annotation" })).toBe("Annotation");
    });

    it("shows a comment under the title only when the title is something else", () => {
        // A highlight's comment is a second voice under the passage…
        expect(
            annotationComment({
                kind: "annotation",
                annotation_type: "highlight",
                text: "A passage",
                comment: "A note",
            }),
        ).toBe("A note");
        // …a note's comment is already its title…
        expect(
            annotationComment({
                kind: "annotation",
                annotation_type: "note",
                text: "Selected text",
                comment: "A note",
            }),
        ).toBeUndefined();
        // …and so is a highlight's when it has no passage of its own.
        expect(
            annotationComment({
                kind: "annotation",
                annotation_type: "highlight",
                comment: "A note",
            }),
        ).toBeUndefined();
        // An area mark is titled by its place, so its comment is worth a line.
        expect(
            annotationComment({
                kind: "annotation",
                annotation_type: "image",
                comment: "Figure 2",
            }),
        ).toBe("Figure 2");
    });

    it("lists an annotation's parts as fields of their own and nothing for other cells", () => {
        expect(
            cellExpandedFields(
                answered({ kind: "reference", display_name: "x" }, "system"),
            ),
        ).toEqual([]);
        expect(cellExpandedFields(undefined)).toEqual([]);
        expect(
            cellExpandedFields(
                answered(
                    {
                        kind: "annotation",
                        annotation_type: "highlight",
                        text: "A passage",
                        comment: "A note",
                    },
                    "system",
                ),
            ).map((f) => [
                f.label,
                f.details.kind === "text" && f.details.text,
            ]),
        ).toEqual([
            ["Highlighted text", "A passage"],
            ["Comment", "A note"],
        ]);
    });
});

describe("anchor cells and row kinds", () => {
    const passage = answered(
        { kind: "annotation", text: "A passage" },
        "system",
    );
    const spec: TableSpec = {
        id: "t",
        columns: [{ id: "item", header: "Item", type: "reference" }],
        rows: [
            {
                id: "rK",
                ref: {
                    kind: "item",
                    library_ref: "u",
                    library_id: 1,
                    zotero_key: "K",
                },
                cells: { item: passage },
            },
            {
                id: "rA",
                ref: {
                    kind: "annotation",
                    library_ref: "u",
                    library_id: 1,
                    zotero_key: "A",
                    attachment: {
                        library_ref: "u",
                        library_id: 1,
                        zotero_key: "F",
                    },
                },
                cells: { item: passage },
            },
        ],
    };

    it("accepts an annotation value in a reference column only under an annotation ref", () => {
        const issues = validateTableSpec(spec);
        expect(issues.map((i) => [i.code, i.row_id])).toEqual([
            ["anchor_kind_mismatch", "rK"],
        ]);
    });

    it("sorts, filters and exports an annotation by its passage", () => {
        const cell = answered(
            {
                kind: "annotation",
                text: "Bold claim",
                comment: "Check this",
            },
            "system",
        );
        expect(cellSortKey(cell)).toBe("bold claim");
        expect(cellValueText(cell.value)).toBe("Bold claim — Check this");
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
        expect(
            cellSortKey(
                answered(
                    { kind: "annotation", comment: "Only a note" },
                    "system",
                ),
            ),
        ).toBe("only a note");
        expect(
            cellSortKey(answered({ kind: "annotation" }, "system")),
        ).toBeNull();
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

describe("coverage", () => {
    it("separates filled, not-reported, failed and metadata-only cells", () => {
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
                    cells: {
                        a: answered({ kind: "text", text: "x" }),
                        b: { outcome: "not_reported", provenance: "document" },
                    },
                },
                {
                    id: "r2",
                    status: "error",
                    cells: {
                        a: {
                            outcome: "failed",
                            provenance: "document",
                            error: "no text layer",
                        },
                        b: answered({ kind: "text", text: "y" }, "metadata"),
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
            metadataOnly: 1,
        });
        expect(isMetadataOnly(spec.rows[1].cells.b)).toBe(true);
        expect(isMetadataOnly(spec.rows[0].cells.a)).toBe(false);
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
