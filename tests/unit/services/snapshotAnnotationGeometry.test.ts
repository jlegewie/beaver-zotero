// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
    buildSnapshotSortIndex,
    toSnapshotSelector,
    type SnapshotSelector,
} from "../../../src/services/annotations/snapshot/snapshotAnnotationGeometry";

function bodyWith(html: string): HTMLElement {
    const doc = globalThis.document.implementation.createHTMLDocument("");
    doc.body.innerHTML = html;
    return doc.body;
}

/** Build a range over `needle` inside the first text node of `el`. */
function rangeOverText(el: Element, needle: string): Range {
    const textNode = el.firstChild as Text;
    const value = textNode.nodeValue ?? "";
    const start = value.indexOf(needle);
    if (start === -1) throw new Error(`"${needle}" not found in "${value}"`);
    const range = el.ownerDocument.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + needle.length);
    return range;
}

function isCss(selector: SnapshotSelector | null): selector is Extract<SnapshotSelector, { type: "CssSelector" }> {
    return selector?.type === "CssSelector";
}

describe("toSnapshotSelector", () => {
    it("builds a CssSelector refined by a TextPositionSelector for a partial selection", () => {
        const body = bodyWith('<div id="a"><p>Hello world foo bar</p></div>');
        const p = body.querySelector("p")!;
        const range = rangeOverText(p, "world foo");

        const selector = toSnapshotSelector(range);
        expect(isCss(selector)).toBe(true);
        if (!isCss(selector)) return;

        // The <p> is unique within the body, so the CSS path resolves to it.
        expect(body.querySelector(selector.value)).toBe(p);
        // Partial selection → refined by a text-position range over the element.
        expect(selector.refinedBy).toEqual({
            type: "TextPositionSelector",
            start: "Hello ".length,
            end: "Hello world foo".length,
        });
    });

    it("omits the TextPositionSelector when the range covers the element's full text", () => {
        const body = bodyWith("<p>Whole paragraph text</p>");
        const p = body.querySelector("p")!;
        const range = rangeOverText(p, "Whole paragraph text");

        const selector = toSnapshotSelector(range);
        expect(isCss(selector)).toBe(true);
        if (!isCss(selector)) return;
        expect(selector.refinedBy).toBeUndefined();
    });

    it("prefers an element id in the CSS selector", () => {
        const body = bodyWith('<p id="para">Some text here</p>');
        const range = rangeOverText(body.querySelector("#para")!, "text");

        const selector = toSnapshotSelector(range);
        expect(isCss(selector)).toBe(true);
        if (!isCss(selector)) return;
        expect(selector.value).toBe("#para");
    });
});

describe("buildSnapshotSortIndex", () => {
    it("counts trimmed characters from the body to the range start, zero-padded to 7", () => {
        const body = bodyWith("<p>Hello world foo bar</p>");
        const p = body.querySelector("p")!;
        const range = rangeOverText(p, "world foo");

        // Only one text node precedes the start; offset within it is 6.
        expect(buildSnapshotSortIndex(range, body)).toBe("0000006");
    });

    it("accumulates trimmed lengths of preceding text nodes", () => {
        const body = bodyWith("<p>First.</p><p>Second selection</p>");
        const second = body.querySelectorAll("p")[1];
        const range = rangeOverText(second, "selection");

        // "First." trims to 6 chars; "Second " before "selection" adds 7 → 13.
        expect(buildSnapshotSortIndex(range, body)).toBe("0000013");
    });
});
