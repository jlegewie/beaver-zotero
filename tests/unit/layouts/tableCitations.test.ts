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
    document: "u-ATT00001",
    locator: "s243-s250",
    quote: "We enrolled 120 adults aged 18 to 65.",
    page: 4,
    boxes: [
        [72, 310, 540, 324],
        [72, 326, 300, 340],
    ],
};

const paper: Row = {
    id: "r7f3a9c2b1d",
    ref: {
        kind: "item",
        library_ref: "u",
        library_id: 1,
        zotero_key: "ITEM0001",
    },
    documents: ["u-ATT00001"],
    cells: {
        _reference: reference,
        sample: {
            outcome: "answered",
            provenance: "model",
            documents: ["u-ATT00001"],
            value: { kind: "text", text: "120 adults" },
            evidence: [pdfEvidence],
        },
    },
};

/** A filler answer read from the paper's attachment, resting on `evidence`. */
function read(evidence: Evidence[], text = "x"): Cell {
    return {
        outcome: "answered",
        provenance: "model",
        documents: [...new Set(evidence.map((entry) => entry.document))],
        value: { kind: "text", text },
        evidence,
    };
}

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
    it("cites the evidence's document at the located sentences, as the chat would", () => {
        const loc = { kind: "sentence", value: "243-250", raw: "s243-s250" };
        // A document id names its library portably; the row's rowid stands
        // for it in the same library.
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

    it("cites the document the evidence names, not the one the row names now", () => {
        // The row moved on to another attachment; the passage is still in the first.
        const moved: Row = { ...paper, documents: ["u-ATT00002"] };
        const citation = citationForEvidence(moved, pdfEvidence);
        expect(citation).toMatchObject({
            resolved_ref: { kind: "zotero", zotero_key: "ATT00001" },
            parent_ref: { zotero_key: "ITEM0001" },
            citation_type: "attachment",
            raw_tag: '<citation id="u-ATT00001" loc="s243-s250"/>',
        });
        // …and a row that names no document still cites the passage's.
        const { documents: _documents, ...unnamed } = paper;
        expect(citationForEvidence(unnamed, pdfEvidence)?.resolved_ref).toMatchObject({
            zotero_key: "ATT00001",
        });
        expectTagResolves(citation);
    });

    it("names a row from another device by its library_ref, with the unresolved rowid", () => {
        const row: Row = {
            ...paper,
            ref: {
                kind: "item",
                library_ref: "g42",
                zotero_key: "ITEM0001",
            },
            documents: ["g42-ATT00001"],
        };
        const citation = citationForEvidence(row, { ...pdfEvidence, document: "g42-ATT00001" });
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
            document: "u-ATT00001",
            locator: "s12",
            quote: "q",
        });
        expect(citation).toMatchObject({
            // The annotation row knows its attachment's rowid, so it keeps it.
            resolved_ref: { library_id: 1, zotero_key: "ATT00001", loc: { raw: "s12" } },
            parent_ref: { zotero_key: "ITEM0001" },
            citation_type: "attachment",
            // Named by the annotation's source, so the marker has a label.
            display_name: "Lee 2019",
        });
        expectTagResolves(citation);
    });

    it("cites nothing for evidence whose document id is malformed", () => {
        expect(citationForEvidence(paper, { ...pdfEvidence, document: "not-an-id-" })).toBeNull();
    });

    it("cites a context file by its external key", () => {
        const row: Row = {
            id: "rfile",
            ref: { kind: "file", ext_key: "AB12CD34", label: "notes.pdf" },
            documents: ["ext-AB12CD34"],
            cells: {},
        };
        const citation = citationForEvidence(row, {
            document: "ext-AB12CD34",
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
            { document: "ext-EXT1", quote: "q", locator: "s1" },
        );
        expect(labelled?.display_name).toBe("notes.pdf");
        const bare = citationForEvidence(
            { id: "rf", ref: { kind: "file", ext_key: "EXT1" }, cells: {} },
            { document: "ext-EXT1", quote: "q", locator: "s1" },
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
                evidence: [pdfEvidence, { document: "u-ATT00001", locator: "s300", quote: "Another passage" }],
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
                /^table:r7f3a9c2b1d:u-ATT00001:s300:[0-9a-f]{8}$/,
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
            },
            documents: ["u-ATT00002"],
            cells: { sample: read([{ ...pdfEvidence, document: "u-ATT00002" }]) },
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
                first: read([
                    {
                        document: "u-ATT00001",
                        locator: "s5",
                        quote: "one part",
                        page: 1,
                        boxes: [[1, 1, 2, 2]],
                    },
                ]),
                second: read([
                    {
                        document: "u-ATT00001",
                        locator: "s5",
                        quote: "another part",
                        page: 1,
                        boxes: [[3, 3, 4, 4]],
                    },
                ]),
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
                    paged: read([{ document: "u-ATT00001", quote: "q", locator: "page12" }]),
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
                        c: read([{ document: "u-ATT00001", quote: "q", locator }]),
                    },
                },
                "c",
            )[0];
        expect(getCitationPages(at("s5.6"))).toEqual([5]);
        expect(getCitationPages(at("s5.6-s6.2"))).toEqual([5]);
        // A document-scoped id names no page.
        expect(getCitationPages(at("s243"))).toEqual([]);
    });

    it("cites the attachment under its parent item on attachment and annotation rows", () => {
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
            documents: ["u-ATT00001"],
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
            documents: ["u-ATT00001"],
            cells: {},
        };
        for (const row of [attachmentRow, annotationRow]) {
            expect(
                citationForEvidence(row, { document: "u-ATT00001", quote: "q", locator: "s3" }),
            ).toMatchObject({
                resolved_ref: { library_id: 1, zotero_key: "ATT00001" },
                parent_ref: { zotero_key: "ITEM0001" },
                citation_type: "attachment",
            });
        }
    });

    it("highlights boxes on the page a page locator names", () => {
        const [citation] = cellCitations(
            {
                ...paper,
                cells: {
                    boxed: read([
                        {
                            document: "u-ATT00001",
                            quote: "q",
                            locator: "page12",
                            boxes: [[1, 2, 3, 4]],
                        },
                    ]),
                },
            },
            "boxed",
        );
        expect(getCitationBoundingBoxes(citation)).toEqual([
            expect.objectContaining({ page: 12 }),
        ]);
    });

    it("keeps evidence of different cells apart, each with its own quote", () => {
        const pages: Row = {
            ...paper,
            cells: {
                first: read([{ document: "u-ATT00001", locator: "s3.1", quote: "first quote", page: 2 }]),
                second: read([{ document: "u-ATT00001", locator: "s8.4", quote: "second quote", page: 7 }]),
            },
        };
        const [first] = cellCitations(pages, "first");
        const [second] = cellCitations(pages, "second");
        expect(first.citation_id).not.toBe(second.citation_id);
        expect(first.raw_tag).toBe('<citation id="u-ATT00001" loc="s3.1"/>');
        expect(second.raw_tag).toBe('<citation id="u-ATT00001" loc="s8.4"/>');
        expect(keyOfTag(first.raw_tag!)).not.toBe(keyOfTag(second.raw_tag!));
        expect([first.preview, second.preview]).toEqual(["first quote", "second quote"]);
        expectTagResolves(first);
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

describe("the evidence document's kind", () => {
    const passage: Evidence = { document: "u-ATT00001", locator: "s5.6", quote: "A passage." };

    it("is read as a PDF when the caller does not know it", () => {
        const citation = citationForEvidence(paper, passage)!;
        expect(citation.content_kind).toBeUndefined();
        expect(citation.pages).toEqual([5]);
    });

    it("carries the kind the caller looked up, so an EPUB opens in its reader", () => {
        expect(citationForEvidence(paper, passage, { contentKind: "epub" })!.content_kind).toBe("epub");
    });

    it("gives a snapshot passage no page: it is found by its text", () => {
        const citation = citationForEvidence(paper, passage, { contentKind: "snapshot" })!;
        expect(citation.content_kind).toBe("snapshot");
        expect(citation.pages).toBeUndefined();
        expect(citation.preview).toBe("A passage.");
    });
});
