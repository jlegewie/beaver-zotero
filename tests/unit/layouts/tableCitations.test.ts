import { describe, expect, it } from "vitest";
import { collectCitationKeys } from "@beaver/agent-core/citations/atoms";
import { parseRawCitationAttributes } from "@beaver/agent-core/citations/citationGrammar";
import {
    computeCitationKeyFromAttrs,
    type Citation,
    getCitationBoundingBoxes,
    getCitationPages,
} from "@beaver/agent-core/types/citations";
import type { Cell, Evidence, Row } from "@beaver/agent-core/layouts/table";
import {
    cellCitations,
    citationForEvidence,
    rowReference,
} from "@beaver/agent-core/layouts/tableCitations";

const reference: Cell = {
    outcome: "answered",
    provenance: "system",
    value: {
        kind: "reference",
        display_name: "Smith et al. 2023",
        title: "Sleep and memory",
        formatted_citation:
            "Smith, J., & Lee, K. (2023). Sleep and memory. Journal of Sleep, 4(2), 1–20.",
        item_type: "journalArticle",
    },
};

const pdfEvidence: Evidence = {
    locator: "s243-s250",
    quote: "We enrolled 120 adults aged 18 to 65.",
    page: 4,
    boxes: [
        [72, 310, 540, 324],
        [72, 326, 300, 340],
    ],
};

const abstractEvidence: Evidence = {
    quote: "A sample of 120 adults",
    field: "abstract",
};

const paper: Row = {
    id: "r7f3a9c2b1d",
    ref: {
        kind: "item",
        library_ref: "u",
        library_id: 1,
        zotero_key: "ITEM0001",
        attachment: { library_ref: "u", library_id: 1, zotero_key: "ATT00001" },
    },
    cells: {
        _reference: reference,
        sample: {
            outcome: "answered",
            provenance: "document",
            value: { kind: "text", text: "120 adults" },
            evidence: [pdfEvidence],
        },
        sample_meta: {
            outcome: "answered",
            provenance: "metadata",
            value: { kind: "text", text: "120 adults" },
            evidence: [abstractEvidence],
        },
    },
};

/** The key the chat's markdown renderer derives from a citation tag. */
function keyOfTag(tag: string): string {
    const attrs = tag.match(/^<citation\b([^>]*?)\/?>/i)?.[1] ?? "";
    return computeCitationKeyFromAttrs(parseRawCitationAttributes(attrs));
}

function expectTagResolves(citation: Citation | null) {
    expect(citation?.raw_tag).toBeTruthy();
    expect(collectCitationKeys(citation!)).toContain(
        keyOfTag(citation!.raw_tag!),
    );
}

describe("citationForEvidence", () => {
    it("cites the row's attachment at the located sentences, as the chat would", () => {
        const loc = { kind: "sentence", value: "243-250", raw: "s243-s250" };
        const attachment = {
            kind: "zotero",
            library_id: 1,
            library_ref: "u",
            zotero_key: "ATT00001",
            loc,
        };
        const expected: Citation = {
            citation_id: expect.stringMatching(
                /^table:r7f3a9c2b1d:u-ATT00001:s243-s250:[0-9a-f]{8}$/,
            ),
            requested_ref: attachment as Citation["requested_ref"],
            resolved_ref: attachment as Citation["resolved_ref"],
            parent_ref: {
                kind: "zotero",
                library_id: 1,
                library_ref: "u",
                zotero_key: "ITEM0001",
            },
            citation_type: "attachment",
            display_name: "Smith et al. 2023",
            formatted_citation:
                "Smith, J., & Lee, K. (2023). Sleep and memory. Journal of Sleep, 4(2), 1–20.",
            item_type: "journalArticle",
            preview: "We enrolled 120 adults aged 18 to 65.",
            pages: [5],
            locations: [
                {
                    part_id: "s243-s250",
                    page_idx: 4,
                    boxes: [
                        [72, 310, 540, 324],
                        [72, 326, 300, 340],
                    ],
                },
            ],
            raw_tag: '<citation id="u-ATT00001" loc="s243-s250"/>',
        };
        const citation = citationForEvidence(paper, pdfEvidence);
        expect(citation).toEqual(expected);
        expectTagResolves(citation);
    });

    it("cites the item itself for metadata evidence, without a page or location", () => {
        const citation = citationForEvidence(paper, abstractEvidence);
        expect(citation).toEqual({
            citation_id: expect.stringMatching(
                /^table:r7f3a9c2b1d:u-ITEM0001:abstract:[0-9a-f]{8}$/,
            ),
            requested_ref: {
                kind: "zotero",
                library_id: 1,
                library_ref: "u",
                zotero_key: "ITEM0001",
            },
            resolved_ref: {
                kind: "zotero",
                library_id: 1,
                library_ref: "u",
                zotero_key: "ITEM0001",
            },
            citation_type: "item",
            display_name: "Smith et al. 2023",
            formatted_citation:
                "Smith, J., & Lee, K. (2023). Sleep and memory. Journal of Sleep, 4(2), 1–20.",
            item_type: "journalArticle",
            preview: "A sample of 120 adults",
            raw_tag: '<citation id="u-ITEM0001"/>',
        });
        expectTagResolves(citation);
    });

    it("cites the item at the locator when the row names no attachment", () => {
        const { attachment: _attachment, ...item } = paper.ref as Extract<
            Row["ref"],
            { kind: "item" }
        >;
        const row: Row = { ...paper, ref: item };
        const citation = citationForEvidence(row, pdfEvidence);
        expect(citation).toMatchObject({
            resolved_ref: { kind: "zotero", zotero_key: "ITEM0001" },
            citation_type: "item",
            raw_tag: '<citation id="u-ITEM0001" loc="s243-s250"/>',
        });
        expect(citation?.parent_ref).toBeUndefined();
        expectTagResolves(citation);
    });

    it("names a row from another device by its library_ref, with the unresolved rowid", () => {
        const row: Row = {
            ...paper,
            ref: {
                kind: "item",
                library_ref: "g42",
                zotero_key: "ITEM0001",
                attachment: { library_ref: "g42", zotero_key: "ATT00001" },
            },
        };
        const citation = citationForEvidence(row, pdfEvidence);
        expect(citation?.resolved_ref).toMatchObject({
            library_id: 0,
            library_ref: "g42",
            zotero_key: "ATT00001",
        });
        expect(citation?.raw_tag).toBe(
            '<citation id="g42-ATT00001" loc="s243-s250"/>',
        );
        expectTagResolves(citation);
    });

    it("cites an annotation row's attachment, under the annotation's item", () => {
        const row: Row = {
            id: "rann",
            ref: {
                kind: "annotation",
                library_ref: "u",
                library_id: 1,
                zotero_key: "ANNO0001",
                attachment: {
                    library_ref: "u",
                    library_id: 1,
                    zotero_key: "ATT00001",
                },
                parent_item: {
                    library_ref: "u",
                    library_id: 1,
                    zotero_key: "ITEM0001",
                },
            },
            cells: {
                anchor: {
                    outcome: "answered",
                    provenance: "system",
                    value: {
                        kind: "annotation",
                        text: "highlighted",
                        source_display_name: "Lee 2019",
                    },
                },
            },
        };
        const citation = citationForEvidence(row, {
            locator: "s12",
            quote: "q",
        });
        expect(citation).toMatchObject({
            resolved_ref: { zotero_key: "ATT00001", loc: { raw: "s12" } },
            parent_ref: { zotero_key: "ITEM0001" },
            citation_type: "attachment",
            // Named by the annotation's source, so the marker has a label.
            display_name: "Lee 2019",
        });
        expectTagResolves(citation);
    });

    it("cites an external work by its source id", () => {
        const row: Row = {
            id: "rext",
            ref: {
                kind: "external",
                source: "openalex",
                source_id: "W2741809807",
            },
            cells: {
                _reference: {
                    ...reference,
                    value: { kind: "reference", display_name: "Lee 2021" },
                },
            },
        };
        const citation = citationForEvidence(row, {
            locator: "p3",
            quote: "Results",
        });
        expect(citation).toEqual({
            citation_id: expect.stringMatching(
                /^table:rext:openalex:W2741809807:p3:/,
            ),
            requested_ref: {
                kind: "external",
                external_id: "W2741809807",
                source: "openalex",
                loc: { kind: "paragraph", value: "3", raw: "p3" },
            },
            resolved_ref: {
                kind: "external",
                external_id: "W2741809807",
                source: "openalex",
                loc: { kind: "paragraph", value: "3", raw: "p3" },
            },
            citation_type: "external_reference",
            display_name: "Lee 2021",
            preview: "Results",
            locations: [{ part_id: "p3" }],
            raw_tag: '<citation external_id="W2741809807" loc="p3"/>',
        });
        expectTagResolves(citation);
    });

    it("cites a context file by its external key", () => {
        const row: Row = {
            id: "rfile",
            ref: { kind: "file", ext_key: "AB12CD34", label: "notes.pdf" },
            cells: {},
        };
        const citation = citationForEvidence(row, {
            locator: "s3",
            quote: "Field notes",
            page: 0,
        });
        expect(citation).toMatchObject({
            requested_ref: { kind: "external_file", ext_key: "AB12CD34" },
            citation_type: "external_file",
            pages: [1],
            locations: [{ part_id: "s3", page_idx: 0 }],
            raw_tag: '<citation id="ext-AB12CD34" loc="s3"/>',
        });
        expectTagResolves(citation);
    });

    it("names a file row by its label, else its key, without a reference cell", () => {
        const labelled = citationForEvidence(
            {
                id: "rf",
                ref: { kind: "file", ext_key: "EXT1", label: "notes.pdf" },
                cells: {},
            },
            { quote: "q", locator: "s1" },
        );
        expect(labelled?.display_name).toBe("notes.pdf");
        const bare = citationForEvidence(
            { id: "rf", ref: { kind: "file", ext_key: "EXT1" }, cells: {} },
            { quote: "q", locator: "s1" },
        );
        expect(bare?.display_name).toBe("EXT1");
    });

    it("cites nothing for a row without a ref", () => {
        expect(
            citationForEvidence({ id: "r", cells: {} }, pdfEvidence),
        ).toBeNull();
    });
});

describe("cell citations", () => {
    const twoPassages: Row = {
        ...paper,
        cells: {
            ...paper.cells,
            sample: {
                ...paper.cells.sample,
                evidence: [pdfEvidence, { quote: "No locator here" }],
            },
        },
    };

    it("yields one citation per evidence entry, each with its own id", () => {
        expect(
            cellCitations(twoPassages, "sample").map((c) => c.citation_id),
        ).toEqual([
            expect.stringMatching(
                /^table:r7f3a9c2b1d:u-ATT00001:s243-s250:[0-9a-f]{8}$/,
            ),
            expect.stringMatching(
                /^table:r7f3a9c2b1d:u-ATT00001:doc:[0-9a-f]{8}$/,
            ),
        ]);
        expect(cellCitations(paper, "missing")).toEqual([]);
    });

    it("keeps citations of different sources apart under one row id", () => {
        const moved: Row = {
            ...paper,
            ref: {
                ...(paper.ref as Extract<Row["ref"], { kind: "item" }>),
                zotero_key: "ITEM0002",
                attachment: {
                    library_id: 1,
                    library_ref: "u",
                    zotero_key: "ATT00002",
                },
            },
        };
        const ids = [paper, moved].flatMap((row) =>
            cellCitations(row, "sample").map((c) => c.citation_id),
        );
        expect(new Set(ids).size).toBe(ids.length);
        expect(
            ids.some((id) =>
                id.startsWith("table:r7f3a9c2b1d:u-ATT00002:s243-s250:"),
            ),
        ).toBe(true);
    });

    it("keeps quotes at one locator apart, each with its own quote and highlight", () => {
        const twoQuotes: Row = {
            ...paper,
            cells: {
                first: {
                    outcome: "answered",
                    provenance: "document",
                    value: { kind: "text", text: "a" },
                    evidence: [
                        {
                            locator: "s5",
                            quote: "one part",
                            page: 1,
                            boxes: [[1, 1, 2, 2]],
                        },
                    ],
                },
                second: {
                    outcome: "answered",
                    provenance: "document",
                    value: { kind: "text", text: "b" },
                    evidence: [
                        {
                            locator: "s5",
                            quote: "another part",
                            page: 1,
                            boxes: [[3, 3, 4, 4]],
                        },
                    ],
                },
            },
        };
        const [first] = cellCitations(twoQuotes, "first");
        const [second] = cellCitations(twoQuotes, "second");
        expect(first.citation_id).not.toBe(second.citation_id);
        expect([first.preview, second.preview]).toEqual([
            "one part",
            "another part",
        ]);
        expect(first.locations?.[0].boxes).toEqual([[1, 1, 2, 2]]);
        expect(second.locations?.[0].boxes).toEqual([[3, 3, 4, 4]]);
    });

    it("gives corrected highlights of one quote a new id", () => {
        const at = (boxes: [number, number, number, number][]): Row => ({
            ...paper,
            cells: {
                sample: {
                    ...paper.cells.sample,
                    evidence: [{ ...pdfEvidence, boxes }],
                },
            },
        });
        const [before] = cellCitations(at([[1, 1, 2, 2]]), "sample");
        const [after] = cellCitations(at([[5, 5, 6, 6]]), "sample");
        expect(before.citation_id).not.toBe(after.citation_id);
    });

    it("takes the page from a page locator when the evidence names no page", () => {
        const [citation] = cellCitations(
            {
                ...paper,
                cells: {
                    paged: {
                        outcome: "answered",
                        provenance: "document",
                        value: { kind: "text", text: "x" },
                        evidence: [{ quote: "q", locator: "page12" }],
                    },
                },
            },
            "paged",
        );
        expect(getCitationPages(citation)).toEqual([12]);
    });

    it("takes the page from a page-scoped sentence locator", () => {
        const at = (locator: string) =>
            cellCitations(
                {
                    ...paper,
                    cells: {
                        c: {
                            outcome: "answered",
                            provenance: "document",
                            value: { kind: "text", text: "x" },
                            evidence: [{ quote: "q", locator }],
                        },
                    },
                },
                "c",
            )[0];
        expect(getCitationPages(at("s5.6"))).toEqual([5]);
        expect(getCitationPages(at("s5.6-s6.2"))).toEqual([5]);
        // A document-scoped id names no page.
        expect(getCitationPages(at("s243"))).toEqual([]);
    });

    it("cites the parent item for metadata evidence on attachment and annotation rows", () => {
        const parent = {
            library_ref: "u",
            library_id: 1,
            zotero_key: "ITEM0001",
        };
        const attachmentRow: Row = {
            id: "ra",
            ref: {
                kind: "attachment",
                library_ref: "u",
                library_id: 1,
                zotero_key: "ATT00001",
                parent_item: parent,
            },
            cells: {},
        };
        const annotationRow: Row = {
            id: "rn",
            ref: {
                kind: "annotation",
                library_ref: "u",
                library_id: 1,
                zotero_key: "ANNO0001",
                attachment: {
                    library_ref: "u",
                    library_id: 1,
                    zotero_key: "ATT00001",
                },
                parent_item: parent,
            },
            cells: {},
        };
        attachmentRow.cells._reference = {
            outcome: "answered",
            provenance: "system",
            value: {
                kind: "reference",
                display_name: "Page",
                item_type: "attachment",
                content_kind: "snapshot",
            },
        };
        for (const row of [attachmentRow, annotationRow]) {
            const metadata = citationForEvidence(row, {
                quote: "q",
                field: "abstract",
            });
            expect(metadata).toMatchObject({
                resolved_ref: { zotero_key: "ITEM0001" },
                citation_type: "item",
            });
            // Not routed into the snapshot the row is.
            expect(metadata?.content_kind).toBeUndefined();
            expect(metadata?.item_type).toBeUndefined();
            expect(
                citationForEvidence(row, { quote: "q", locator: "s3" }),
            ).toMatchObject({
                resolved_ref: { zotero_key: "ATT00001" },
                citation_type: "attachment",
            });
        }
    });

    it("highlights boxes on the page a page locator names", () => {
        const [citation] = cellCitations(
            {
                ...paper,
                cells: {
                    boxed: {
                        outcome: "answered",
                        provenance: "document",
                        value: { kind: "text", text: "x" },
                        evidence: [
                            {
                                quote: "q",
                                locator: "page12",
                                boxes: [[1, 2, 3, 4]],
                            },
                        ],
                    },
                },
            },
            "boxed",
        );
        expect(getCitationBoundingBoxes(citation)).toEqual([
            expect.objectContaining({ page: 12 }),
        ]);
    });

    it("keeps highlight boxes of page evidence without a locator", () => {
        const [citation] = cellCitations(
            {
                ...paper,
                cells: {
                    boxed: {
                        outcome: "answered",
                        provenance: "document",
                        value: { kind: "text", text: "x" },
                        evidence: [
                            { quote: "q", page: 3, boxes: [[1, 2, 3, 4]] },
                        ],
                    },
                },
            },
            "boxed",
        );
        expect(getCitationBoundingBoxes(citation)).toEqual([
            expect.objectContaining({
                page: 4,
                bboxes: [expect.objectContaining({ l: 1, t: 2, r: 3, b: 4 })],
            }),
        ]);
    });

    it("keeps evidence of different cells apart, each with its own quote", () => {
        const pages: Row = {
            ...paper,
            cells: {
                first: {
                    outcome: "answered",
                    provenance: "document",
                    value: { kind: "text", text: "a" },
                    evidence: [{ quote: "first quote", page: 2 }],
                },
                second: {
                    outcome: "answered",
                    provenance: "document",
                    value: { kind: "text", text: "b" },
                    evidence: [{ quote: "second quote", page: 7 }],
                },
                field_a: {
                    outcome: "answered",
                    provenance: "metadata",
                    value: { kind: "text", text: "c" },
                    evidence: [{ quote: "one sentence", field: "abstract" }],
                },
                field_b: {
                    outcome: "answered",
                    provenance: "metadata",
                    value: { kind: "text", text: "d" },
                    evidence: [
                        { quote: "another sentence", field: "abstract" },
                    ],
                },
            },
        };
        const [first] = cellCitations(pages, "first");
        const [second] = cellCitations(pages, "second");
        expect(first.citation_id).not.toBe(second.citation_id);
        expect(first.raw_tag).toBe('<citation id="u-ATT00001" loc="page3"/>');
        expect(second.raw_tag).toBe('<citation id="u-ATT00001" loc="page8"/>');
        expect(keyOfTag(first.raw_tag!)).not.toBe(keyOfTag(second.raw_tag!));
        expectTagResolves(first);
        const [fieldA] = cellCitations(pages, "field_a");
        const [fieldB] = cellCitations(pages, "field_b");
        expect(fieldA.citation_id).not.toBe(fieldB.citation_id);
        expect([fieldA.preview, fieldB.preview]).toEqual([
            "one sentence",
            "another sentence",
        ]);
        // The same evidence is the same citation wherever it appears.
        expect(cellCitations(pages, "first")[0].citation_id).toBe(
            first.citation_id,
        );
    });

    it("reads the reference from the reference column, else any reference cell", () => {
        expect(rowReference(paper)?.display_name).toBe("Smith et al. 2023");
        const elsewhere: Row = { id: "r", cells: { title: reference } };
        expect(rowReference(elsewhere)?.display_name).toBe("Smith et al. 2023");
        expect(rowReference({ id: "r", cells: {} })).toBeUndefined();
    });
});
