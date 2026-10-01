import { describe, expect, it } from "vitest";

import {
    formatExtractId,
    parseExtractId,
    schemaVersionForIdScheme,
} from "@beaver/agent-core/extract/ids";
import type { DocumentItem, StructuredPage } from "@beaver/agent-core/extract/schema";
import { assignDocumentIds } from "../../../src/beaver-extract/schema/ids";
import { buildCitationIndex } from "../../../src/beaver-extract/schema/citationIndex";

function textItem(order: number, sentenceCount: number): DocumentItem {
    return {
        id: "tmp",
        kind: "text",
        pageIndex: 0,
        order,
        text: "x",
        bbox: [0, 0, 1, 1],
        sentences: Array.from({ length: sentenceCount }, (_, i) => ({
            id: "tmp",
            order: i,
            text: `s${i}`,
            bboxes: [[0, 0, 1, 1]],
        })),
    };
}

function heading(order: number): DocumentItem {
    return { id: "tmp", kind: "section_header", pageIndex: 0, order, text: "H", level: 1, bbox: [0, 0, 1, 1] };
}

function page(index: number, items: DocumentItem[]): StructuredPage {
    return {
        index,
        width: 100,
        height: 100,
        viewBox: [0, 0, 100, 100],
        rotation: 0,
        items: items.map((item) => ({ ...item, pageIndex: index })),
    };
}

/** Item and sentence ids in reading order. */
function idsOf(pages: StructuredPage[]): { items: string[]; sentences: string[] } {
    const items: string[] = [];
    const sentences: string[] = [];
    for (const p of pages) {
        for (const item of [...p.items].sort((a, b) => a.order - b.order)) {
            items.push(item.id);
            if ("sentences" in item) sentences.push(...(item.sentences ?? []).map((s) => s.id));
        }
    }
    return { items, sentences };
}

/** Pages 0 and 2 carry content; page 1 is empty. Items are listed out of order. */
function samplePages(): StructuredPage[] {
    return [
        page(2, [textItem(1, 1), heading(0)]),
        page(0, [heading(0), textItem(1, 2), textItem(2, 1)]),
        page(1, []),
    ];
}

describe("extraction id format", () => {
    it("formats document-wide and page-scoped ids", () => {
        expect(formatExtractId("s", 243)).toBe("s243");
        expect(formatExtractId("s", 6, 5)).toBe("s5.6");
        expect(formatExtractId("heading", 1, 12)).toBe("heading12.1");
    });

    it("parses both schemes and names their schema version", () => {
        expect(parseExtractId("s243")).toEqual({ prefix: "s", n: 243, scheme: "document" });
        expect(parseExtractId("s5.6")).toEqual({ prefix: "s", page: 5, n: 6, scheme: "page" });
        expect(parseExtractId("table12.1")).toEqual({ prefix: "table", page: 12, n: 1, scheme: "page" });
        expect(schemaVersionForIdScheme("document")).toBe("4");
        expect(schemaVersionForIdScheme("page")).toBe("5");
    });

    it("rejects unknown prefixes and malformed ids", () => {
        for (const raw of ["page5", "x5", "s", "s5.", "s5.6.7", "S5", "s-5", "s5-s6", "paragraph3"]) {
            expect(parseExtractId(raw)).toBeNull();
        }
    });

    it("round-trips every assigned id", () => {
        const pages = samplePages();
        assignDocumentIds(pages, "page");
        const { items, sentences } = idsOf(pages);
        for (const id of [...items, ...sentences]) {
            const parsed = parseExtractId(id)!;
            expect(formatExtractId(parsed.prefix, parsed.n, parsed.page)).toBe(id);
        }
    });
});

describe("assignDocumentIds", () => {
    it("numbers ids across the whole document under the document scheme", () => {
        const pages = samplePages();
        assignDocumentIds(pages, "document");
        const byIndex = [...pages].sort((a, b) => a.index - b.index);
        expect(idsOf(byIndex)).toEqual({
            // Reading order: page 0 (heading, p, p), page 2 (heading, p).
            items: ["heading1", "p1", "p2", "heading2", "p3"],
            sentences: ["s1", "s2", "s3", "s4"],
        });
    });

    it("restarts counters on every page under the page scheme", () => {
        const pages = samplePages();
        assignDocumentIds(pages, "page");
        const byIndex = [...pages].sort((a, b) => a.index - b.index);
        expect(idsOf(byIndex)).toEqual({
            items: ["heading1.1", "p1.1", "p1.2", "heading3.1", "p3.1"],
            // Sentences run across the page's items in item order.
            sentences: ["s1.1", "s1.2", "s1.3", "s3.1"],
        });
    });

    it("orders items by `order`, not by array position", () => {
        const pages = samplePages();
        assignDocumentIds(pages, "page");
        const page2 = pages.find((p) => p.index === 2)!;
        expect(page2.items.map((item) => [item.kind, item.id])).toEqual([
            ["text", "p3.1"],
            ["section_header", "heading3.1"],
        ]);
    });

    it("keeps ids on unchanged pages stable when another page changes", () => {
        const before = samplePages();
        const after = samplePages();
        // Page 0 gains a paragraph with two sentences.
        after[1].items.push(textItem(3, 2));
        assignDocumentIds(before, "page");
        assignDocumentIds(after, "page");
        const page2Ids = (pages: StructuredPage[]) => idsOf(pages.filter((p) => p.index === 2));
        expect(page2Ids(after)).toEqual(page2Ids(before));

        const beforeDoc = samplePages();
        const afterDoc = samplePages();
        afterDoc[1].items.push(textItem(3, 2));
        assignDocumentIds(beforeDoc, "document");
        assignDocumentIds(afterDoc, "document");
        expect(page2Ids(afterDoc)).not.toEqual(page2Ids(beforeDoc));
    });

    it("indexes page-scoped ids for citation lookup", () => {
        const pages = samplePages();
        assignDocumentIds(pages, "page");
        const index = buildCitationIndex(pages);
        expect(index["s1.3"]).toMatchObject({ kind: "sentence", pageIndex: 0, itemId: "p1.2" });
        expect(index["heading3.1"]).toMatchObject({ kind: "item", pageIndex: 2 });
    });
});
