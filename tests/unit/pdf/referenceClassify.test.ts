import { describe, expect, it } from "vitest";

import type { BoundingBox } from "@beaver/agent-core/extract/types";
import { projectStructuredPage } from "../../../src/beaver-extract/schema/canonicalProjection";
import type { PageLine } from "../../../src/beaver-extract/LineDetector";
import type { DraftItem } from "../../../src/beaver-extract/pipeline/draftItems";
import { applyReferencePlan, type ReferencePagePlan } from "../../../src/beaver-extract/references/classify";

function bbox(l: number, t: number, r: number, b: number): BoundingBox {
    return { l, t, r, b, origin: "top-left" };
}

function pageLine(text: string, t: number, l = 50): PageLine {
    const box = bbox(l, t, 500, t + 10);
    return { spans: [], bboxes: [box], bbox: box, text };
}

function draftItem(text: string, lines: PageLine[], columnIndex = 0, kind: DraftItem["kind"] = "text"): DraftItem {
    return {
        kind,
        lines,
        roles: lines.map(() => null),
        columnIndex,
        bbox: bbox(50, lines[0].bbox.t, 500, lines[lines.length - 1].bbox.b),
        text,
    };
}

function draft(groups: PageLine[][], kinds?: DraftItem["kind"][], columns?: number[]): DraftItem[] {
    return groups.map((g, i) => draftItem(g.map((l) => l.text).join(" "), g, columns?.[i] ?? 0, kinds?.[i]));
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
    it("only relabels reference items when the plan neither splits nor merges", () => {
        const input = draft([[pageLine("References", 80)], [pageLine("Smith, J. 2001. Title.", 100)]], ["section_header", "text"]);
        const out = applyReferencePlan(input, plan(2, { reference: [false, true] }));
        expect(out[0]).toBe(input[0]);
        expect(out[1]).toEqual({ ...input[1], kind: "reference" });
        expect(input[1].kind).toBe("text");
    });

    it("splits an item where a new entry starts", () => {
        const input = draft([[
            pageLine("26. Kozinets, R.V. Influencers. Sage, 2023.", 100),
            pageLine("27. DeFrank, R.S. Executive travel stress. Acad. Manag.", 112),
            pageLine("Perspect. 2000, 14, 58–71.", 124, 70),
        ]]);
        const out = applyReferencePlan(input, plan(1, { splits: [[1]] }));
        expect(out.map((i) => i.text)).toEqual([
            "26. Kozinets, R.V. Influencers. Sage, 2023.",
            "27. DeFrank, R.S. Executive travel stress. Acad. Manag. Perspect. 2000, 14, 58–71.",
        ]);
        expect(out[1].bbox.t).toBe(112);
        expect(out.map((i) => i.lines.length)).toEqual([1, 2]);
        expect(out.map((i) => i.roles.length)).toEqual([1, 2]);
        expect(out.map((i) => i.kind)).toEqual(["reference", "reference"]);
    });

    it("merges a continuation into the previous reference in the same column only", () => {
        const input = draft(
            [
                [pageLine("3. Singh, P., et al., Antimicrobial Effects. Nanomaterials, 2018. 8(12):", 100)],
                [pageLine("p. 1009.", 112, 70)],
                [pageLine("continues across the column break.", 40)],
            ],
            undefined,
            [0, 0, 1],
        );
        const out = applyReferencePlan(input, plan(3, { mergeWithPrevious: [false, true, true] }));
        expect(out.map((i) => i.text)).toEqual([
            "3. Singh, P., et al., Antimicrobial Effects. Nanomaterials, 2018. 8(12): p. 1009.",
            "continues across the column break.",
        ]);
        expect(out.map((i) => i.kind)).toEqual(["reference", "reference"]);
    });

    it("merges an item's opening lines into the previous entry and keeps its later entries apart", () => {
        const input = draft([
            [pageLine("4. Lee, K. 2001. A study of", 100)],
            [pageLine("something. Journal 2: 1–9.", 112, 70), pageLine("5. Park, J. 2003. Title. Review 4: 5–6.", 124)],
        ]);
        const out = applyReferencePlan(input, plan(2, { mergeWithPrevious: [false, true], splits: [[], [1]] }));
        expect(out.map((i) => i.text)).toEqual([
            "4. Lee, K. 2001. A study of something. Journal 2: 1–9.",
            "5. Park, J. 2003. Title. Review 4: 5–6.",
        ]);
        expect(out.map((i) => i.kind)).toEqual(["reference", "reference"]);
    });

    it("emits a list heading split off the first entry as a heading", () => {
        const input = draft([[pageLine("FURTHER READING", 100), pageLine("Heyman, K. Science 313, 604–606 (2006).", 112)]]);
        const out = applyReferencePlan(input, plan(1, { splits: [[1]] }));
        expect(out.map((i) => [i.kind, i.text])).toEqual([
            ["section_header", "FURTHER READING"],
            ["reference", "Heyman, K. Science 313, 604–606 (2006)."],
        ]);
    });

    it("never merges into a non-reference item, and relabels a heading read as a reference", () => {
        const input = draft(
            [[pageLine("Smith, J. 2001.", 100)], [pageLine("Jones, K. 2002. Title.", 112)]],
            ["text", "section_header"],
        );
        const out = applyReferencePlan(
            input,
            plan(2, { reference: [false, true], mergeWithPrevious: [false, true], splits: [[], []] }),
        );
        expect(out.map((i) => [i.kind, i.text])).toEqual([
            ["text", "Smith, J. 2001."],
            ["reference", "Jones, K. 2002. Title."],
        ]);
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
