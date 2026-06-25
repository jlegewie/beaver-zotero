// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import EpubCFI from "../../../src/services/annotations/epub/vendor/epubcfi";

/**
 * Build an isolated HTML document with the given <body> markup and return it.
 * Using a fresh document (not the shared test document) keeps element indices
 * predictable: html > [head, body].
 */
function makeDoc(bodyHtml: string): Document {
    const doc = document.implementation.createHTMLDocument("");
    doc.body.innerHTML = bodyHtml;
    return doc;
}

describe("EpubCFI (vendored generation subset)", () => {
    it("generates a range CFI relative to the spine base", () => {
        // body > [p, p]; html > [head, body]
        const doc = makeDoc("<p>First.</p><p>Second sentence here.</p>");
        const textNode = doc.body.children[1].firstChild as Text; // "Second sentence here."

        const range = doc.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, 6); // "Second"

        const cfi = new EpubCFI(range, "/6/4");
        // base /6/4 ; path body(/4)/p(/4) ; start text(/1):0 ; end text(/1):6
        expect(cfi.toString(true)).toBe("epubcfi(/6/4!/4/4,/1:0,/1:6)");
    });

    it("generates a collapsed (point) CFI for note annotations", () => {
        const doc = makeDoc("<p>First.</p><p>Second sentence here.</p>");
        const textNode = doc.body.children[1].firstChild as Text;

        const range = doc.createRange();
        range.setStart(textNode, 0);
        range.collapse(true);

        const cfi = new EpubCFI(range, "/6/4");
        expect(cfi.toString(true)).toBe("epubcfi(/6/4!/4/4/1:0)");
    });

    it("counts element siblings, not text whitespace, in the path", () => {
        // A leading element sibling shifts the target paragraph's element index.
        const doc = makeDoc("<h1>Title</h1><p>Body text.</p>");
        const textNode = doc.body.children[1].firstChild as Text; // in <p>, body child index 1

        const range = doc.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, 4);

        const cfi = new EpubCFI(range, "/6/4");
        // p is the 2nd element child of body -> /4
        expect(cfi.toString(true)).toBe("epubcfi(/6/4!/4/4,/1:0,/1:4)");
    });

    it("includes [id] assertions only when assertions are not excluded", () => {
        const doc = makeDoc('<p id="para">Hello world.</p>');
        const textNode = doc.body.children[0].firstChild as Text;

        const range = doc.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, 5);

        const cfi = new EpubCFI(range, "/6/4");
        expect(cfi.toString(true)).toBe("epubcfi(/6/4!/4/2,/1:0,/1:5)");
        // With assertions: the <p> step carries its id.
        expect(cfi.toString(false)).toBe("epubcfi(/6/4!/4/2[para],/1:0,/1:5)");
    });

    it("builds the chapter (base) component like epub.js", () => {
        const cfi = new EpubCFI();
        // spineNodeIndex 2 -> /6 ; spine itemref index 3 -> /8
        expect(cfi.generateChapterComponent(2, 3)).toBe("/6/8");
        expect(cfi.generateChapterComponent(2, 3, "ch4")).toBe("/6/8[ch4]");
    });
});
