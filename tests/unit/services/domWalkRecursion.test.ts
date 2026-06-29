// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { collectDomItems } from "../../../src/services/documentExtraction/dom/domWalk";
import { buildContentOffsetIndex } from "../../../src/services/documentExtraction/dom/pagination";

function bodyWith(html: string): HTMLElement {
    const doc = globalThis.document.implementation.createHTMLDocument("");
    doc.body.innerHTML = html;
    return doc.body;
}

// Build deep nesting without relying on jsdom's recursive HTML parser.
function deeplyNested(depth: number, leafHtml: string): HTMLElement {
    const doc = globalThis.document.implementation.createHTMLDocument("");
    let current: HTMLElement = doc.body;
    for (let i = 0; i < depth; i++) {
        const div = doc.createElement("div");
        current.appendChild(div);
        current = div;
    }
    current.innerHTML = leafHtml;
    return doc.body;
}

/** (kind, text) pairs for terse candidate-sequence assertions. */
function kindsAndText(body: HTMLElement): Array<[string, string]> {
    return collectDomItems(body).map((c) => [c.kind, c.text]);
}

describe("collectDomItems — iterative walk parity", () => {
    it("flushes inline text before and after a block child", () => {
        const body = bodyWith("<div>intro <p>para text</p> outro</div>");
        expect(kindsAndText(body)).toEqual([
            ["text", "intro"],
            ["text", "para text"],
            ["text", "outro"],
        ]);
    });

    it("folds inline element text into the surrounding prose of a generic block", () => {
        const body = bodyWith("<div>Hello <b>bold</b> world</div>");
        expect(kindsAndText(body)).toEqual([["text", "Hello bold world"]]);
    });

    it("treats a classified element as one item without descending into it", () => {
        const body = bodyWith("<h1>Title <span>sub</span></h1>");
        const items = collectDomItems(body);
        expect(items).toHaveLength(1);
        expect(items[0].kind).toBe("section_header");
        expect(items[0].level).toBe(1);
        expect(items[0].text).toBe("Title sub");
    });

    it("emits list items in order from a non-mapped list container", () => {
        const body = bodyWith("<ul><li>item one</li><li>item two</li></ul>");
        expect(kindsAndText(body)).toEqual([
            ["list_item", "item one"],
            ["list_item", "item two"],
        ]);
    });

    it("preserves order across nested generic blocks", () => {
        const body = bodyWith("<div>a<div>b<p>c</p>d</div>e</div>");
        expect(kindsAndText(body)).toEqual([
            ["text", "a"],
            ["text", "b"],
            ["text", "c"],
            ["text", "d"],
            ["text", "e"],
        ]);
    });

    it("records the first content text node on a folded candidate", () => {
        const body = bodyWith("<div>first <b>second</b></div>");
        const [item] = collectDomItems(body);
        expect(item.firstTextNode?.nodeValue).toContain("first");
    });

    it("does not overflow on pathologically deep nesting", () => {
        const body = deeplyNested(1500, "<p>deep text</p>");
        const items = collectDomItems(body);
        expect(items.some((c) => c.text === "deep text")).toBe(true);
    });
});

describe("buildContentOffsetIndex — iterative walk", () => {
    it("assigns document-order character offsets, skipping whitespace-only nodes", () => {
        const body = bodyWith("<div>ab<span>cd</span></div>");
        const { contentNodes, elementOffsets } = buildContentOffsetIndex(body);
        expect(contentNodes).toEqual([
            { start: 0, length: 2 },
            { start: 2, length: 2 },
        ]);
        const span = body.querySelector("span")!;
        expect(elementOffsets.get(span)).toBe(2);
    });

    it("skips style/script subtrees entirely", () => {
        const body = bodyWith("<div>ab<script>ignored()</script><span>cd</span></div>");
        const { contentNodes } = buildContentOffsetIndex(body);
        // Only "ab" and "cd" contribute; the script text is not recorded.
        expect(contentNodes).toEqual([
            { start: 0, length: 2 },
            { start: 2, length: 2 },
        ]);
    });

    it("does not overflow on pathologically deep nesting", () => {
        const body = deeplyNested(1500, "bottom");
        const { contentNodes } = buildContentOffsetIndex(body);
        expect(contentNodes).toEqual([{ start: 0, length: "bottom".length }]);
    });
});
