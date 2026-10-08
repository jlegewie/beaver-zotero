import { describe, expect, it } from "vitest";

import {
    CONTEXT_FEATURES,
    ITEM_FEATURES,
    contextFeatures,
    isNotesHeading,
    isReferenceHeading,
    itemFeatures,
    leadingNumber,
} from "../../../src/beaver-extract/references/features";
import { LINE_FEATURES, hangingLevels, opensLikeEntry, pageLineFeatures } from "../../../src/beaver-extract/references/lines";
import type { RefItem, RefLine, RefPage } from "../../../src/beaver-extract/references/pageInput";

function line(text: string, l: number, t: number, role: 0 | 1 | 2 = 0, r = 500): RefLine {
    return { text, l, t, r, b: t + 10, size: 10, role, lead: 1 };
}

function item(text: string, lines: RefLine[] = [line(text, 50, 100)], header = false): RefItem {
    return { header, column: 0, text, lines };
}

function page(items: RefItem[], pageIndex = 0): RefPage {
    return { pageIndex, width: 600, height: 800, bodySize: 10, items };
}

function feature(values: number[], name: (typeof ITEM_FEATURES)[number]): number {
    return values[ITEM_FEATURES.indexOf(name)];
}

describe("reference item features", () => {
    it("reads author-year, numbered and initials-first entry starts", () => {
        const p = page([]);
        const apa = itemFeatures(item("Immerschitt, Wolfgang; Stumpf, Marcus (2014): Employer Branding. Wiesbaden: Springer."), p);
        expect(feature(apa, "authorStart")).toBe(1);
        expect(feature(apa, "parenYear")).toBe(1);
        expect(feature(apa, "venueWord")).toBe(0);

        const physics = itemFeatures(item("[1] N. Armitage, E. Mele, and A. Vishwanath, Reviews of Modern Physics 90, 015001 (2018)."), p);
        expect(feature(physics, "numbered")).toBe(1);
        expect(feature(physics, "initialsStart")).toBe(1);

        const dash = itemFeatures(item("———. Consumer Demand: A New Approach. New York: Columbia Univ. Press, 1971."), p);
        expect(feature(dash, "dashStart")).toBe(1);
    });

    it("flags footnote idioms and prose", () => {
        const p = page([]);
        const note = itemFeatures(item("12. Ibid., p. 265; cf. Turner, Hitler's Thirty Days to Power, 167."), p);
        expect(feature(note, "noteCues")).toBe(1);
        const prose = itemFeatures(item("We find that the effect is larger when this group has more members than it would otherwise."), p);
        expect(feature(prose, "prose")).toBeGreaterThan(0.5);
        expect(feature(prose, "authorStart")).toBe(0);
    });

    it("measures a hanging indent in em and reads the detector's roles", () => {
        const lines = [line("Smith, J. (2001). A long title that wraps onto", 50, 100, 1), line("the next line. Journal 3: 1–9.", 70, 112, 2)];
        const f = itemFeatures(item(lines.map((l) => l.text).join(" "), lines), page([]));
        expect(feature(f, "hangIndent")).toBeCloseTo(2 / 5);
        expect(feature(f, "hangEntry")).toBe(1);
        expect(feature(f, "hangCont")).toBe(1);
    });
});

describe("reference context features", () => {
    const col = (name: (typeof CONTEXT_FEATURES)[number]) => CONTEXT_FEATURES.indexOf(name);

    it("tracks reference and notes headings in reading order across pages", () => {
        const pages = [
            page([item("Body text."), item("References", undefined, true), item("1. Smith, J. 2001. Title.")], 0),
            page([item("2. Jones, K. 2002. Title."), item("Notes", undefined, true), item("1. Ibid.")], 1),
        ];
        const ctx = contextFeatures(pages, 2);
        expect(ctx[0][0][col("refHeading")]).toBe(0);
        expect(ctx[0][1][col("listHeading")]).toBe(1);
        expect(ctx[0][2][col("refHeading")]).toBe(1);
        expect(ctx[0][2][col("refHeadingPage")]).toBe(1);
        expect(ctx[1][0][col("refHeading")]).toBe(1);
        expect(ctx[1][0][col("refHeadingPage")]).toBe(0);
        expect(ctx[1][2][col("notesHeading")]).toBe(1);
    });

    it("marks consecutive list numbers, including across a page break", () => {
        const pages = [
            page([item("7. Smith, J. 2001."), item("8. Jones, K. 2002.")], 0),
            page([item("9. Brown, A. 2003."), item("Results were 4. robust")], 1),
        ];
        const ctx = contextFeatures(pages, 2);
        expect(ctx[0][0][col("numberSeq")]).toBe(1);
        expect(ctx[1][0][col("numberSeq")]).toBe(1);
        expect(ctx[1][1][col("numberSeq")]).toBe(0);
    });

    it("recognizes headings and leaders", () => {
        expect(isReferenceHeading(item("Literaturverzeichnis"))).toBe(true);
        expect(isReferenceHeading(item("7. References"))).toBe(true);
        expect(isReferenceHeading(item("Sources", undefined, false))).toBe(false);
        expect(isReferenceHeading(item("Sources", undefined, true))).toBe(true);
        expect(isNotesHeading(item("Endnotes"))).toBe(true);
        expect(leadingNumber("[12] Smith")).toBe(12);
        expect(leadingNumber("12. Smith")).toBe(12);
        expect(leadingNumber("2.5 Results")).toBeNull();
    });

    it("recognizes reference headings behind an ornament or a letter, and compound names", () => {
        for (const text of [
            "■ References",
            "G. Bibliography",
            "SELECT BIBLIOGRAPHY",
            "References and recommended reading",
            "Additional references",
            "Works Consulted",
            "Further Readings",
        ]) {
            expect(isReferenceHeading(item(text)), text).toBe(true);
        }
        for (const text of ["Referencing styles", "The references", "Table 1. References"]) {
            expect(isReferenceHeading(item(text)), text).toBe(false);
        }
        expect(isNotesHeading(item("• Notes"))).toBe(true);
    });
});

describe("reference line features", () => {
    it("sees a numbered entry starting inside an item and the previous item's last line", () => {
        const first = item("26. Kozinets, R.V. Influencers; Sage: New York, 2023.", [line("26. Kozinets, R.V. Influencers; Sage: New York, 2023.", 36, 75, 0, 300)]);
        const merged = item("27. DeFrank, R.S. Executive travel stress. 2000, 14, 58–71. 28. Williams", [
            line("27. DeFrank, R.S. Executive travel stress. Acad. Manag. Perspect. 2000,", 36, 88, 0, 560),
            line("14, 58–71. [CrossRef]", 57, 100, 2, 140),
            line("28. Williams, N.; Ivanov, S. Algorithmic ghost in the research shell", 36, 113, 1, 559),
        ]);
        const rows = pageLineFeatures(page([first, merged]), (i) => i === 1).get(1)!;
        const f = (k: number, name: (typeof LINE_FEATURES)[number]) => rows[k][LINE_FEATURES.indexOf(name)];
        expect(rows).toHaveLength(3);
        expect(f(0, "hasPrev")).toBe(1);
        expect(f(0, "numberNext")).toBe(1);
        expect(f(1, "roleCont")).toBe(1);
        expect(f(2, "numberNext")).toBe(1);
        expect(f(2, "roleEntry")).toBe(1);
        expect(f(2, "dxPrev")).toBeLessThan(0);
        expect(f(2, "prevGapRight")).toBeGreaterThan(0.5);
    });
});

describe("hanging-indent list levels", () => {
    // An author-year list without terminal periods: entries open at the
    // outer edge, wrap to the inner edge, and one-line entries follow each
    // other at the outer edge with no layout cue between them.
    const outer = ["Hayward CR. 2013. How Americans Make Race. New York: Cambridge Univ. Press",
        "Herbert S. 2006. Citizens, Cops, and Power: Recognizing the Limits of Community. Chicago:",
        "Hinton E. 2016. From the War on Poverty to the War on Crime: The Making of Mass",
        "Huber E, Stephens JD. 2001. Development and Crisis of the Welfare State. Chicago:"];
    const inner = ["Univ. Chicago Press", "Incarceration in America. Cambridge, MA: Harvard Univ. Press", "Univ. Chicago Press"];
    const lines = [
        line(outer[0], 120, 40),
        line(outer[1], 120, 51),
        line(inner[0], 136, 62),
        line(outer[2], 120, 73),
        line(inner[1], 136, 84),
        line(outer[3], 120, 95),
        line(inner[2], 136, 106),
    ];

    it("reads outer and inner edges when outer lines open entries and inner lines don't", () => {
        const p = { ...page([item("", lines.slice(0, 2)), item("", lines.slice(2))]), bodySize: 8 };
        const levels = hangingLevels(p, () => true);
        expect(levels.get(0)).toEqual(["outer", "outer"]);
        expect(levels.get(1)).toEqual(["inner", "outer", "inner", "outer", "inner"]);
    });

    it("follows an outer edge that drifts down a scanned page", () => {
        const drifted = lines.map((l, k) => ({ ...l, l: l.l - 0.3 * k }));
        const p = { ...page([item("", drifted)]), bodySize: 8 };
        expect(hangingLevels(p, () => true).get(0)).toEqual(["outer", "outer", "inner", "outer", "inner", "outer", "inner"]);
    });

    it("reads nothing when the indented lines are the entry starts", () => {
        // First-line indent: entries open at the inner edge and wrap to the outer one.
        const indented = [
            line("Hayward CR. 2013. How Americans Make Race: Stories, Institutions,", 136, 40),
            line("Spaces. New York: Cambridge Univ. Press", 120, 51),
            line("Herbert S. 2006. Citizens, Cops, and Power: Recognizing the Limits", 136, 62),
            line("of Community. Chicago: Univ. Chicago Press", 120, 73),
            line("Hinton E. 2016. From the War on Poverty to the War on Crime: The", 136, 84),
            line("Making of Mass Incarceration in America. Cambridge, MA: Harvard", 120, 95),
        ];
        const p = { ...page([item("", indented)]), bodySize: 8 };
        expect(hangingLevels(p, () => true).size).toBe(0);
    });

    it("counts list numbers, authors with initials and repeated-author dashes as entry openings", () => {
        expect(opensLikeEntry("Herbert S. 2006. Citizens")).toBe(true);
        expect(opensLikeEntry("Anderson, A. O. and M. O., ed.")).toBe(true);
        expect(opensLikeEntry("[12] Smith")).toBe(true);
        expect(opensLikeEntry("- ed. The Life of Bishop Wilfrid")).toBe(true);
        expect(opensLikeEntry("1897).")).toBe(false);
        expect(opensLikeEntry("(1920), pp. 5-136.")).toBe(false);
        expect(opensLikeEntry("Memorial Lecture, Proceedings of the British Academy")).toBe(false);
        expect(opensLikeEntry("Cambridge, MA: Harvard Univ. Press")).toBe(false);
    });
});
