// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
    EPUB_CONTENT_KIND,
    EPUB_SCHEMA_VERSION,
    buildEpubCitationIndex,
    collectEpubDomItems,
    createEpubExtractionCounters,
    isEpubFootnoteElement,
    mapEpubElement,
    parseEpubSection,
    resolveEpubCitationId,
} from "../../../src/services/documentExtraction/epub";

function parseXhtml(markup: string): Document {
    return new DOMParser().parseFromString(
        `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Section title</title></head><body>${markup}</body></html>`,
        "application/xhtml+xml",
    );
}

function bodyOf(doc: Document): Element {
    return doc.body ?? doc.querySelector("body")!;
}

describe("EPUB extraction schema", () => {
    it("exposes the EPUB content discriminator and schema version", () => {
        expect(EPUB_CONTENT_KIND).toBe("epub");
        expect(EPUB_SCHEMA_VERSION).toBe("1");
    });
});

describe("EPUB DOM mapping", () => {
    it("maps supported element names to EPUB item kinds", () => {
        const doc = parseXhtml(`
            <p id="p">Body</p>
            <h2 id="h">Heading</h2>
            <li id="li">Item</li>
            <figcaption id="cap">Caption</figcaption>
            <table id="table"><tr><td>Cell</td></tr></table>
            <img id="img" alt="Alt text" />
        `);

        expect(mapEpubElement(doc.querySelector("#p")!)).toEqual({ kind: "text" });
        expect(mapEpubElement(doc.querySelector("#h")!)).toEqual({ kind: "section_header", level: 2 });
        expect(mapEpubElement(doc.querySelector("#li")!)).toEqual({ kind: "list_item" });
        expect(mapEpubElement(doc.querySelector("#cap")!)).toEqual({ kind: "caption" });
        expect(mapEpubElement(doc.querySelector("#table")!)).toEqual({ kind: "table" });
        expect(mapEpubElement(doc.querySelector("#img")!)).toEqual({ kind: "picture" });
    });

    it("detects EPUB footnotes without namespace-prefixed selectors", () => {
        const doc = parseXhtml(`
            <aside id="ns" epub:type="footnote" xmlns:epub="http://www.idpf.org/2007/ops">Namespaced</aside>
            <aside id="plain" type="footnote">Plain</aside>
            <aside id="classed" class="note footnote">Classed</aside>
        `);

        expect(isEpubFootnoteElement(doc.querySelector("#ns")!)).toBe(true);
        expect(isEpubFootnoteElement(doc.querySelector("#plain")!)).toBe(true);
        expect(isEpubFootnoteElement(doc.querySelector("#classed")!)).toBe(true);
    });

    it("uses textContent, normalizes whitespace, and skips empty items", () => {
        const doc = parseXhtml(`
            <p id="body"> First
                <span>second</span>
                third. </p>
            <p id="empty">   </p>
        `);

        const items = collectEpubDomItems(bodyOf(doc));
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            kind: "text",
            text: "First second third.",
            anchorId: "body",
        });
    });

    it("does not double count owned nested prose and captions", () => {
        const doc = parseXhtml(`
            <blockquote id="quote"><p>Quoted paragraph.</p></blockquote>
            <ul><li id="li"><p>Nested list paragraph.</p></li></ul>
            <figure id="figure"><img src="cover.jpg" /><figcaption id="caption">Figure caption.</figcaption></figure>
        `);

        const items = collectEpubDomItems(bodyOf(doc));
        expect(items.map((item) => [item.kind, item.text])).toEqual([
            ["text", "Quoted paragraph."],
            ["list_item", "Nested list paragraph."],
            ["caption", "Figure caption."],
        ]);
    });

    it("inherits the nearest ancestor anchor id", () => {
        const doc = parseXhtml(`<section id="chapter"><p>Anchored text.</p></section>`);

        const [item] = collectEpubDomItems(bodyOf(doc));
        expect(item.anchorId).toBe("chapter");
    });
});

describe("EPUB section parser", () => {
    it("assigns document-global item ids, sentence ids, and item order across sections", () => {
        const counters = createEpubExtractionCounters();
        const first = parseEpubSection({
            doc: parseXhtml(`<p>First sentence. Second sentence.</p><h1>Heading</h1>`),
            sectionIndex: 0,
            rawHref: "EPUB/first.xhtml",
            counters,
        });
        const second = parseEpubSection({
            doc: parseXhtml(`<p>Third sentence.</p><ul><li>List sentence.</li></ul>`),
            sectionIndex: 1,
            rawHref: "EPUB/second.xhtml",
            counters,
        });

        expect(first.items.map((item) => item.id)).toEqual(["p1", "heading1"]);
        expect(second.items.map((item) => item.id)).toEqual(["p2", "list1"]);
        expect([...first.items, ...second.items].map((item) => item.order)).toEqual([0, 1, 2, 3]);
        expect(first.items[0].sentences?.map((sentence) => sentence.id)).toEqual(["s1", "s2"]);
        expect(second.items[0].sentences?.map((sentence) => sentence.id)).toEqual(["s3"]);
        expect(second.items[1].sentences?.map((sentence) => sentence.id)).toEqual(["s4"]);
        expect(first).toMatchObject({ index: 0, rawHref: "EPUB/first.xhtml", label: "Section title" });
    });

    it("returns an empty section when the document has no body", () => {
        const doc = new DOMParser().parseFromString("<package />", "application/xml");

        const section = parseEpubSection({
            doc,
            sectionIndex: 3,
            rawHref: "EPUB/nav.xml",
            counters: createEpubExtractionCounters(),
        });

        expect(section).toEqual({ index: 3, rawHref: "EPUB/nav.xml", items: [] });
    });
});

describe("EPUB citation index", () => {
    it("indexes item ids and raw sentence ids", () => {
        const section = parseEpubSection({
            doc: parseXhtml(`<section id="anchor"><p>First sentence. Second sentence.</p></section>`),
            sectionIndex: 0,
            rawHref: "EPUB/first.xhtml",
            counters: createEpubExtractionCounters(),
        });

        const index = buildEpubCitationIndex([section]);
        expect(resolveEpubCitationId(index, "p1")).toEqual({
            id: "p1",
            kind: "item",
            sectionIndex: 0,
            itemId: "p1",
            anchorId: "anchor",
        });
        expect(resolveEpubCitationId(index, "s2")).toEqual({
            id: "s2",
            kind: "sentence",
            sectionIndex: 0,
            itemId: "p1",
            sentenceId: "s2",
            anchorId: "anchor",
        });
        expect(resolveEpubCitationId(index, "sentence:2")).toBeUndefined();
    });
});
