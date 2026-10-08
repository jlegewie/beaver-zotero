import { describe, expect, it } from "vitest";

import type { BoundingBox } from "@beaver/agent-core/extract/types";
import { projectStructuredPage } from "../../../src/beaver-extract/schema/canonicalProjection";
import type { PageLine } from "../../../src/beaver-extract/LineDetector";
import type { DraftItem } from "../../../src/beaver-extract/pipeline/draftItems";
import {
    applyReferencePlan,
    isCaptionLabel,
    isNonEntryLabel,
    planReferences,
    type ReferencePagePlan,
} from "../../../src/beaver-extract/references/classify";
import type { InputItem, InputLine, InputPage } from "../../../src/beaver-extract/features/itemInput";

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

describe("planReferences", () => {
    // An author-year list without terminal periods, its entries hanging from
    // an outer edge (120) to an inner one (136). The paragraph detector cut
    // it badly: one-line entries run together, continuation lines broke off
    // their entries, and the item scores alone miss such fragments.
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

    it("splits run-together entries of a hanging list where a line opens at the outer edge", () => {
        const [, plan] = planReferences(document(), 10);
        expect(plan.reference[0]).toBe(true);
        expect(plan.splits[0]).toEqual([1, 2, 3]);
        expect(plan.mergeWithPrevious[1]).toBe(true);
    });

    it("joins a continuation the item scores miss to the entry it continues", () => {
        const [, plan] = planReferences(document(), 10);
        // "408" finishes the Hutchings entry split off the item before it.
        expect(plan.probs[3]).toBeLessThan(0.6);
        expect(plan.reference[3]).toBe(true);
        expect(plan.mergeWithPrevious[3]).toBe(true);
        expect(plan.splits[2]).toEqual([1]);
    });

    it("leaves a flush-left list alone when an indented paragraph after it is rejected", () => {
        // The paragraph's indented lines would make the list read as hanging,
        // and "Harvard University Press." would open an entry at its outer edge.
        let t = 60;
        const line = (text: string, l = 72, r = 540): InputLine => {
            const out: InputLine = { text, l, t, r, b: t + 10, size: 10, role: 0, lead: 1 };
            t += 12;
            return out;
        };
        const item = (lines: InputLine[], header = false): InputItem => ({
            header,
            column: 0,
            text: lines.map((l) => l.text).join(" "),
            lines,
        });
        const items = [
            item([line("References", 72, 150)], true),
            item([
                line("Smith, J. (2001). A study of social structure and its consequences for urban neighborhoods. Cambridge, MA:"),
                line("Harvard University Press.", 72, 200),
            ]),
            item([line("Jones, K. (2002). Networks and neighborhoods. American Journal of Sociology, 108(2), 1–45.", 72, 500)]),
            item([line("Brown, A. (2003). Collective efficacy revisited. Annual Review of Sociology, 29, 101–130.", 72, 480)]),
            item([
                line("Supplementary material for this article is available online, including the data and code used in the", 90),
                line("analyses and additional robustness checks referred to in the text.", 90, 400),
            ]),
        ];
        const [plan] = planReferences([{ pageIndex: 9, width: 612, height: 792, bodySize: 10, items }], 10);
        expect(plan.reference).toEqual([false, true, true, true, false]);
        expect(plan.splits).toEqual([[], [], [], [], []]);
    });

    describe("text after an unpunctuated list", () => {
        // Entries end without a final period ("… Cambridge Univ. Press") and
        // hang at an inner edge (136) that the text after the list shares.
        function tail(last: string[], after: string[], rest: string[][] = []): ReferencePagePlan {
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
            const items = [
                item([line("References", 120, 180)], true),
                item([
                    line("Fortner MJ. 2015. Black Silent Majority: Urban Politics and the Rockefeller Drug Laws. Cambridge, MA:"),
                    line("Harvard Univ. Press", 136, 220),
                ]),
                item([
                    line("Garland D. 2001. The Culture of Control: Crime and Social Order in Contemporary Society. Chicago:"),
                    line("Univ. Chicago Press", 136, 220),
                ]),
                item(last.map((text, k) => line(text, k === 0 ? 120 : 136))),
                item(after.map((text) => line(text, 136, 440))),
                ...rest.map((texts) => item(texts.map((text, k) => line(text, k === 0 ? 120 : 136)))),
            ];
            return planReferences([{ pageIndex: 9, width: 531, height: 657, bodySize: 8, items }], 10)[0];
        }

        it("keeps a prose paragraph out of the last entry", () => {
            const plan = tail(
                ["Gest T. 2003. Crime and Politics: Big Government's Erratic Campaign for Law and Order. New York:", "Cambridge Univ. Press"],
                [
                    "Supplementary material for this article is available online, including the data and code used",
                    "in the analyses and additional robustness checks referred to in the text",
                ],
            );
            expect(plan.reference[4]).toBe(false);
            expect(plan.mergeWithPrevious[4]).toBe(false);
        });

        it("keeps text out of an entry that a lowercase word finishes", () => {
            const last = ["Gest T. 2023. Crime and Politics: Big Government's Erratic Campaign for Law and Order.", "Cambridge University Press, in press"];
            for (const after of [
                [
                    "Supplementary material for this article is available online, including the data and code used",
                    "in the analyses and additional robustness checks referred to in the text",
                ],
                ["Online Appendix"],
            ]) {
                const plan = tail(last, after);
                expect(plan.reference[4], after[0]).toBe(false);
                expect(plan.mergeWithPrevious[4], after[0]).toBe(false);
            }
        });

        it("keeps prose out of an entry whose last line looks open", () => {
            const plan = tail(
                ["Gest T. 2003. Crime and Politics: Big Government's Erratic Campaign for Law and Order. New York:", "Cambridge Univ. Press,"],
                [
                    "The authors thank the editors and three anonymous reviewers. This work was presented at the 2019",
                    "annual meeting, and we are grateful to its participants for their comments",
                ],
            );
            expect(plan.reference[4]).toBe(false);
            expect(plan.mergeWithPrevious[4]).toBe(false);
        });

        it("keeps publication history out of the last entry", () => {
            const plan = tail(
                ["Gest T. 2003. Crime and Politics: Big Government's Erratic Campaign for Law and Order. New York:", "Cambridge Univ. Press"],
                ["Received for publication September 2019"],
            );
            expect(plan.reference[4]).toBe(false);
            expect(plan.mergeWithPrevious[4]).toBe(false);
        });

        it("keeps an appendix label out of the last entry", () => {
            const last = ["Gest T. 2003. Crime and Politics: Big Government's Erratic Campaign for Law and Order. New York:", "Cambridge Univ. Press"];
            for (const label of ["Appendix A: Journal Coverage", "Online Appendix B. Journal Sample", "Supplementary Appendix: Review Articles"]) {
                const plan = tail(last, [label]);
                expect(plan.reference[4], label).toBe(false);
                expect(plan.mergeWithPrevious[4], label).toBe(false);
            }
        });

        it("does not reach across an appendix label for a list that resumes after it", () => {
            const plan = tail(
                ["Gest T. 2003. Crime and Politics: Big Government's Erratic Campaign for Law and Order. New York:", "Cambridge Univ. Press"],
                ["Supplementary material for this article is available online."],
                [
                    ["Appendix A: Journal Coverage"],
                    ["Gordon DR. 1990. The Justice Juggernaut: Fighting Street Crime, Controlling Citizens. New Brunswick, NJ:", "Rutgers Univ. Press"],
                ],
            );
            expect(plan.reference[4]).toBe(false);
            expect(plan.mergeWithPrevious[4]).toBe(false);
        });

        it("joins the rest of an entry its last line leaves open", () => {
            const plan = tail(["Zuboff S. 2019. The Age of Surveillance Capitalism: The Fight for a Human Future. Public Affairs,"], ["New York"]);
            expect(plan.probs[4]).toBeLessThan(0.6);
            expect(plan.reference[4]).toBe(true);
            expect(plan.mergeWithPrevious[4]).toBe(true);
        });

        it("joins a bibliographic tail to an entry that looks finished", () => {
            const plan = tail(
                ["Overholtzer M, Brugge JS. 2008. The cell biology of the entosis pathway and its consequences. Nat. Rev. Mol. Cell"],
                ["Biol. 9:796–809"],
            );
            expect(plan.probs[4]).toBeLessThan(0.6);
            expect(plan.reference[4]).toBe(true);
            expect(plan.mergeWithPrevious[4]).toBe(true);
        });
    });

    it("keeps what follows a finished last entry out of the list", () => {
        const [, plan] = planReferences(document(), 10);
        expect(plan.reference[5]).toBe(false);
        expect(plan.mergeWithPrevious[5]).toBe(false);
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
