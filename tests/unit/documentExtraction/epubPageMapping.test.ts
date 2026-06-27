// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
    epubPageLabelForPosition,
    extractSectionPageMarkers,
    scorePageMarkers,
} from "../../../src/services/documentExtraction/epub/epubPageMapping";
import {
    appendSyntheticSectionMarkers,
    pageOrdinalForPosition,
    type PageMarker,
} from "../../../src/services/documentExtraction/dom/pagination";

interface TestSection {
    sectionIndex: number;
    body: Element;
}

/** Build a section body Element (in its own document) from inner HTML. */
function sectionBody(sectionIndex: number, bodyHtml: string): TestSection {
    const doc = globalThis.document.implementation.createHTMLDocument("");
    doc.body.innerHTML = bodyHtml;
    return { sectionIndex, body: doc.body };
}

/** Character count from the section root to `el`, used only by tests. */
function charOffsetForElement(el: Element): number {
    const doc = el.ownerDocument;
    const root = doc?.documentElement;
    if (!doc || !root) return 0;
    const range = doc.createRange();
    try {
        range.setStart(root, 0);
        range.setEnd(el, 0);
        return range.toString().length;
    } finally {
        range.detach();
    }
}

function collectAndScore(sections: TestSection[], totalSpineCount: number) {
    const markers = sections.map((section) => extractSectionPageMarkers(
        section.body,
        section.sectionIndex,
        charOffsetForElement,
    ));
    return scorePageMarkers(markers, totalSpineCount);
}

describe("extractSectionPageMarkers and scorePageMarkers", () => {
    it("detects physical pages from empty page anchors across sections", () => {
        const sections = [
            sectionBody(0, '<p><a id="page_1"></a>First page text here.</p><p><a id="page_2"></a>Second page text.</p>'),
            sectionBody(1, '<p><a id="page_3"></a>Third page text.</p>'),
        ];
        const mapping = collectAndScore(sections, 2);

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
        const mapping = collectAndScore(sections, 4);
        expect(mapping.isPhysical).toBe(false);
        expect(mapping.markers).toEqual([]);
    });

    it("normalizes prefixed page ids to the bare number", () => {
        const sections = [
            sectionBody(0, '<a id="page_9"></a>a<a id="page10"></a>b<a id="x_page_11"></a>c'),
        ];
        const mapping = collectAndScore(sections, 1);
        expect(mapping.markers.map((m) => m.label)).toEqual(["9", "10", "11"]);
    });

    it("collects markers per section and scores them after streaming collection", () => {
        const sections = [
            sectionBody(0, '<p><span epub:type="pagebreak" title="10"></span>First page.</p>'),
            sectionBody(1, '<p><span epub:type="pagebreak" title="11"></span>Second page.</p>'),
        ];

        const collected = sections.map((section) => extractSectionPageMarkers(
            section.body,
            section.sectionIndex,
            (element) => element.textContent?.length ?? 0,
        ));
        const mapping = scorePageMarkers(collected, 2);

        expect(mapping.isPhysical).toBe(true);
        expect(mapping.markers.map((marker) => marker.label)).toEqual(["10", "11"]);
    });
});

describe("epubPageLabelForPosition", () => {
    const sections = [
        sectionBody(0, '<p><a id="page_1"></a>First page text here.</p><p><a id="page_2"></a>Second page text.</p>'),
        sectionBody(1, '<p><a id="page_3"></a>Third page text.</p>'),
    ];
    const mapping = collectAndScore(sections, 2);
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

describe("appendSyntheticSectionMarkers", () => {
    const collect = (sections: { length: number; nodes: number[] }[]) => {
        const out: PageMarker[] = [];
        sections.forEach((section, sectionIndex) => {
            let start = 0;
            const nodes = section.nodes.map((length) => {
                const node = { start, length };
                start += length;
                return node;
            });
            appendSyntheticSectionMarkers(nodes, sectionIndex, 1800, out);
        });
        return out;
    };

    it("places a marker at the section start", () => {
        const markers = collect([{ length: 1, nodes: [500] }]);
        expect(markers).toEqual([{ sectionIndex: 0, charOffset: 0, label: "1" }]);
    });

    it("breaks every interval characters within a long node", () => {
        const markers = collect([{ length: 1, nodes: [4000] }]);
        expect(markers.map((m) => m.charOffset)).toEqual([0, 1800, 3600]);
    });

    it("does not carry a crossing node's remainder toward the next break", () => {
        const markers = collect([{ length: 1, nodes: [1000, 1000, 1000] }]);
        expect(markers.map((m) => m.charOffset)).toEqual([0, 2800]);
    });

    it("continues the global ordinal across sections and resets the per-section budget", () => {
        const markers = collect([
            { length: 1, nodes: [500] },
            { length: 1, nodes: [500] },
        ]);
        expect(markers).toEqual([
            { sectionIndex: 0, charOffset: 0, label: "1" },
            { sectionIndex: 1, charOffset: 0, label: "2" },
        ]);
    });

    it("assigns each position the ordinal of its nearest preceding marker", () => {
        const markers = collect([{ length: 1, nodes: [4000] }]);
        const mapping = { isPhysical: true as const, markers };
        expect(pageOrdinalForPosition(mapping, 0, 0)).toBe(1);
        expect(pageOrdinalForPosition(mapping, 0, 1799)).toBe(1);
        expect(pageOrdinalForPosition(mapping, 0, 1800)).toBe(2);
        expect(pageOrdinalForPosition(mapping, 0, 3600)).toBe(3);
    });
});
