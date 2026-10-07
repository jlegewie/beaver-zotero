import { describe, expect, it } from "vitest";

import type { BoundingBox } from "@beaver/agent-core/extract/types";
import { projectStructuredPage } from "../../../src/beaver-extract/schema/canonicalProjection";
import type { PageLine } from "../../../src/beaver-extract/LineDetector";
import type { ContentItem, PageParagraphResult } from "../../../src/beaver-extract/ParagraphDetector";
import { applyReferencePlan, type ReferencePagePlan } from "../../../src/beaver-extract/references/classify";

function bbox(l: number, t: number, r: number, b: number): BoundingBox {
    return { l, t, r, b, origin: "top-left" };
}

function pageLine(text: string, t: number, l = 50): PageLine {
    const box = bbox(l, t, 500, t + 10);
    return { spans: [], bboxes: [box], bbox: box, text };
}

function contentItem(text: string, lines: PageLine[], columnIndex = 0, type: ContentItem["type"] = "paragraph"): ContentItem {
    return {
        type,
        idx: 0,
        docIdx: 0,
        start: 0,
        end: 0,
        text: type === "header" ? `## ${text}` : text,
        id: "",
        bbox: bbox(50, lines[0].bbox.t, 500, lines[lines.length - 1].bbox.b),
        columnIndex,
    };
}

function result(groups: PageLine[][], types?: ContentItem["type"][], columns?: number[]): PageParagraphResult {
    const items = groups.map((g, i) => contentItem(g.map((l) => l.text).join(" "), g, columns?.[i] ?? 0, types?.[i]));
    return {
        pageIndex: 3,
        width: 600,
        height: 800,
        pageContent: "",
        items,
        paragraphCount: items.length,
        headerCount: 0,
        itemLines: groups,
        itemLineRoles: groups.map((g) => g.map(() => null)),
    };
}

function plan(n: number, edits: Partial<ReferencePagePlan>): ReferencePagePlan {
    return {
        probs: new Array(n).fill(0.9),
        reference: new Array(n).fill(true),
        splits: Array.from({ length: n }, () => []),
        mergeWithPrevious: new Array(n).fill(false),
        ...edits,
    };
}

describe("applyReferencePlan", () => {
    it("returns the result unchanged when the plan only relabels", () => {
        const input = result([[pageLine("References", 80)], [pageLine("Smith, J. 2001. Title.", 100)]]);
        const { result: out, references } = applyReferencePlan(input, plan(2, { reference: [false, true] }));
        expect(out).toBe(input);
        expect([...references]).toEqual([1]);
    });

    it("splits an item where a new entry starts", () => {
        const input = result([[
            pageLine("26. Kozinets, R.V. Influencers. Sage, 2023.", 100),
            pageLine("27. DeFrank, R.S. Executive travel stress. Acad. Manag.", 112),
            pageLine("Perspect. 2000, 14, 58–71.", 124, 70),
        ]]);
        const { result: out, references } = applyReferencePlan(input, plan(1, { splits: [[1]] }));
        expect(out.items.map((i) => i.text)).toEqual([
            "26. Kozinets, R.V. Influencers. Sage, 2023.",
            "27. DeFrank, R.S. Executive travel stress. Acad. Manag. Perspect. 2000, 14, 58–71.",
        ]);
        expect(out.items.map((i) => i.id)).toEqual(["p3:i0", "p3:i1"]);
        expect(out.items[1].bbox.t).toBe(112);
        expect(out.itemLines!.map((g) => g.length)).toEqual([1, 2]);
        expect([...references]).toEqual([0, 1]);
    });

    it("merges a continuation into the previous reference in the same column only", () => {
        const input = result(
            [
                [pageLine("3. Singh, P., et al., Antimicrobial Effects. Nanomaterials, 2018. 8(12):", 100)],
                [pageLine("p. 1009.", 112, 70)],
                [pageLine("continues across the column break.", 40)],
            ],
            undefined,
            [0, 0, 1],
        );
        const { result: out, references } = applyReferencePlan(
            input,
            plan(3, { mergeWithPrevious: [false, true, true] }),
        );
        expect(out.items.map((i) => i.text)).toEqual([
            "3. Singh, P., et al., Antimicrobial Effects. Nanomaterials, 2018. 8(12): p. 1009.",
            "continues across the column break.",
        ]);
        expect([...references]).toEqual([0, 1]);
    });

    it("merges an item's opening lines into the previous entry and keeps its later entries apart", () => {
        const input = result([
            [pageLine("4. Lee, K. 2001. A study of", 100)],
            [pageLine("something. Journal 2: 1–9.", 112, 70), pageLine("5. Park, J. 2003. Title. Review 4: 5–6.", 124)],
        ]);
        const { result: out, references } = applyReferencePlan(
            input,
            plan(2, { mergeWithPrevious: [false, true], splits: [[], [1]] }),
        );
        expect(out.items.map((i) => i.text)).toEqual([
            "4. Lee, K. 2001. A study of something. Journal 2: 1–9.",
            "5. Park, J. 2003. Title. Review 4: 5–6.",
        ]);
        expect([...references]).toEqual([0, 1]);
    });

    it("emits a list heading split off the first entry as a heading", () => {
        const input = result([[pageLine("FURTHER READING", 100), pageLine("Heyman, K. Science 313, 604–606 (2006).", 112)]]);
        const { result: out, references } = applyReferencePlan(input, plan(1, { splits: [[1]] }));
        expect(out.items.map((i) => [i.type, i.text])).toEqual([
            ["header", "## FURTHER READING"],
            ["paragraph", "Heyman, K. Science 313, 604–606 (2006)."],
        ]);
        expect([...references]).toEqual([1]);
    });

    it("never merges into a non-reference item, and drops the heading marker of a reference", () => {
        const input = result(
            [[pageLine("Smith, J. 2001.", 100)], [pageLine("Jones, K. 2002. Title.", 112)]],
            ["paragraph", "header"],
        );
        const { result: out, references } = applyReferencePlan(
            input,
            plan(2, { reference: [false, true], mergeWithPrevious: [false, true], splits: [[], []] }),
        );
        expect(out.items).toHaveLength(2);
        expect(out.items[1].type).toBe("paragraph");
        expect(out.items[1].text).toBe("Jones, K. 2002. Title.");
        expect([...references]).toEqual([1]);
    });
});

describe("reference items in the structured projection", () => {
    it("projects a reference item with text and one bbox, and no sentences", () => {
        const page = projectStructuredPage({
            index: 0,
            width: 600,
            height: 800,
            viewBox: [0, 0, 600, 800],
            rotation: 0,
            items: [{
                id: "p0:i0",
                kind: "reference",
                pageIndex: 0,
                index: 0,
                bbox: bbox(50, 100, 500, 122),
                columnIndex: 0,
                text: "Smith, J. 2001. Title. Journal 3: 1–9.",
                lines: [],
            }],
            sentences: [],
        });
        expect(page.items).toEqual([{
            id: "p0:i0",
            kind: "reference",
            pageIndex: 0,
            order: 0,
            bbox: [50, 100, 500, 122],
            text: "Smith, J. 2001. Title. Journal 3: 1–9.",
        }]);
    });
});
