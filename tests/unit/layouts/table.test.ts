import { describe, expect, it } from "vitest";
import type { Citation } from "@beaver/agent-core/types/citations";
import {
    anchorColumn,
    cellIdFor,
    cellSortKey,
    cellValueText,
    citationKeysInTable,
    citationKeysInText,
    citationsByKey,
    columnAlign,
    filterRows,
    hasFixedVocabulary,
    isCellEmpty,
    isColumnSortable,
    isRowInLibrary,
    readSpec,
    stripCitationTags,
    summarizeCoverage,
    rowActions,
    rowIdFor,
    selectLabelsInColumn,
    sortRows,
    TABLE_SPEC_VERSION,
    toCsv,
    validateTableSpec,
    type Column,
    type Row,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";

function row(id: string, cells: Row["cells"]): Row {
    return { id, cells };
}

/**
 * The same spec with every filled cell attributed. A value without provenance
 * is itself an issue, so specs written for other checks say where they came
 * from rather than repeating that one everywhere.
 */
function attributed(spec: TableSpec): TableSpec {
    return {
        ...spec,
        rows: spec.rows.map((r) => ({
            ...r,
            cells: Object.fromEntries(
                Object.entries(r.cells).map(([id, cell]) => [
                    id,
                    cell.value
                        ? { ...cell, provenance: "extracted" as const }
                        : cell,
                ]),
            ),
        })),
    };
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
            ref: {
                value: {
                    kind: "reference",
                    display_name: "Smith 2020",
                    subtitle: "Alpha",
                },
            },
            year: { value: { kind: "date", value: "2020" } },
            cites: { value: { kind: "number", value: 120 } },
            type: { value: { kind: "select", label: "Article" } },
            oa: { value: { kind: "boolean", value: true } },
            methods: { value: { kind: "text", text: "Survey, n = 1,200" } },
        }),
        row("b", {
            ref: { value: { kind: "reference", display_name: "Jones 2018" } },
            year: { value: { kind: "date", value: "2018-05" } },
            cites: { value: { kind: "number", value: 7 } },
            type: { value: { kind: "select", label: "Book" } },
            oa: { value: { kind: "boolean", value: false } },
        }),
        row("c", {
            ref: { value: { kind: "reference", display_name: "adams 2022" } },
            year: { value: { kind: "date", value: "2022-01-15" } },
            type: { value: { kind: "select", label: "Article" } },
            methods: { value: { kind: "text", text: "Interviews" } },
        }),
    ],
};

describe("ids", () => {
    it("derives stable row ids from the reference", () => {
        expect(
            rowIdFor({
                kind: "item",
                library_id: 1,
                zotero_key: "ABCD1234",
                library_ref: "u",
            }),
        ).toBe("item:u:ABCD1234");
        expect(
            rowIdFor({ kind: "item", library_id: 3, zotero_key: "ABCD1234" }),
        ).toBe("item:3:ABCD1234");
        expect(
            rowIdFor({
                kind: "external",
                source: "openalex",
                source_id: "W123",
            }),
        ).toBe("ext:openalex:W123");
        expect(cellIdFor("ext:openalex:W123", "year")).toBe(
            "ext:openalex:W123/year",
        );
    });

    it("identifies a context-file row by its external key", () => {
        expect(
            rowIdFor({ kind: "file", ext_key: "AB12CD34", label: "notes.pdf" }),
        ).toBe("file:AB12CD34");
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

    it("keeps a role, flag or provenance it does not recognise", () => {
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
                            value: { kind: "text", text: "x" },
                            flag: "disputed",
                            provenance: "delegated",
                        },
                    },
                },
            ],
        };
        const result = readSpec(future);
        expect(result.ok).toBe(true);
        // The spec comes back byte-for-byte, so an old client can hand a stored
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
    it("fixes the option set of a screening decision and no other role", () => {
        expect(
            hasFixedVocabulary({
                id: "d",
                header: "Decision",
                type: "select",
                role: "screening_decision",
            }),
        ).toBe(true);
        expect(
            hasFixedVocabulary({
                id: "q",
                header: "Quality",
                type: "select",
                role: "quality",
            }),
        ).toBe(false);
        expect(
            hasFixedVocabulary({ id: "t", header: "T", type: "select" }),
        ).toBe(false);
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

    it("reads a missing value as an empty cell", () => {
        expect(isCellEmpty(undefined)).toBe(true);
        expect(isCellEmpty({ status: "pending" })).toBe(true);
        expect(isCellEmpty({ value: { kind: "boolean", value: false } })).toBe(
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

    it("sorts text case-insensitively", () => {
        expect(
            cellSortKey({ value: { kind: "reference", display_name: "Zed" } }),
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

describe("citations", () => {
    const citation: Citation = {
        citation_id: "c1",
        requested_ref: {
            kind: "zotero",
            library_id: 1,
            zotero_key: "ABCD1234",
            loc: { kind: "sentence", raw: "s12", value: "12" } as any,
        },
        resolved_ref: {
            kind: "zotero",
            library_id: 1,
            zotero_key: "ABCD1234",
            library_ref: "u",
            loc: { kind: "sentence", raw: "s12", value: "12" } as any,
        },
        raw_tag: '<citation id="1-ABCD1234" loc="s12"/>',
    };

    it("finds citation keys in text", () => {
        expect(
            citationKeysInText(
                'Surveys <citation id="1-ABCD1234" loc="s12"/> and <citation external_id="W1"/>.',
            ),
        ).toEqual(["zotero:1-ABCD1234:s12", "external:W1"]);
        expect(citationKeysInText("no tags")).toEqual([]);
    });

    it("collects keys from values and details, de-duplicated", () => {
        const withCites: TableSpec = {
            ...spec,
            rows: [
                row("a", {
                    methods: {
                        value: {
                            kind: "text",
                            text: 'x <citation id="1-ABCD1234" loc="s12"/>',
                        },
                        details: {
                            kind: "list",
                            items: [
                                'y <citation id="1-ABCD1234" loc="s12"/>',
                                'z <citation external_id="W1"/>',
                            ],
                        },
                    },
                }),
            ],
        };
        expect(citationKeysInTable(withCites)).toEqual([
            "zotero:1-ABCD1234:s12",
            "external:W1",
        ]);
    });

    it("indexes citation metadata under requested, resolved and raw-tag keys", () => {
        const byKey = citationsByKey([citation]);
        expect(byKey["zotero:1-ABCD1234:s12"]).toBe(citation);
        expect(byKey["zotero:u-ABCD1234:s12"]).toBe(citation);
    });
});

describe("validateTableSpec", () => {
    it("accepts a well-formed spec", () => {
        expect(validateTableSpec(attributed(spec))).toEqual([]);
    });

    it("reports duplicate ids, unknown columns and sort columns", () => {
        const bad: TableSpec = {
            id: "t",
            columns: [
                { id: "a", header: "A", type: "text" },
                { id: "a", header: "A2", type: "text" },
            ],
            rows: [row("r", { zzz: {} }), row("r", {})],
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
            rows: [
                row("r", {
                    n: {
                        value: { kind: "text", text: "12" },
                        provenance: "extracted",
                    },
                }),
            ],
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
                    type: {
                        value: { kind: "select", label: "Preprint" },
                        provenance: "asserted",
                    },
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
                    type: {
                        value: { kind: "select", label: "Preprint" },
                        provenance: "asserted",
                    },
                }),
            ],
        };
        expect(validateTableSpec(free)).toEqual([]);
    });

    it("tells a fixed-vocabulary violation apart from an open select's new label", () => {
        const columns: Column[] = [
            {
                id: "decision",
                header: "Decision",
                type: "select",
                role: "screening_decision",
                options: [{ label: "Include" }, { label: "Exclude" }],
            },
        ];
        const decided = (label: string): TableSpec => ({
            id: "t",
            columns,
            rows: [
                row("r", {
                    decision: {
                        value: { kind: "select", label },
                        provenance: "asserted",
                        details: { kind: "text", text: "Wrong population" },
                    },
                }),
            ],
        });
        expect(validateTableSpec(decided("Maybe"))).toMatchObject([
            {
                code: "fixed_vocabulary_violation",
                row_id: "r",
                column_id: "decision",
            },
        ]);
        expect(validateTableSpec(decided("Exclude"))).toEqual([]);
    });

    it("reports a screening decision that carries no reason", () => {
        const columns: Column[] = [
            {
                id: "decision",
                header: "Decision",
                type: "select",
                role: "screening_decision",
            },
        ];
        const bare: TableSpec = {
            id: "t",
            columns,
            rows: [
                row("r", {
                    decision: {
                        value: { kind: "select", label: "Exclude" },
                        provenance: "asserted",
                    },
                }),
            ],
        };
        expect(validateTableSpec(bare)).toMatchObject([
            {
                code: "missing_decision_details",
                row_id: "r",
                column_id: "decision",
            },
        ]);
        expect(
            validateTableSpec({
                ...bare,
                rows: [
                    row("r", {
                        decision: {
                            value: { kind: "select", label: "Exclude" },
                            provenance: "asserted",
                            details: { kind: "text", text: "Not a trial" },
                        },
                    }),
                ],
            }),
        ).toEqual([]);
    });

    it("reports a value that does not say where it came from", () => {
        const unattributed: TableSpec = {
            id: "t",
            columns: [{ id: "m", header: "M", type: "text" }],
            rows: [
                row("r1", { m: { value: { kind: "text", text: "Survey" } } }),
                // An empty and a pending cell have nothing to attribute.
                row("r2", { m: {} }),
                row("r3", { m: { status: "pending" } }),
            ],
        };
        expect(validateTableSpec(unattributed)).toMatchObject([
            { code: "missing_provenance", row_id: "r1", column_id: "m" },
        ]);
        expect(validateTableSpec(attributed(unattributed))).toEqual([]);
    });

    it("reports citation tags without matching metadata", () => {
        const cited: TableSpec = {
            id: "t",
            columns: [{ id: "m", header: "M", type: "text" }],
            rows: [
                row("r", {
                    m: {
                        value: {
                            kind: "text",
                            text: 'see <citation external_id="W9"/>',
                        },
                        provenance: "extracted",
                    },
                }),
            ],
        };
        expect(validateTableSpec(cited)).toMatchObject([
            { code: "unresolved_citation", row_id: "r", column_id: "m" },
        ]);
        expect(
            validateTableSpec({
                ...cited,
                citations: [
                    {
                        citation_id: "x",
                        requested_ref: { kind: "external", external_id: "W9" },
                    } as Citation,
                ],
            }),
        ).toEqual([]);
    });

    it("checks the citations behind a non-text cell, which live in its details", () => {
        const evidence: TableSpec = {
            id: "t",
            columns: [{ id: "n", header: "Sample", type: "number" }],
            rows: [
                row("r", {
                    n: {
                        value: { kind: "number", value: 1200 },
                        provenance: "extracted",
                        details: {
                            kind: "text",
                            text: 'reported in <citation external_id="W9"/>',
                        },
                    },
                }),
            ],
        };
        expect(validateTableSpec(evidence)).toMatchObject([
            { code: "unresolved_citation", row_id: "r", column_id: "n" },
        ]);
        expect(
            validateTableSpec({
                ...evidence,
                citations: [
                    {
                        citation_id: "x",
                        requested_ref: { kind: "external", external_id: "W9" },
                    } as Citation,
                ],
            }),
        ).toEqual([]);
    });
});

describe("plain text", () => {
    const cited =
        'Survey of 1,200 adults <citation id="1-ABCD1234" loc="s12"/> in 2019.';
    const citedSpec: TableSpec = {
        id: "t",
        columns: [{ id: "m", header: "Methods", type: "text" }],
        rows: [
            row("a", {
                m: {
                    value: { kind: "text", text: cited },
                    provenance: "extracted",
                },
            }),
        ],
    };

    it("leaves citation markup out of the text form of a value", () => {
        expect(cellValueText({ kind: "text", text: cited })).toBe(
            "Survey of 1,200 adults in 2019.",
        );
        expect(stripCitationTags("nothing to strip")).toBe("nothing to strip");
    });

    it("sorts on the prose rather than on the markup in front of it", () => {
        expect(
            cellSortKey({
                value: {
                    kind: "text",
                    text: '<citation external_id="W1"/>Zeta',
                },
            }),
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
            'Methods\r\n"Survey of 1,200 adults in 2019."',
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
            "Reference,Year,Citations,Type,Open access,Methods",
            'Smith 2020 — Alpha,2020,120,Article,true,"Survey, n = 1,200"',
            "Jones 2018,2018-05,7,Book,false,",
            "adams 2022,2022-01-15,,Article,,Interviews",
        ]);
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

    it("treats an item ref, an explicit flag and a library copy as in-library", () => {
        expect(
            isRowInLibrary(
                mkRow({
                    ref: {
                        kind: "item",
                        library_id: 1,
                        zotero_key: "K",
                    },
                }),
            ),
        ).toBe(true);
        expect(isRowInLibrary(mkRow({}))).toBe(false);
        expect(isRowInLibrary(mkRow({ in_library: true }))).toBe(true);
        expect(
            isRowInLibrary(
                mkRow({
                    cells: {
                        item: {
                            value: {
                                kind: "reference",
                                display_name: "Smith",
                                library_items: [
                                    { library_id: 1, zotero_key: "K" },
                                ],
                            },
                        },
                    },
                }),
            ),
        ).toBe(true);
    });

    it("offers import only off-library and reveal/open only in-library", () => {
        const external = mkRow({
            id: "ext",
            ref: { kind: "external", source: "openalex", source_id: "W1" },
        });
        expect(rowActions(spec, external)).toEqual(["import"]);
        expect(rowActions(spec, { ...external, in_library: true })).toEqual([
            "reveal",
            "open",
        ]);
    });

    it("offers nothing on a context-file row: neither in the library nor importable", () => {
        const file = mkRow({
            id: "file",
            ref: { kind: "file", ext_key: "AB12CD34", label: "notes.pdf" },
        });
        expect(isRowInLibrary(file)).toBe(false);
        expect(rowActions(spec, file)).toEqual([]);
    });

    it("lets a row narrow the table's verbs, and offers none without a ref", () => {
        const inLib = mkRow({
            ref: { kind: "item", library_id: 1, zotero_key: "K" },
            actions: ["reveal"],
        });
        expect(rowActions(spec, inLib)).toEqual(["reveal"]);
        expect(rowActions(spec, mkRow({ in_library: true }))).toEqual([]);
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
    it("separates filled, not-reported, pending and failed cells", () => {
        const spec: TableSpec = {
            id: "t",
            columns: [
                { id: "a", header: "A", type: "text" },
                { id: "b", header: "B", type: "text" },
            ],
            rows: [
                {
                    id: "r1",
                    cells: {
                        a: { value: { kind: "text", text: "x" } },
                        b: {},
                    },
                },
                {
                    id: "r2",
                    status: "error",
                    cells: {
                        a: { status: "pending" },
                        b: { status: "error", error: "no text layer" },
                    },
                },
            ],
        };
        expect(summarizeCoverage(spec)).toEqual({
            rows: 2,
            cells: 4,
            filled: 1,
            empty: 1,
            pending: 1,
            error: 1,
            errorRows: 1,
        });
    });

    it("counts only the rows it is given, so a footer can report the filtered view", () => {
        const spec: TableSpec = {
            id: "t",
            columns: [{ id: "a", header: "A", type: "text" }],
            rows: [
                {
                    id: "r1",
                    cells: { a: { value: { kind: "text", text: "x" } } },
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
