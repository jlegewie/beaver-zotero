// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
    buildEpubPageMapping,
    epubPageLabelForPosition,
    type PageMappingSection,
} from "../../../src/services/annotations/epub/epubPageMapping";

/** Build a section body Element (in its own document) from inner HTML. */
function sectionBody(sectionIndex: number, bodyHtml: string): PageMappingSection {
    const doc = document.implementation.createHTMLDocument("");
    doc.body.innerHTML = bodyHtml;
    return { sectionIndex, body: doc.body };
}

describe("buildEpubPageMapping", () => {
    it("detects physical pages from empty page anchors across sections", () => {
        const sections = [
            sectionBody(0, '<p><a id="page_1"></a>First page text here.</p><p><a id="page_2"></a>Second page text.</p>'),
            sectionBody(1, '<p><a id="page_3"></a>Third page text.</p>'),
        ];
        const mapping = buildEpubPageMapping(sections, 2);

        expect(mapping.isPhysical).toBe(true);
        expect(mapping.markers.map((m) => m.label)).toEqual(["1", "2", "3"]);
        expect(mapping.markers[0].charOffset).toBe(0);
    });

    it("is not physical when fewer than half the sections carry markers", () => {
        const sections = [
            sectionBody(0, '<p><a id="page_1"></a>Has a marker.</p>'),
            sectionBody(1, "<p>No marker.</p>"),
            sectionBody(2, "<p>No marker.</p>"),
            sectionBody(3, "<p>No marker.</p>"),
        ];
        const mapping = buildEpubPageMapping(sections, 4);
        expect(mapping.isPhysical).toBe(false);
        expect(mapping.markers).toEqual([]);
    });

    it("normalizes prefixed page ids to the bare number", () => {
        const sections = [
            sectionBody(0, '<a id="page_9"></a>a<a id="page10"></a>b<a id="x_page_11"></a>c'),
        ];
        const mapping = buildEpubPageMapping(sections, 1);
        expect(mapping.markers.map((m) => m.label)).toEqual(["9", "10", "11"]);
    });
});

describe("epubPageLabelForPosition", () => {
    const sections = [
        sectionBody(0, '<p><a id="page_1"></a>First page text here.</p><p><a id="page_2"></a>Second page text.</p>'),
        sectionBody(1, '<p><a id="page_3"></a>Third page text.</p>'),
    ];
    const mapping = buildEpubPageMapping(sections, 2);
    const page2Offset = mapping.markers.find((m) => m.label === "2")!.charOffset;

    it("returns the nearest marker at or before the position", () => {
        expect(epubPageLabelForPosition(mapping, 0, 0)).toBe("1");
        expect(epubPageLabelForPosition(mapping, 0, page2Offset)).toBe("2");
        expect(epubPageLabelForPosition(mapping, 0, page2Offset - 1)).toBe("1");
    });

    it("carries markers across section boundaries", () => {
        // Section 1's own marker (page_3) sits at offset 0, so any position in
        // section 1 is at-or-after it.
        expect(epubPageLabelForPosition(mapping, 1, 9999)).toBe("3");
        expect(epubPageLabelForPosition(mapping, 1, 0)).toBe("3");
    });

    it("returns empty string when the mapping is not physical", () => {
        expect(epubPageLabelForPosition({ isPhysical: false, markers: [] }, 0, 5)).toBe("");
    });
});
