// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildAnnotationFromDocument } from "../../../src/services/annotations/snapshot/snapshotAnnotationResolver";
import type { SnapshotSelector } from "../../../src/services/annotations/snapshot/snapshotAnnotationGeometry";

function docWith(bodyHtml: string): Document {
    const doc = globalThis.document.implementation.createHTMLDocument("");
    doc.body.innerHTML = bodyHtml;
    return doc;
}

function isCss(
    selector: SnapshotSelector,
): selector is Extract<SnapshotSelector, { type: "CssSelector" }> {
    return selector.type === "CssSelector";
}

const OVERLAY_ID = "annotation-overlay";

describe("buildAnnotationFromDocument — reader overlay parity", () => {
    it("does not emit :last-child for a body-level last child (the overlay displaces it)", () => {
        // The cited element sits in the last content child before the reader
        // overlay.
        const doc = docWith(
            '<div><p>Navigation and header text.</p></div>'
            + '<div><p>The cited sentence lives in the last div.</p></div>',
        );
        const citedP = doc.body.querySelectorAll("p")[1];

        const built = buildAnnotationFromDocument(doc, {
            text: "The cited sentence lives in the last div.",
        });
        expect("error" in built).toBe(false);
        if ("error" in built) return;

        expect(isCss(built.position)).toBe(true);
        if (!isCss(built.position)) return;

        // Body-level last-position pseudo-classes should target the overlay, not
        // snapshot content.
        expect(built.position.value).not.toMatch(/:last-child|:last-of-type/);

        // The selector resolves in the same overlay-bearing body shape as the
        // reader's default view.
        expect(doc.body.lastElementChild?.id).toBe(OVERLAY_ID);
        expect(doc.body.querySelector(built.position.value)).toBe(citedP);
    });

    it("appends the overlay exactly once across repeated calls", () => {
        const doc = docWith("<p>First.</p><p>Second cited sentence here.</p>");

        buildAnnotationFromDocument(doc, { text: "Second cited sentence here." });
        buildAnnotationFromDocument(doc, { text: "First." });

        const overlays = doc.body.querySelectorAll(`#${OVERLAY_ID}`);
        expect(overlays.length).toBe(1);
        expect(doc.body.lastElementChild?.id).toBe(OVERLAY_ID);
    });

    it.each([
        {
            name: "body-level last child (sibling present)",
            html: '<div>Header text here that is long enough.</div>'
                + '<div>The cited sentence lives in the last div here.</div>',
            cited: "div:nth-of-type(2)",
            text: "The cited sentence lives in the last div here.",
        },
        {
            name: "body-level only child",
            html: '<div>The only cited sentence lives alone here.</div>',
            cited: "div",
            text: "The only cited sentence lives alone here.",
        },
        {
            name: "body-level last child, unique tag",
            html: '<div>Body paragraph one here long enough.</div>'
                + '<footer>The cited footnote sentence here is unique.</footer>',
            cited: "footer",
            text: "The cited footnote sentence here is unique.",
        },
        {
            name: "nested last child inside a container",
            html: '<div class="container"><p>Intro paragraph here.</p>'
                + '<p>The cited nested sentence is the last paragraph.</p></div>',
            cited: ".container > p:nth-of-type(2)",
            text: "The cited nested sentence is the last paragraph.",
        },
    ])(
        "resolves to the cited element with the overlay removed (reading-mode preBody): $name",
        ({ html, cited, text }) => {
            const doc = docWith(html);
            const citedEl = doc.body.querySelector(cited);
            expect(citedEl).not.toBeNull();

            const built = buildAnnotationFromDocument(doc, { text });
            expect("error" in built).toBe(false);
            if ("error" in built) return;
            // A TextPositionSelector fallback resolves against the full body and is
            // unaffected by the overlay, so only the CssSelector path needs guarding.
            if (!isCss(built.position)) return;

            // Default view: the reader resolves selectors against the overlay-bearing body.
            expect(doc.body.querySelector(built.position.value)).toBe(citedEl);

            // Reading mode: the reader resolves against `preBody`, which omits the
            // overlay. Since the overlay is only ever a trailing body child, the
            // generated from-start/type selectors stay valid once it is removed.
            doc.body.querySelector(`#${OVERLAY_ID}`)?.remove();
            expect(doc.body.querySelector(built.position.value)).toBe(citedEl);
        },
    );

    it("keeps selectors resolving for a unique element and leaves sortIndex unaffected", () => {
        // The empty overlay does not contribute to text offsets.
        const doc = docWith('<p id="para">Hello world foo bar</p>');
        const para = doc.body.querySelector("#para")!;

        const built = buildAnnotationFromDocument(doc, { text: "world foo" });
        expect("error" in built).toBe(false);
        if ("error" in built) return;
        if (!isCss(built.position)) return;

        expect(doc.body.querySelector(built.position.value)).toBe(para);
        // "Hello " precedes the range start within the single text node.
        expect(built.sortIndex).toBe("0000006");
    });
});
