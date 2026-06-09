// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
    buildDomCitationIndex,
    collectDomItems,
    createDomCounters,
    isFootnoteElement,
    mapElement,
    parseDomSection,
    resolveDomCitationId,
    splitSentences,
} from "../../../src/services/documentExtraction/dom";
import {
    EPUB_CONTENT_KIND,
    EPUB_SCHEMA_VERSION,
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

describe("EPUB document constants", () => {
    it("exposes the EPUB content discriminator and schema version", () => {
        expect(EPUB_CONTENT_KIND).toBe("epub");
        expect(EPUB_SCHEMA_VERSION).toBe("1");
    });
});

describe("DOM mapping", () => {
    it("maps supported element names to DOM item kinds", () => {
        const doc = parseXhtml(`
            <p id="p">Body</p>
            <h2 id="h">Heading</h2>
            <li id="li">Item</li>
            <figcaption id="cap">Caption</figcaption>
            <table id="table"><tr><th>Header</th></tr><tr><td>Cell</td></tr></table>
            <img id="img" alt="Alt text" />
        `);

        expect(mapElement(doc.querySelector("#p")!)).toEqual({ kind: "text" });
        expect(mapElement(doc.querySelector("#h")!)).toEqual({ kind: "section_header", level: 2 });
        expect(mapElement(doc.querySelector("#li")!)).toEqual({ kind: "list_item" });
        expect(mapElement(doc.querySelector("#cap")!)).toEqual({ kind: "caption" });
        expect(mapElement(doc.querySelector("#table")!)).toEqual({ kind: "table" });
        expect(mapElement(doc.querySelector("#img")!)).toEqual({ kind: "picture" });
    });

    it("detects footnotes without namespace-prefixed selectors", () => {
        const doc = parseXhtml(`
            <aside id="ns" epub:type="footnote" xmlns:epub="http://www.idpf.org/2007/ops">Namespaced</aside>
            <aside id="plain" type="footnote">Plain</aside>
            <aside id="classed" class="note footnote">Classed</aside>
        `);

        expect(isFootnoteElement(doc.querySelector("#ns")!)).toBe(true);
        expect(isFootnoteElement(doc.querySelector("#plain")!)).toBe(true);
        expect(isFootnoteElement(doc.querySelector("#classed")!)).toBe(true);
    });

    it("uses textContent, normalizes whitespace, and skips empty items", () => {
        const doc = parseXhtml(`
            <p id="body"> First
                <span>second</span>
                third. </p>
            <p id="empty">   </p>
        `);

        const items = collectDomItems(bodyOf(doc));
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

        const items = collectDomItems(bodyOf(doc));
        expect(items.map((item) => [item.kind, item.text])).toEqual([
            ["text", "Quoted paragraph."],
            ["list_item", "Nested list paragraph."],
            ["caption", "Figure caption."],
        ]);
    });

    it("inherits the nearest ancestor anchor id", () => {
        const doc = parseXhtml(`<section id="chapter"><p>Anchored text.</p></section>`);

        const [item] = collectDomItems(bodyOf(doc));
        expect(item.anchorId).toBe("chapter");
    });

    it("treats leaf <div> blocks as text but not their block-level wrappers", () => {
        // EPUBs converted from PDF/Word use <div> for body text instead of <p>.
        const doc = parseXhtml(`
            <div id="chapter">
                <div id="para1">First div paragraph.</div>
                <div id="para2">Second div paragraph.</div>
            </div>
        `);

        const items = collectDomItems(bodyOf(doc));
        expect(items.map((item) => [item.kind, item.text])).toEqual([
            ["text", "First div paragraph."],
            ["text", "Second div paragraph."],
        ]);
    });

    it("does not map a <div> that only wraps other block elements", () => {
        const doc = parseXhtml(`<div id="wrap"><p>Real paragraph.</p></div>`);

        const items = collectDomItems(bodyOf(doc));
        expect(items.map((item) => [item.kind, item.text])).toEqual([
            ["text", "Real paragraph."],
        ]);
    });

    it("keeps a genuine data table as one opaque table item", () => {
        const doc = parseXhtml(`
            <table id="data">
                <tr><th>Year</th><th>Count</th></tr>
                <tr><td>1995</td><td>42</td></tr>
            </table>
        `);

        const items = collectDomItems(bodyOf(doc));
        expect(items.map((item) => item.kind)).toEqual(["table"]);
    });

    it("walks a layout table that wraps real headings and paragraphs", () => {
        // A single positioning table around otherwise-normal content.
        const doc = parseXhtml(`
            <table><tr><td>
                <h2>Chapter 7</h2>
                <p>First paragraph of the chapter.</p>
                <p>Second paragraph.</p>
            </td></tr></table>
        `);

        const items = collectDomItems(bodyOf(doc));
        expect(items.map((item) => [item.kind, item.text])).toEqual([
            ["section_header", "Chapter 7"],
            ["text", "First paragraph of the chapter."],
            ["text", "Second paragraph."],
        ]);
    });

    it("recovers prose held directly in layout-table cells", () => {
        const prose = "This is a long run of body text that a PDF conversion placed "
            + "directly inside a positioning table cell with no paragraph tag, so it "
            + "must be recovered as a text item rather than dropped.";
        const doc = parseXhtml(`
            <table border="0"><tr><td><font>${prose}</font></td></tr></table>
        `);

        const items = collectDomItems(bodyOf(doc));
        expect(items.map((item) => item.kind)).toEqual(["text"]);
        expect(items[0].text).toBe(prose);
    });
});

describe("sentence splitting", () => {
    it("keeps author initials and abbreviations attached", () => {
        expect(splitSentences("Edited by Marvin A. Sweeney and Eric D. Reymond.")).toEqual([
            "Edited by Marvin A. Sweeney and Eric D. Reymond.",
        ]);
        expect(splitSentences("See p. 45 and vol. 2 for details.")).toEqual([
            "See p. 45 and vol. 2 for details.",
        ]);
    });

    it("splits a sentence that ends with a number", () => {
        // A sentence-final number must not be mistaken for a list marker.
        expect(splitSentences("The sample size was 42. Results were stable.")).toEqual([
            "The sample size was 42.",
            "Results were stable.",
        ]);
    });

    it("keeps a leading list/section number attached to its item", () => {
        expect(splitSentences("1. Hebrew is the older language.")).toEqual([
            "1. Hebrew is the older language.",
        ]);
        expect(splitSentences("3.1. The morphology of the verb is complex.")).toEqual([
            "3.1. The morphology of the verb is complex.",
        ]);
    });

    it("still splits genuine sentence boundaries", () => {
        expect(splitSentences("First sentence. Second sentence! Third?")).toEqual([
            "First sentence.",
            "Second sentence!",
            "Third?",
        ]);
    });
});

describe("DOM section parser", () => {
    it("assigns document-global item ids, sentence ids, and item order across sections", () => {
        const counters = createDomCounters();
        const first = parseDomSection({
            doc: parseXhtml(`<p>First sentence. Second sentence.</p><h1>Heading</h1>`),
            sectionIndex: 0,
            rawHref: "EPUB/first.xhtml",
            counters,
        });
        const second = parseDomSection({
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
        // The section label prefers the in-body heading over the <head><title>.
        expect(first).toMatchObject({ index: 0, rawHref: "EPUB/first.xhtml", label: "Heading" });
    });

    it("returns an empty section when the document has no body", () => {
        const doc = new DOMParser().parseFromString("<package />", "application/xml");

        const section = parseDomSection({
            doc,
            sectionIndex: 3,
            rawHref: "EPUB/nav.xml",
            counters: createDomCounters(),
        });

        expect(section).toEqual({ index: 3, rawHref: "EPUB/nav.xml", items: [] });
    });
});

describe("DOM citation index", () => {
    it("indexes item ids and raw sentence ids", () => {
        const section = parseDomSection({
            doc: parseXhtml(`<section id="anchor"><p>First sentence. Second sentence.</p></section>`),
            sectionIndex: 0,
            rawHref: "EPUB/first.xhtml",
            counters: createDomCounters(),
        });

        const index = buildDomCitationIndex([section]);
        expect(resolveDomCitationId(index, "p1")).toEqual({
            id: "p1",
            kind: "item",
            sectionIndex: 0,
            itemId: "p1",
            anchorId: "anchor",
        });
        expect(resolveDomCitationId(index, "s2")).toEqual({
            id: "s2",
            kind: "sentence",
            sectionIndex: 0,
            itemId: "p1",
            sentenceId: "s2",
            anchorId: "anchor",
        });
        expect(resolveDomCitationId(index, "sentence:2")).toBeUndefined();
    });
});
