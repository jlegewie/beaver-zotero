import { describe, expect, it } from "vitest";

import type { BoundingBox } from "@beaver/agent-core/extract/types";
import { projectStructuredPage } from "../../../src/beaver-extract/schema/canonicalProjection";
import type { PageLine } from "../../../src/beaver-extract/LineDetector";
import type { DraftItem } from "../../../src/beaver-extract/pipeline/draftItems";
import {
    applyReferencePlan,
    isCaptionLabel,
    isNonEntryLabel,
    planEntries,
    type EntryPagePlan,
} from "../../../src/beaver-extract/references/entries";
import { buildInputPage, type InputItem, type InputLine, type InputPage } from "../../../src/beaver-extract/features/itemInput";
import type { StyleProfile } from "@beaver/agent-core/extract/types";

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

function plan(n: number, edits: Partial<EntryPagePlan>): EntryPagePlan {
    return {
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

    it("merges a continuation into a previous reference that ends in its column", () => {
        const input = draft(
            [
                [pageLine("3. Singh, P., et al., Antimicrobial Effects.", 100), pageLine("Nanomaterials, 2018. 8(12):", 112)],
                [pageLine("p. 1009.", 124, 70)],
            ],
            undefined,
            [0, 1],
        );
        expect(applyReferencePlan(input, plan(2, { mergeWithPrevious: [false, true] }))).toHaveLength(2);
        // The first entry was joined across stacked blocks: its second line is in block 1.
        Object.assign(input[0], { endColumnIndex: 1, lineColumns: [0, 1] });
        const out = applyReferencePlan(input, plan(2, { mergeWithPrevious: [false, true] }));
        expect(out.map((i) => i.text)).toEqual(["3. Singh, P., et al., Antimicrobial Effects. Nanomaterials, 2018. 8(12): p. 1009."]);
        expect(out[0]).toMatchObject({ columnIndex: 0, endColumnIndex: 1, lineColumns: [0, 1, 1] });
    });

    it("derives a rebuilt entry's blocks from its lines, so a merge chain across stacked blocks continues", () => {
        // An entry joined across blocks 0–1, a fragment spanning blocks 1–2, then a continuation in block 2.
        const joined = (text: string, lines: PageLine[], columns: number[]): DraftItem => ({
            ...draftItem(text, lines, columns[0]),
            endColumnIndex: columns[columns.length - 1],
            lineColumns: columns,
        });
        const input = [
            joined("Smith, J. 2010. A title that", [pageLine("Smith, J. 2010. A title that", 100), pageLine("wraps into the next block", 130)], [0, 1]),
            joined("and on into a third block", [pageLine("and on", 142, 70), pageLine("into a third block", 170, 70)], [1, 2]),
            draftItem("Journal 3: 1-10.", [pageLine("Journal 3: 1-10.", 182, 70)], 2),
        ];
        const out = applyReferencePlan(input, plan(3, { mergeWithPrevious: [false, true, true] }));
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ columnIndex: 0, endColumnIndex: 2, lineColumns: [0, 1, 1, 2, 2] });
    });

    it("gives each piece of a split joined entry the blocks of its own lines", () => {
        const lines = [pageLine("Smith, J. 2010. A title.", 100), pageLine("Jones, K. 2011. Another.", 130)];
        const item: DraftItem = { ...draftItem("Smith … Jones …", lines, 0), endColumnIndex: 1, lineColumns: [0, 1] };
        const out = applyReferencePlan([item], plan(1, { splits: [[1]] }));
        expect(out.map((piece) => [piece.columnIndex, piece.endColumnIndex, piece.lineColumns])).toEqual([
            [0, undefined, undefined],
            [1, undefined, undefined],
        ]);
        expect(out[0]).not.toHaveProperty("endColumnIndex");
    });

    it("carries an item's end block into the reference model input", () => {
        const items = draft([[pageLine("Smith, J. 2010. A title", 100)], [pageLine("Jones, K. 2011.", 120)]], undefined, [0, 1]);
        items[0].endColumnIndex = 1;
        const page = buildInputPage({ pageIndex: 0, width: 600, height: 800, items }, {} as StyleProfile);
        expect(page.items.map((item) => [item.column, item.endColumn])).toEqual([[0, 1], [1, undefined]]);
        expect(page.items[1]).not.toHaveProperty("endColumn");
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

describe("planEntries", () => {
    // An author-year list without terminal periods, its entries hanging from
    // an outer edge (120) to an inner one (136). The paragraph detector cut
    // it badly: one-line entries run together and continuation lines broke
    // off their entries.
    function document(): InputPage[] {
        let t = 60;
        const line = (text: string, l = 120, r = 484): InputLine => {
            const out: InputLine = { text, l, t, r, b: t + 8, size: 8, role: 0, lead: 1 };
            t += 11;
            return out;
        };
        const item = (lines: InputLine[], header = false): InputItem => ({
            header,
            column: 0,
            text: lines.map((l) => l.text).join(" "),
            lines,
        });
        const first = [
            item([line("References", 120, 180)], true),
            item([
                line("Fortner MJ. 2015. Black Silent Majority: Urban Politics and the Rockefeller Drug Laws. Cambridge, MA:"),
                line("Harvard Univ. Press", 136, 220),
            ]),
            item([
                line("Francis M. 2014. Civil Rights and the Making of the Modern American State. New York: Cambridge Univ."),
                line("Press", 136, 160),
            ]),
        ];
        t = 40;
        const second = [
            item([
                line("Hayward CR. 2013. How Americans Make Race: Stories, Institutions, Spaces. New York: Cambridge Univ. Press"),
                line("Herbert S. 2006. Citizens, Cops, and Power: Recognizing the Limits of Community. Chicago: Univ. Chicago Press"),
                line("Herzing R. 2016. The magical life of broken windows. See Camp & Heatherton 2016, 267–78", 120, 437),
                line("Hicks CD. 2010. Talk with You Like a Woman: African American Women, Justice, and Reform in New York,"),
            ]),
            item([line("1890–1935. Chapel Hill: Univ. North Carolina Press", 136, 315)]),
            item([
                line("Hull EA. 2006. The Disenfranchisement of Ex-Felons. Philadelphia: Temple Univ. Press", 120, 407),
                line("Hutchings VL, Valentino NA. 2004. The centrality of race in American politics. Annu. Rev. Polit. Sci. 7:383–"),
            ]),
            item([line("408", 136, 148)]),
            item([line("Isaac JC. 2015. The American politics of policing and incarceration. Perspect. Polit. 13:609–16", 120, 433)]),
            item([line("SUPPLEMENT.", 120, 180), line("Data Sharing Statement", 120, 220)]),
        ];
        return [
            { pageIndex: 8, width: 531, height: 657, bodySize: 8, items: first },
            { pageIndex: 9, width: 531, height: 657, bodySize: 8, items: second },
        ];
    }

    it("continues an entry that ends in the block a continuation starts in (an item joined across stacked blocks)", () => {
        const reference = [
            [false, true, true],
            [true, true, true, true, true, false],
        ];
        // The run-together item starts in block 0 and ends in block 1; "1890–1935 …" sits below it in block 1.
        const pages = document();
        pages[1].items.forEach((item, i) => (item.column = i === 0 ? 0 : 1));
        pages[1].items[0].endColumn = 1;
        expect(planEntries(pages, reference)[1].mergeWithPrevious[1]).toBe(true);
        // Without the end block the previous item reads as another column's: no line before, no merge.
        delete pages[1].items[0].endColumn;
        expect(planEntries(pages, reference)[1].mergeWithPrevious[1]).toBe(false);
    });

    it("splits run-together entries and joins broken-off continuations of the items labeled references", () => {
        const pages = document();
        const reference = [
            [false, true, true],
            [true, true, true, true, true, false],
        ];
        const [first, second] = planEntries(pages, reference);
        expect(first.reference).toEqual(reference[0]);
        expect(first.splits).toEqual([[], [], []]);
        expect(second.reference).toEqual(reference[1]);
        // Run-together entries split at the outer edge, and broken-off
        // continuations ("1890–1935 …", "408") join the entry before them.
        expect(second.splits).toEqual([[1, 2, 3], [], [1], [], [], []]);
        expect(second.mergeWithPrevious).toEqual([false, true, false, true, false, false]);
        // Items not labeled references are left alone.
        const none = planEntries(pages, [[false, false, false], [false, false, false, false, false, false]]);
        expect(none[1].splits.every((s) => s.length === 0)).toBe(true);
        expect(none[1].mergeWithPrevious.some(Boolean)).toBe(false);
    });

});

describe("isCaptionLabel", () => {
    it("reads figure and table captions and table notes", () => {
        for (const text of [
            "Table 1. Description of Variables Used in Analyses",
            "TABLE 3.",
            "Figure 2a. Mean SED Composition of School by Student Race/Ethnicity, 2018",
            "Appendix Table 1: Summary Statistics by School Sector (cont.)",
            "Figure A1 - Welcome screen of the AdDownloader CLI.",
            "Fig. 10. Nusselt number comparison",
            "Note: HHI = Herfindahl-Hirschman Index",
            "Source: Issue 1, p. 26.",
        ]) {
            expect(isCaptionLabel(text), text).toBe(true);
        }
    });

    it("leaves reference entries alone", () => {
        for (const text of [
            "Table, J. 2001. Furniture and its uses. London: Penguin.",
            "Figueroa, A. (2019). Exhibits of power. Journal 3: 1–9.",
            "12. Mapping the field. Annual Review 4: 5–6.",
            "Sources of bias in survey research. Public Opin. Q. 12:1–9",
        ]) {
            expect(isCaptionLabel(text), text).toBe(false);
        }
    });
});

describe("isNonEntryLabel", () => {
    it("reads appendix labels as well as captions", () => {
        for (const text of [
            "Appendix A: Journal Coverage",
            "Online Appendix B. Journal Sample",
            "Supplementary Appendix: Review Articles",
            "APPENDICES",
            "Table 1. Description of Variables Used in Analyses",
        ]) {
            expect(isNonEntryLabel(text), text).toBe(true);
        }
    });

    it("leaves sources whose titles start with the word alone", () => {
        for (const text of [
            "Appendix to the Journals of the House of Representatives (1890). Wellington: Government Printer.",
            "Annex, B. (2004). Trade and development. London: Routledge.",
        ]) {
            expect(isNonEntryLabel(text), text).toBe(false);
        }
    });
});
