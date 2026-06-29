// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
    buildSnapshotSortIndex,
    toSnapshotSelector,
    type SnapshotSelector,
} from "../../../src/services/annotations/snapshot/snapshotAnnotationGeometry";
import { getUniqueSelectorContaining } from "../../../src/services/annotations/snapshot/vendor/readerSelectors";

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

describe("getUniqueSelectorContaining — cssEscape fallback (no globalThis.CSS)", () => {
    // The headless path may run without `globalThis.CSS`. Force that branch so the
    // fallback (not native CSS.escape) is exercised, then restore it.
    let savedCSS: unknown;
    let hadCSS = false;

    function withoutCSS<T>(fn: () => T): T {
        const g = globalThis as { CSS?: unknown };
        hadCSS = "CSS" in g;
        savedCSS = g.CSS;
        delete g.CSS;
        try {
            return fn();
        } finally {
            if (hadCSS) {
                (g as { CSS?: unknown }).CSS = savedCSS;
            }
        }
    }

    function elementWithId(id: string): Element {
        const doc = globalThis.document.implementation.createHTMLDocument("");
        const el = doc.createElement("div");
        el.id = id;
        el.textContent = "cited text";
        doc.body.appendChild(el);
        return el;
    }

    afterEach(() => {
        const g = globalThis as { CSS?: unknown };
        if (hadCSS) g.CSS = savedCSS;
    });

    // A leading digit / leading hyphen-digit must be hex-escaped, not passed
    // through raw, or the reader's querySelector throws on the stored selector.
    it.each([
        ["2", "#\\32 "],
        ["1abc", "#\\31 abc"],
        ["-1", "#-\\31 "],
        ["fn:1", "#fn\\:1"],
        ["a b", "#a\\ b"],
    ])("escapes id %j to a resolvable selector %j", (id, expected) => {
        const el = elementWithId(id);
        const selector = withoutCSS(() => getUniqueSelectorContaining(el));
        expect(selector).toBe(expected);
        // The escaped selector must round-trip back to the element.
        expect(el.ownerDocument.body.querySelector(selector!)).toBe(el);
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

    it("returns 0000000 for a range at the very start of the body", () => {
        const body = bodyWith("<p>Hello world</p>");
        const range = rangeOverText(body.querySelector("p")!, "Hello");

        // First text node, offset 0 → a genuine zero, distinct from the
        // unreachable-start case below.
        expect(buildSnapshotSortIndex(range, body)).toBe("0000000");
    });

    it("throws when the range was built against a different DOM than the body", () => {
        const body = bodyWith("<p>Body text here</p>");
        const otherBody = bodyWith("<p>Different document</p>");
        const range = rangeOverText(otherBody.querySelector("p")!, "Different");

        // The range start is never reached while walking `body`; surfacing this
        // prevents a silently mis-sorted "0000000" annotation.
        expect(() => buildSnapshotSortIndex(range, body)).toThrow();
    });
});
