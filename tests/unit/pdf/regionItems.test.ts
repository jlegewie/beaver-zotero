import { describe, expect, it } from "vitest";

import type {
    BoundingBox,
    DocItem,
    RawLineDetailed,
    RawPageDataDetailed,
    SentenceItem,
} from "@beaver/agent-core/extract/types";

import { detectColumns } from "../../../src/beaver-extract/ColumnDetector";
import { inverseRotateBBox } from "../../../src/beaver-extract/PageRotationNormalizer";
import type { Rect } from "../../../src/beaver-extract/regions/geometry";
import type { RegionClass } from "../../../src/beaver-extract/regions/model";
import { mergeRowFragments, pageLines } from "../../../src/beaver-extract/regions/pageSignals";
import {
    LINE_FURNITURE,
    LINE_RUNNING,
    LINE_SKEWED,
    type DetectedRegion,
    type RegionDetection,
} from "../../../src/beaver-extract/regions/RegionDetector";
import {
    PICTURE_TEXT_MAX_CHARS,
    placeRegionItems,
    regionItemsForPage,
    splitRegionItems,
    type RegionItemDraft,
} from "../../../src/beaver-extract/regions/regionItems";

const BS = 10;

type Cell = [x0: number, x1: number, text: string];

/** One structured-text line at `y`; cells far apart become separate pieces. */
function line(y: number, cells: Cell[], rotation = 0): RawLineDetailed {
    const chars: { c: string; bbox: BoundingBox }[] = [];
    let text = "";
    cells.forEach(([x0, x1, t], k) => {
        if (k > 0) {
            const prev = chars[chars.length - 1].bbox;
            chars.push({ c: " ", bbox: { l: prev.r, t: y, r: x0, b: y + 11, origin: "top-left" } });
            text += " ";
        }
        const step = (x1 - x0) / t.length;
        [...t].forEach((c, i) => {
            chars.push({ c, bbox: { l: x0 + i * step, t: y, r: x0 + (i + 1) * step, b: y + 11, origin: "top-left" } });
        });
        text += t;
    });
    const font = { name: "Times-Roman", family: "Times", weight: "normal", style: "normal", size: BS };
    return {
        wmode: 0,
        bbox: { l: cells[0][0], t: y, r: cells[cells.length - 1][1], b: y + 11, origin: "top-left" },
        font,
        x: cells[0][0],
        y: y + 11,
        text,
        rotation,
        chars: chars.map((ch) => ({ ...ch, quad: [] })),
        spans: [{ start: 0, font }],
    } as unknown as RawLineDetailed;
}

/** A page whose blocks hold the given lines (one block per group). */
function page(...blocks: RawLineDetailed[][]): RawPageDataDetailed {
    return {
        pageIndex: 0,
        pageNumber: 1,
        width: 612,
        height: 792,
        blocks: blocks.map((lines) => ({
            type: "text",
            bbox: {
                l: Math.min(...lines.map((l) => l.bbox.l)),
                t: Math.min(...lines.map((l) => l.bbox.t)),
                r: Math.max(...lines.map((l) => l.bbox.r)),
                b: Math.max(...lines.map((l) => l.bbox.b)),
                origin: "top-left",
            },
            lines,
        })),
    } as unknown as RawPageDataDetailed;
}

/**
 * A detection with the given classified regions; each visual line goes to the
 * first region containing its centre (running text is modelled by `prose`).
 */
function detection(
    p: RawPageDataDetailed,
    regions: [RegionClass, Rect][],
    prose: (text: string) => boolean = () => false,
): RegionDetection {
    const lines = mergeRowFragments(pageLines(p), []);
    const candidates: DetectedRegion[] = regions.map(([label, bbox]) => ({ bbox, anchored: false, features: [], label }));
    const routes = lines.map((l) => {
        if (prose(l.text)) return -1;
        const cx = (l.bbox[0] + l.bbox[2]) / 2;
        const cy = (l.bbox[1] + l.bbox[3]) / 2;
        return candidates.findIndex((c) => c.label !== "other" && cx >= c.bbox[0] && cx <= c.bbox[2] && cy >= c.bbox[1] && cy <= c.bbox[3]);
    });
    return { pageIndex: 0, scanned: false, bodySize: BS, candidates, routing: { lines, flags: lines.map((l) => (prose(l.text) ? LINE_RUNNING : 0)), routes }, ms: 0 };
}

const PROSE = "the quick brown fox jumps over the lazy dog";
const allText = (p: RawPageDataDetailed) => p.blocks.flatMap((b) => (b.lines ?? []).map((l) => l.text));
const rowTexts = (d: RegionItemDraft, sep = " | ") => d.rows.map((r) => r.map((c) => c.text).join(sep));

describe("regionItemsForPage", () => {
    it("turns table lines into rows of cells and removes them from the page", () => {
        const intro = line(80, [[72, 540, PROSE]]);
        const rows = [
            line(120, [[72, 150, "Variable"], [250, 320, "Model 1"], [400, 470, "Model 2"]]),
            line(135, [[72, 150, "Age"], [250, 320, "0.23"], [400, 470, "0.19"]]),
            line(150, [[72, 150, "Income"], [250, 320, "1.10"], [400, 470, "0.98"]]),
        ];
        const p = page([intro, ...rows]);
        const { page: rest, items } = regionItemsForPage(p, detection(p, [["table", [70, 118, 480, 163]]]));

        expect(items).toHaveLength(1);
        expect(items[0].kind).toBe("table");
        expect(rowTexts(items[0])).toEqual(["Variable | Model 1 | Model 2", "Age | 0.23 | 0.19", "Income | 1.10 | 0.98"]);
        expect(items[0].rows[1][2].bbox.l).toBeCloseTo(400);
        expect(allText(rest)).toEqual([PROSE]);
        // The shrunken block is re-bounded to its remaining line.
        expect(rest.blocks[0].bbox.b).toBe(91);
        expect(allText(p)).toHaveLength(4);
    });

    it("keeps each value of a row with blank cells under its column", () => {
        const rows = [
            line(120, [[72, 150, "Variable"], [250, 320, "Model 1"], [400, 470, "Model 2"], [520, 590, "Model 3"]]),
            line(135, [[72, 150, "Age"], [250, 320, "0.23"], [520, 590, "0.31"]]),
            line(150, [[72, 150, "Income"], [400, 470, "0.98"]]),
            line(165, [[72, 590, "Note: standard errors in parentheses"]]),
        ];
        const p = page(rows);
        const { items } = regionItemsForPage(p, detection(p, [["table", [70, 118, 600, 178]]]));
        expect(items[0].columns).toBe(4);
        expect(items[0].rows[1].map((c) => c.column)).toEqual([0, 1, 3]);
        // A cell spanning several columns leaves its row unaligned.
        expect(items[0].rows[3][0].column).toBeUndefined();

        const out = placeRegionItems(0, [], items);
        expect(out.items[0].text.split("\n")).toEqual([
            "Variable | Model 1 | Model 2 | Model 3",
            "Age | 0.23 | | 0.31",
            "Income | | 0.98 |",
            "Note: standard errors in parentheses",
        ]);
        expect(out.sentences[1].bboxes).toHaveLength(3);
    });

    it("keeps an equation number with its row and leaves wordy lines in the prose", () => {
        const eq = line(200, [[200, 400, "x = α + β y"], [520, 540, "(12)"]]);
        const where = line(215, [[200, 480, "where alpha denotes the average income of households"]]);
        const p = page([eq, where]);
        const { page: rest, items } = regionItemsForPage(p, detection(p, [["formula", [190, 195, 545, 230]]]));

        expect(items.map((i) => i.kind)).toEqual(["formula"]);
        expect(rowTexts(items[0], " ")).toEqual(["x = α + β y (12)"]);
        expect(allText(rest)).toEqual([where.text]);
    });

    it("leaves a formula row of justified prose with inline math in the prose", () => {
        // The prose row is split at its wide word gaps into pieces of one word each; the
        // next row is a running line with inline math in front of it.
        const p = page([
            line(70, [[72, 530, PROSE]]),
            line(82, [[72, 530, PROSE]]),
            line(100, [[72, 120, "Suppose"], [150, 180, "that"], [210, 220, "B"], [250, 310, "bootstrap"], [340, 390, "samples"], [420, 450, "are"], [480, 530, "drawn,"]]),
            line(115, [[72, 160, "z = {z, 1 ≤ a ≤ B}."], [168, 530, "The bootstrapped version of the predictor is"]]),
            line(140, [[200, 330, "θ = Xβ + r(1 − r)"], [500, 530, "(3.2)"]]),
            // A word equation, centred: its variables read as words, but it is no prose line.
            line(165, [[150, 230, "Capital Adjusted"], [280, 295, "="], [345, 440, "Composition Types Total"], [500, 530, "(3.3)"]]),
        ]);
        const prose = (t: string) => t.startsWith("The bootstrapped") || t === PROSE;
        const d = detection(p, [["formula", [70, 95, 540, 180]]], prose);
        const { items, page: rest } = regionItemsForPage(p, d);
        expect(items.map((i) => rowTexts(i))).toEqual([["θ = Xβ + r(1 − r) | (3.2)", "Capital Adjusted | = | Composition Types Total | (3.3)"]]);
        expect(allText(rest)).toHaveLength(4);
    });

    it("keeps figure labels, drops rows of bare numbers and leaves decoration text in the prose", () => {
        const title = line(300, [[150, 350, "GDP growth by region"]]);
        const ticks = line(400, [[150, 160, "0"], [250, 260, "20"], [350, 360, "40"]]);
        const legend = line(420, [[150, 220, "Treatment"], [300, 360, "Control"]]);
        const logo = line(20, [[500, 580, "JOURNAL"]]);
        const p = page([title, ticks, legend], [logo]);
        const { page: rest, items } = regionItemsForPage(
            p,
            detection(p, [
                ["picture", [140, 290, 370, 440]],
                ["decoration", [490, 10, 590, 40]],
            ]),
        );

        expect(items.map((i) => i.kind)).toEqual(["picture"]);
        expect(rowTexts(items[0], " ")).toEqual(["GDP growth by region", "Treatment Control"]);
        expect(allText(rest)).toEqual(["JOURNAL"]);
    });

    it("keeps a figure's data values and drops only the numbers on its axes", () => {
        const yTicks = ["60", "40", "20", "0"].map((t, i) => line(300 + 30 * i, [[100, 110, t]]));
        const xTicks = line(410, [[150, 170, "1990"], [250, 270, "2000"], [350, 370, "2010"]]);
        const values = [line(315, [[180, 196, "43.6"]]), line(345, [[260, 276, "37.9"]]), line(372, [[300, 316, "37%"]])];
        const legend = line(430, [[150, 170, "2015"], [250, 270, "2024"]]);
        const p = page([...yTicks, xTicks, ...values, legend]);
        const { items } = regionItemsForPage(p, detection(p, [["picture", [90, 290, 380, 445]]]));
        // Two numbers are no axis; neither are values beside the marks.
        expect(rowTexts(items[0], " ")).toEqual(["43.6", "37.9", "37%", "2015 2024"]);
    });

    it("finds an axis next to other numbers, and log axes", () => {
        // A y axis, with a value of the next panel lined up below it.
        const ticks = ["2.0", "1.5", "1.0", "0.5", "0.0", "−0.9"].map((t, i) => line(270 + 20 * i, [[100, 112, t]]));
        // A log axis whose exponents lost their raise.
        const log = line(400, [[150, 166, "10−3"], [250, 266, "10−2"], [350, 366, "10−1"]]);
        // Two panels side by side, each with its own x axis on one row.
        const panels = line(380, [0, 1, 2, 3, 4, 5].map((i): Cell => [150 + 35 * i, 158 + 35 * i, String((i % 3) * 5)]));
        const p = page([...ticks, log, panels]);
        const { items } = regionItemsForPage(p, detection(p, [["picture", [90, 260, 380, 415]]]));
        expect(rowTexts(items[0], " ")).toEqual(["−0.9"]);
    });

    it("drops index axes and keeps rows of counts", () => {
        // An index axis starting at 1.
        const index = line(400, [[150, 156, "1"], [245, 265, "100"], [345, 365, "200"], [445, 465, "300"]]);
        // A number-at-risk row: counts, four of them stepping evenly.
        const counts = line(420, [[100, 150, "Placebo"], ...[20, 19, 18, 17, 15, 11, 9].map((n, i): Cell => [200 + 40 * i, 212 + 40 * i, String(n)])]);
        // Labelled rows of evenly stepped counts are data, not scales, however long.
        const short = line(440, [[100, 150, "Placebo"], [200, 212, "20"], [240, 252, "19"], [280, 292, "18"]]);
        const long = line(460, [[100, 150, "Placebo"], ...[20, 19, 18, 17, 16].map((n, i): Cell => [200 + 40 * i, 212 + 40 * i, String(n)])]);
        // A column of counts in such rows, stepping evenly down, likewise.
        const arms = ["60", "50", "40"].map((t, i) => line(480 + 20 * i, [[400, 440, `Arm ${i + 1}`], [470, 482, t]]));
        // A y axis whose tick shares its row with legend text inside the plot is still a scale.
        const yAxis = ["60", "40", "20", "0"].map((t, i) => line(560 + 20 * i, [[420, 432, t]]));
        const legend = line(580, [[450, 510, "Treatment"]]);
        // A label further off than ten type sizes still labels a long row.
        const total = line(540, [[20, 50, "Total"], ...[50, 40, 30, 20, 10].map((n, i): Cell => [200 + 40 * i, 212 + 40 * i, String(n)])]);
        const p = page([index, counts, short, long, ...arms, total, ...yAxis, legend]);
        const { items } = regionItemsForPage(p, detection(p, [["picture", [10, 290, 520, 640]]]));
        expect(rowTexts(items[0], " ")).toEqual([
            "Placebo 20 19 18 17 15 11 9",
            "Placebo 20 19 18",
            "Placebo 20 19 18 17 16",
            "Arm 1 60",
            "Arm 2 50",
            "Arm 3 40",
            "Total 50 40 30 20 10",
            "Treatment",
        ]);
    });

    it("keeps numbers in a row that are not on a linear or logarithmic scale", () => {
        const row = line(400, [[150, 160, "12"], [250, 260, "15"], [350, 360, "31"]]);
        // A sorted bar chart's value labels, evenly spaced and nearly linear: they do not step evenly.
        const bars = ["8.6", "5.6", "2.9"].map((t, i) => line(300 + 20 * i, [[200, 212, t]]));
        // Sorted shares of an oncoplot: runs of three, split by a tie, happen to step evenly.
        const shares = ["12%", "9%", "6%", "6%", "4%", "2%"].map((t, i) => line(300 + 15 * i, [[330, 345, t]]));
        const p = page([...bars, ...shares, row]);
        const { items } = regionItemsForPage(p, detection(p, [["picture", [140, 290, 370, 415]]]));
        const kept = items[0].rows.flat().map((c) => c.text);
        expect(kept.sort()).toEqual(["12", "15", "31", "12%", "2.9", "2%", "4%", "6%", "6%", "5.6", "8.6", "9%"].sort());
    });

    it("leaves a page whose only region is a decoration unchanged", () => {
        const titleLine = line(60, [[72, 400, "The Health System Dynamics Framework"]]);
        const p = page([titleLine]);
        const out = regionItemsForPage(p, detection(p, [["decoration", [60, 40, 420, 90]]]));
        expect(out).toEqual({ page: p, items: [], margin: [] });
    });

    it("sets page furniture aside as margin text, with or without regions", () => {
        const text = line(120, [[72, 540, PROSE]]);
        const mark = line(300, [[150, 450, "UNCORRECTED PROOF"]]);
        const p = page([text], [mark]);
        const d = detection(p, []);
        d.routing!.flags = d.routing!.lines.map((l) => (l.text === "UNCORRECTED PROOF" ? LINE_SKEWED | LINE_FURNITURE : 0));
        const out = regionItemsForPage(p, d);
        expect(out.items).toEqual([]);
        expect(out.margin).toEqual([mark]);
        expect(allText(out.page)).toEqual([PROSE]);

        const figure = line(500, [[150, 300, "Treatment"]]);
        const q = page([text], [mark], [figure]);
        const e = detection(q, [["picture", [140, 490, 310, 520]]]);
        e.routing!.flags = e.routing!.lines.map((l) => (l.text === "UNCORRECTED PROOF" ? LINE_SKEWED | LINE_FURNITURE : 0));
        const withRegion = regionItemsForPage(q, e);
        expect(withRegion.items.map((i) => i.kind)).toEqual(["picture"]);
        expect(withRegion.margin).toEqual([mark]);
        expect(allText(withRegion.page)).toEqual([PROSE]);
    });

    it("starts and ends an equation with its own lines, not with prose its box took", () => {
        // The formula box starts at its lead-in, which stays in the prose.
        const lead = line(100, [[72, 290, "consisting of a static and a dynamic component according to"]]);
        const eq = line(116, [[115, 233, "H(t) = Hwo − HS(t)."], [279, 295, "(21)"]]);
        const p = page([lead, eq]);
        const { items } = regionItemsForPage(p, detection(p, [["formula", [54, 98, 295, 130]]], (t) => t.startsWith("consisting")));
        expect(items).toHaveLength(1);
        expect(items[0].bbox.t).toBe(lead.bbox.b);
        // Across, the box keeps its column's span; below, it keeps what it covers under the
        // equation's text (a fraction's denominator rule, a radical drawn as paths).
        expect(items[0].bbox.l).toBe(54);
        expect(items[0].bbox.b).toBe(130);
        // Prose taken below it: the box ends above it.
        const after = line(132, [[72, 290, "where the static part does not depend on time."]]);
        const below = page([eq, after]);
        const tail = regionItemsForPage(below, detection(below, [["formula", [54, 98, 295, 140]]], (t) => t.startsWith("where")));
        expect(tail.items[0].bbox).toMatchObject({ t: 98, b: after.bbox.t });
        // Without prose taken, the box stays whole.
        const alone = page([eq]);
        expect(regionItemsForPage(alone, detection(alone, [["formula", [54, 98, 295, 130]]])).items[0].bbox).toMatchObject({ t: 98, b: 130 });
    });

    it("starts an equation's box at its own text, not at a lead-in on the row of its top", () => {
        // The lead-in ends the paragraph at the margin, level with the top of the
        // equation's numerator, so the box cannot start below it.
        const para = line(86, [[54, 290, PROSE]]);
        const lead = line(100, [[54, 120, "consumption are"]]);
        const eq = [line(102, [[160, 170, "m"]]), line(110, [[140, 158, "z ="], [180, 210, "(1 + H)"], [279, 295, "(4.5)"]]), line(118, [[155, 175, "1 + m"]])];
        const prose = (t: string) => t === PROSE || t === "consumption are";
        const p = page([para, lead], eq);
        const d = detection(p, [["formula", [54, 98, 295, 130]]], prose);
        const { items, page: rest } = regionItemsForPage(p, d);
        expect(allText(rest)).toEqual([PROSE, "consumption are"]);
        expect(items[0].bbox).toMatchObject({ l: 140, t: 98, r: 295, b: 130 });
        // Rules drawn in the box stay inside it.
        d.routing!.rules = [[135, 113, 175, 114]];
        expect(regionItemsForPage(p, d).items[0].bbox.l).toBe(135);
        // Text beside the equation lower down leaves the box as it is.
        const side = page([para, line(118, [[54, 120, "another column"]])], eq);
        const sd = detection(side, [["formula", [54, 98, 295, 130]]], (t) => t === PROSE || t === "another column");
        expect(regionItemsForPage(side, sd).items[0].bbox.l).toBe(54);
        // So does a display's own text that went to the prose: it starts inside the column.
        const centred = page([para, line(100, [[80, 250, "total effect equals direct plus indirect"]]), line(100, [[279, 295, "(10.3)"]])]);
        const cd = detection(centred, [["formula", [80, 98, 295, 112]]], (t) => t === PROSE || t.startsWith("total effect"));
        expect(regionItemsForPage(centred, cd).items[0].bbox.l).toBe(80);
    });

    it("leaves a formula that is one line of its paragraph, set with inline math, in the prose", () => {
        const full = (y: number, text = "the conditional treatment effect among the stops,") => line(y, [[72, 290, text]]);
        const math = (y: number) => line(y, [[72, 290, "Σx ATEx Pr(Xi = x), Σx ATEx Pr"]]);
        const after = (y: number) => line(y, [[72, 290, "(Xi = x)]. In the appendix we outline a procedure"]]);
        const run = (lines: RawLineDetailed[], eq: Rect) => {
            const p = page(lines);
            const prose = (t: string) => !t.startsWith("Σx");
            return regionItemsForPage(p, detection(p, [["formula", eq]], prose)).items;
        };
        expect(run([full(100), full(113), math(126), after(141)], [70, 124, 292, 139])).toEqual([]);
        // Text before a display ends short of the margin, or introduces it; display space sets it off.
        expect(run([full(100), line(113, [[72, 180, "bounded as"]]), math(126), after(141)], [70, 124, 292, 139])).toHaveLength(1);
        expect(run([full(100), full(113, "the treatment effect is bounded as follows:"), math(126), after(141)], [70, 124, 292, 139])).toHaveLength(1);
        expect(run([full(100), full(113), math(136), after(160)], [70, 134, 292, 149])).toHaveLength(1);
        // An equation standing between finished sentences is a display, however wide.
        expect(run([full(100), full(113, "the treatment effect is bounded by the stops."), math(126), after(141)], [70, 124, 292, 139])).toHaveLength(1);
        // A display equation, centred in its column.
        const centred = page([full(100), full(113), line(126, [[120, 240, "Σx ATEx Pr(Xi = x)"]]), after(141)]);
        expect(regionItemsForPage(centred, detection(centred, [["formula", [118, 124, 242, 139]]], (t) => !t.startsWith("Σx"))).items).toHaveLength(1);
    });

    it("leaves the sentence leading into a display at the column's margin in the prose", () => {
        const para = line(84, [[72, 290, PROSE]]);
        const lead = line(100, [[72, 200, "b) Select next feature using"]]);
        const eq = [line(116, [[110, 233, "F = F ∪ {f}, S = S ∪ {f}"], [279, 295, "(11)"]]), line(130, [[120, 233, "I(f; C) = max I(fj; C)."]])];
        const p = page([para, lead, ...eq]);
        const prose = (t: string) => t === PROSE;
        const { items, page: rest } = regionItemsForPage(p, detection(p, [["formula", [70, 98, 295, 143]]], prose));
        expect(rowTexts(items[0], " ")).toEqual(["F = F ∪ {f}, S = S ∪ {f} (11)", "I(f; C) = max I(fj; C)."]);
        expect(allText(rest)).toEqual([PROSE, lead.text]);
        expect(items[0].bbox.t).toBe(lead.bbox.b);
        // A first row of the display itself (indented like the rest, or holding a relation) stays.
        const indented = page([para, line(100, [[110, 233, "subject to the budget"]]), ...eq]);
        expect(regionItemsForPage(indented, detection(indented, [["formula", [70, 98, 295, 143]]], prose)).items[0].rows).toHaveLength(3);
        const relation = page([para, line(100, [[72, 200, "Select feature f = argmax"]]), ...eq]);
        expect(regionItemsForPage(relation, detection(relation, [["formula", [70, 98, 295, 143]]], prose)).items[0].rows).toHaveLength(3);
        // A word equation wrapped before its relation sign keeps its left-hand side.
        const wrapped = page([para, line(100, [[72, 200, "Total treatment effect"]]), line(116, [[110, 233, "= direct effect + indirect effect"]])]);
        expect(regionItemsForPage(wrapped, detection(wrapped, [["formula", [70, 98, 295, 130]]], prose)).items[0].rows).toHaveLength(2);
        // So does one wrapped before an operator.
        const term = page([para, line(100, [[72, 200, "Total treatment effect"]]), line(116, [[110, 233, "+ β × indirect treatment"]]), line(130, [[110, 233, "= γ × combined effect"]])]);
        expect(regionItemsForPage(term, detection(term, [["formula", [70, 98, 295, 143]]], prose)).items[0].rows).toHaveLength(3);
        // Set relations and operators mark display rows too.
        const member = page([para, line(100, [[72, 200, "chosen feature ∈ feasible set"]]), ...eq]);
        expect(regionItemsForPage(member, detection(member, [["formula", [70, 98, 295, 143]]], prose)).items[0].rows).toHaveLength(3);
        for (const next of ["∪ control units in region", "÷ total population"]) {
            const wrappedOp = page([para, line(100, [[72, 200, "selected treatment units"]]), line(116, [[110, 233, next]])]);
            expect(regionItemsForPage(wrappedOp, detection(wrappedOp, [["formula", [70, 98, 295, 130]]], prose)).items[0].rows).toHaveLength(2);
        }
        // A numerator over its fraction bar is part of the formula, not a lead-in.
        const fraction = page([para, line(100, [[72, 200, "number of successful outcomes"]]), line(116, [[100, 180, "number of all outcomes"]])]);
        const fd = detection(fraction, [["formula", [70, 98, 295, 130]]], prose);
        fd.routing!.rules = [[72, 113, 200, 114]];
        expect(regionItemsForPage(fraction, fd).items[0].rows).toHaveLength(2);
        // A lead-in ending with ":" stays a lead-in over a row that opens with a sign.
        const intro = page([para, line(100, [[72, 200, "where K is a constant:"]]), line(116, [[110, 233, "− δ K = exp(τL) < 1"]])]);
        expect(regionItemsForPage(intro, detection(intro, [["formula", [70, 98, 295, 130]]], prose)).items[0].rows).toHaveLength(1);
        // A lead-in that refers to an equation by number is still a lead-in.
        const reference = page([para, line(100, [[72, 200, "as shown in Equation (8)"]]), ...eq]);
        expect(regionItemsForPage(reference, detection(reference, [["formula", [70, 98, 295, 143]]], prose)).items[0].rows).toHaveLength(2);
        // But a display row whose equation number ends its text is no lead-in.
        for (const number of ["(1)", "(B.2)", "(A-1)", "[12]"]) {
            const numbered = page([para, line(100, [[72, 200, `x within feasible region ${number}`]]), ...eq]);
            expect(regionItemsForPage(numbered, detection(numbered, [["formula", [70, 98, 295, 143]]], prose)).items[0].rows).toHaveLength(3);
        }
    });

    it("caps figure label text", () => {
        const labels = Array.from({ length: 60 }, (_, i) => line(100 + 12 * i, [[100, 500, `label ${i} ${"x".repeat(50)}`]]));
        const p = page(labels);
        const { items } = regionItemsForPage(p, detection(p, [["picture", [90, 90, 510, 820]]]));
        const text = rowTexts(items[0], " ").join("\n");
        expect(text.length).toBeLessThanOrEqual(PICTURE_TEXT_MAX_CHARS);
        expect(items[0].rows.length).toBeGreaterThan(20);
    });

    it("moves a structured-text line as a whole to where most of its characters go", () => {
        // One line: a long table cell routed to the table, a short piece left in prose.
        const mixed = line(120, [[72, 300, "Household income quintile"], [450, 470, "ab"]]);
        const p = page([mixed]);
        const d = detection(p, [["table", [70, 110, 310, 140]]]);
        const { page: rest, items } = regionItemsForPage(p, d);
        expect(allText(rest)).toEqual([]);
        expect(rowTexts(items[0])).toEqual(["Household income quintile | ab"]);
        // The item's box covers the piece absorbed from outside the region.
        expect(items[0].bbox.r).toBeCloseTo(470);

        // The mirror image stays in the prose, whole.
        const d2 = detection(p, [["table", [440, 110, 480, 140]]]);
        const out = regionItemsForPage(p, d2);
        expect(allText(out.page)).toEqual([mixed.text]);
        // A table left without text is no item.
        expect(out.items).toEqual([]);
    });

    it("keeps a line in the prose when two regions tie for its characters", () => {
        const split = line(120, [[72, 150, "abcd"], [450, 530, "wxyz"]]);
        const p = page([split]);
        const d = detection(p, [
            ["decoration", [60, 110, 160, 140]],
            ["table", [440, 110, 540, 140]],
        ]);
        const { page: rest, items } = regionItemsForPage(p, d);
        expect(allText(rest)).toEqual([split.text]);
        expect(items).toEqual([]);
    });

    it("never absorbs lines routed to prose, and leaves pages without regions unchanged", () => {
        const text = line(120, [[72, 540, PROSE]]);
        const p = page([text]);
        const inside = regionItemsForPage(p, detection(p, [["picture", [60, 100, 560, 160]]], (t) => t === PROSE));
        expect(allText(inside.page)).toEqual([PROSE]);
        expect(inside.items[0].rows).toEqual([]);

        const none = regionItemsForPage(p, detection(p, [["other", [60, 100, 560, 160]]]));
        expect(none.page).toBe(p);
        expect(none.items).toEqual([]);
        const scanned = regionItemsForPage(p, { ...detection(p, [["picture", [60, 100, 560, 160]]]), scanned: true });
        expect(scanned).toEqual({ page: p, items: [], margin: [] });
    });
});

describe("regionItemsForPage tables", () => {
    /** Items and remaining page for one table region over the page. */
    const table = (p: RawPageDataDetailed, prose: (text: string) => boolean = () => false, rules: Rect[] = [], verticalRules: Rect[] = []) => {
        const d = detection(p, [["table", [60, 60, 560, 700]]], prose);
        d.routing!.rules = rules;
        d.routing!.verticalRules = verticalRules;
        return regionItemsForPage(p, d);
    };

    it("joins the lines of a wrapped cell and the visual rows of one table row", () => {
        const p = page([
            line(100, [[72, 140, "Planning"], [200, 498, "Change can be controlled by senior managers in a"]]),
            // A full line above: the next word would not have fitted.
            line(112, [[200, 470, "top-down fashion through formal plans and"]]),
            // A line that ended mid-sentence runs on into a lower-case line.
            line(124, [[200, 330, "monitoring of progress."]]),
            line(136, [[72, 160, "Communication"], [200, 496, "Lateral and informal communication between"]]),
            line(148, [[200, 400, "peers is the primary vehicle."]]),
        ]);
        const { items } = table(p);
        expect(rowTexts(items[0])).toEqual([
            "Planning | Change can be controlled by senior managers in a top-down fashion through formal plans and monitoring of progress.",
            "Communication | Lateral and informal communication between peers is the primary vehicle.",
        ]);
        expect(items[0].columns).toBe(2);
        // The cell's box covers its lines.
        expect(items[0].rows[0][1].bbox.t).toBe(100);
        expect(items[0].rows[0][1].bbox.b).toBe(135);
    });

    it("joins a word broken at a line end and keeps a cell's next paragraph with its row", () => {
        const p = page([
            line(100, [[72, 140, "Planning"], [200, 330, "Change is managed by"], [400, 498, "Senior managers set the"]]),
            line(112, [[200, 330, "plans of senior manage-"], [400, 470, "direction of change."]]),
            // A capital after a line that ended a sentence: the cell's next paragraph.
            line(124, [[200, 300, "ment teams."], [400, 498, "Practice follows from it."]]),
        ]);
        expect(rowTexts(table(p).items[0])).toEqual([
            "Planning | Change is managed by plans of senior management teams. | Senior managers set the direction of change. Practice follows from it.",
        ]);
    });

    it("never joins rows of values, separate labels or rows across a rule", () => {
        const values = page([
            line(100, [[72, 150, "Age"], [250, 320, "0.23"], [400, 470, "0.19"]]),
            line(112, [[72, 150, "Female"], [250, 320, "0.05"], [400, 470, "0.04"]]),
            line(124, [[72, 150, "Income"], [250, 320, "1.10"], [400, 470, "0.98"]]),
        ]);
        expect(rowTexts(table(values).items[0])).toEqual(["Age | 0.23 | 0.19", "Female | 0.05 | 0.04", "Income | 1.10 | 0.98"]);

        // Names filling a fitted column look like wrapped lines but start new cells.
        const names = page([
            line(100, [[72, 160, "United Kingdom"], [250, 300, "London"]]),
            line(112, [[72, 110, "France"], [250, 290, "Paris"]]),
            line(124, [[72, 150, "Germany"], [250, 290, "Berlin"]]),
        ]);
        expect(table(names).items[0].rows).toHaveLength(3);
        // A label starting in lower case does not pull the values under it into the row above.
        const reagents = page([
            line(100, [[72, 170, "2-Mercaptoethanol"], [250, 290, "500 µl"]]),
            line(112, [[72, 100, "bFGF"], [250, 285, "25 µl"]]),
        ]);
        expect(table(reagents).items[0].rows).toHaveLength(2);

        const ruled = page([
            line(100, [[72, 140, "Planning"], [200, 498, "Change can be controlled by senior managers in a"]]),
            line(112, [[200, 470, "top-down fashion through formal plans and"]]),
        ]);
        expect(table(ruled).items[0].rows).toHaveLength(1);
        expect(table(ruled, () => false, [[195, 111.5, 500, 112]]).items[0].rows).toHaveLength(2);
        // A label set sideways among upright cells does not hide the rule.
        const withSidewaysLabel = page([
            line(70, [[62, 70, "Stage"]], 90),
            line(100, [[72, 140, "Planning"], [200, 498, "Change can be controlled by senior managers in a"]]),
            line(112, [[200, 470, "top-down fashion through formal plans and"]]),
        ]);
        const sideways = table(withSidewaysLabel, () => false, [[195, 111.5, 500, 112]]).items[0].rows;
        expect(sideways.find((r) => r.some((c) => c.text.startsWith("Change")))!.some((c) => c.text.includes("top-down"))).toBe(false);
    });

    it("joins rows by the evidence of their cells", () => {
        const texts = (p: RawPageDataDetailed) => rowTexts(table(p).items[0]);
        // A word broken at the line end joins its rest, though neither line is full.
        expect(
            texts(
                page([
                    line(100, [[72, 140, "Planning and"], [200, 290, "Change is manage-"]]),
                    line(112, [[72, 110, "control"], [200, 270, "ment of plans."]]),
                    line(124, [[72, 140, "Monitoring"], [200, 400, "Senior managers track the change."]]),
                ]),
            ),
        ).toEqual(["Planning and control | Change is management of plans.", "Monitoring | Senior managers track the change."]);
        // A new cell in the first column starts a row, even beside a wrapping cell.
        expect(
            texts(
                page([
                    line(100, [[72, 150, "Plans are set."], [200, 400, "Senior managers set the direction of the"]]),
                    line(112, [[72, 130, "Monitoring"], [200, 300, "change in the firm."]]),
                ]),
            ),
        ).toHaveLength(2);
        // Cells of one row ending on different lines: the shorter row continues.
        expect(
            texts(
                page([
                    line(100, [[72, 140, "Wamala et al."], [200, 280, "292 patients and"], [330, 415, "Education related"]]),
                    line(112, [[200, 265, "controls (all"], [330, 390, "inversely to"]]),
                    line(124, [[72, 150, "Matthews et al."], [200, 250, "401 women"], [330, 415, "Education showed"]]),
                ]),
            ),
        ).toEqual(["Wamala et al. | 292 patients and controls (all | Education related inversely to", "Matthews et al. | 401 women | Education showed"]);
        // A group label wrapped onto a line of its own.
        expect(
            texts(
                page([
                    line(100, [[72, 250, "Average hours of direct teaching or"]]),
                    line(112, [[72, 190, "supervision of residents"]]),
                    line(124, [[72, 330, "Community hospital, university affiliated program"], [400, 440, "1.1"], [480, 520, "0.6"]]),
                ]),
            ),
        ).toEqual(["Average hours of direct teaching or supervision of residents", "Community hospital, university affiliated program | 1.1 | 0.6"]);
        // The cell's next sentence after a full line that ended one.
        expect(
            texts(
                page([
                    line(100, [[72, 140, "Sun (2020)"], [200, 400, "Travel by car to reach locations and do activities."]]),
                    line(112, [[200, 360, "Government can install levees."]]),
                    line(124, [[72, 140, "Toft (2011)"], [200, 380, "Fishers are aggregated into port groups."]]),
                ]),
            ),
        ).toEqual([
            "Sun (2020) | Travel by car to reach locations and do activities. Government can install levees.",
            "Toft (2011) | Fishers are aggregated into port groups.",
        ]);
    });

    it("never joins lines far apart, however spaced the table's rows", () => {
        // Two rows only: their spacing is the one pitch the table shows, not its line spacing.
        const p = page([
            line(100, [[72, 140, "Planning"], [200, 498, "Change can be controlled by senior managers in a"]]),
            line(300, [[200, 470, "top-down fashion through formal plans and"]]),
        ]);
        expect(table(p).items[0].rows).toHaveLength(2);
    });

    it("counts text left out between the lines of one joined row", () => {
        const lines = [
            line(100, [[72, 140, "Planning"], [200, 498, "Change can be controlled by senior managers in a"]]),
            line(112, [[200, 498, "Running text the routing left in the prose, set here."]]),
            line(124, [[200, 470, "top-down fashion through formal plans and"]]),
        ];
        const out = table(page(lines), (t) => t.startsWith("Running"));
        expect(out.items).toEqual([]);
        expect(allText(out.page)).toEqual(lines.map((l) => l.text));
    });

    it("keeps statistics under their values in the values' row", () => {
        // Standard errors under coefficients, and a label running on beside them.
        const p = page([
            line(100, [[72, 180, "Boundary value"], [250, 320, "0.822**"], [400, 470, "1.078***"]]),
            line(112, [[250, 320, "(0.358)"], [400, 470, "(0.255)"]]),
            line(130, [[72, 200, "Prop. Black/Hispanic ×"], [250, 320, "0.195"], [400, 470, "−1.344***"]]),
            line(142, [[72, 180, "Boundary value"], [250, 320, "(0.491)"], [400, 470, "[0.21, 0.45]"]]),
            line(160, [[72, 180, "Constant"], [250, 320, "4.773***"], [400, 470, "2.686***"]]),
        ]);
        expect(rowTexts(table(p).items[0])).toEqual([
            "Boundary value | 0.822** (0.358) | 1.078*** (0.255)",
            "Prop. Black/Hispanic × Boundary value | 0.195 (0.491) | −1.344*** [0.21, 0.45]",
            "Constant | 4.773*** | 2.686***",
        ]);
        // Not under words, across a rule, a line's spacing apart, or beside a new label.
        const apart = page([
            line(100, [[72, 180, "Model"], [250, 320, "Linear"], [400, 470, "Logit"]]),
            line(112, [[250, 320, "(1)"], [400, 470, "(2)"]]),
            line(124, [[72, 180, "Age"], [250, 320, "0.23"], [400, 470, "0.19"]]),
            line(136, [[250, 320, "(0.05)"], [400, 470, "(0.04)"]]),
            line(160, [[72, 180, "Income"], [250, 320, "1.10"], [400, 470, "0.98"]]),
            line(184, [[250, 320, "(0.30)"], [400, 470, "(0.20)"]]),
            line(196, [[72, 180, "Female"], [250, 320, "2.10"], [400, 470, "1.98"]]),
            line(208, [[72, 180, "Male"], [250, 320, "(0.10)"], [400, 470, "(0.20)"]]),
        ]);
        expect(rowTexts(table(apart, () => false, [[70, 135, 472, 135.5]]).items[0])).toEqual([
            "Model | Linear | Logit",
            "(1) | (2)",
            "Age | 0.23 | 0.19",
            "(0.05) | (0.04)",
            "Income | 1.10 | 0.98",
            "(0.30) | (0.20)",
            "Female | 2.10 | 1.98",
            "Male | (0.10) | (0.20)",
        ]);
    });

    it("joins a line that goes on from a phrase left open, whatever case it starts in", () => {
        const p = page([
            line(100, [[72, 160, "District of"], [250, 420, "K, 1st, 2nd, 3rd, 4th,"]]),
            line(112, [[72, 160, "Columbia"], [250, 420, "5th, 6th, 7th, 8th"]]),
            line(130, [[72, 160, "Florida"], [250, 420, "K, 1st, 3rd, 6th"]]),
        ]);
        expect(rowTexts(table(p).items[0])).toEqual(["District of Columbia | K, 1st, 2nd, 3rd, 4th, 5th, 6th, 7th, 8th", "Florida | K, 1st, 3rd, 6th"]);
        // Upper-case abbreviations end a label: an odds ratio, a state.
        const ends = page([
            line(100, [[72, 160, "Adjusted OR"], [250, 320, "1.20"]]),
            line(112, [[72, 160, "Crude OR"], [250, 320, "1.31"]]),
        ]);
        expect(table(ends).items[0].rows).toHaveLength(2);
    });

    it("reads a column header set over several lines as one row", () => {
        const p = page([
            line(100, [[250, 320, "Model"], [400, 470, "Model"]]),
            line(112, [[250, 320, "(1)"], [400, 470, "(2)"]]),
            line(130, [[72, 180, "Age"], [250, 320, "0.23"], [400, 470, "0.19"]]),
            line(142, [[72, 180, "Income"], [250, 320, "1.10"], [400, 470, "0.98"]]),
            line(154, [[72, 180, "Female"], [250, 320, "2.10"], [400, 470, "1.98"]]),
        ]);
        const { items } = table(p);
        expect(rowTexts(items[0])).toEqual(["Model (1) | Model (2)", "Age | 0.23 | 0.19", "Income | 1.10 | 0.98", "Female | 2.10 | 1.98"]);
        // The header keeps its place over the values: an empty slot for the label column.
        expect(items[0].rows[0].map((c) => c.column)).toEqual([1, 2]);

        // A header spanning columns, ruled off from the columns' headers under it, is a cell of its own.
        const spanned = page([
            line(100, [[300, 380, "Mediator"]]),
            line(112, [[200, 260, "Violent"], [300, 360, "Property"]]),
            line(124, [[200, 260, "felonies"], [300, 360, "felonies"], [400, 470, "Shootings"]]),
            line(142, [[72, 160, "Total effect"], [200, 260, "0.823"], [300, 360, "1.042"], [400, 470, "1.013"]]),
            line(154, [[72, 160, "Direct effect"], [200, 260, "0.547"], [300, 360, "0.841"], [400, 470, "0.891"]]),
            line(166, [[72, 160, "Indirect effect"], [200, 260, "0.276"], [300, 360, "0.201"], [400, 470, "0.122"]]),
        ]);
        expect(rowTexts(table(spanned, () => false, [[198, 111, 472, 111.5]]).items[0])[0]).toBe(
            "Mediator | Violent felonies | Property felonies | Shootings",
        );

        // A spanning header's lines stack when its text wraps onto them, not otherwise.
        const body = [142, 154, 166, 178].map((y, k) =>
            line(y, [[72, 160, ["Age", "Work", "Cars", "Help"][k]], [200, 230, `1.4${k}`], [290, 320, `0.5${k}`], [370, 400, `3.6${k}`], [460, 490, `0.0${k}`]]),
        );
        const wrapped = page([
            line(100, [[215, 295, "Model 1: Current"], [385, 465, "Model 2: Maximum"]]),
            line(112, [[228, 293, "travel time"], [395, 462, "prepared time"]]),
            line(124, [[200, 230, "OR"], [290, 320, "p"], [370, 400, "OR"], [460, 490, "p"]]),
            ...body,
        ]);
        expect(rowTexts(table(wrapped).items[0])[0]).toBe("Model 1: Current travel time | Model 2: Maximum prepared time | OR | p | OR | p");
        const siblings = page([
            line(100, [[290, 400, "Faking good responses"]]),
            line(112, [[215, 295, "PDS Polytomous"], [385, 475, "PDS Binary scoring"]]),
            line(124, [[200, 230, "Cut"], [290, 320, "IM"], [370, 400, "Cut"], [460, 490, "IM"]]),
            ...body,
        ]);
        expect(rowTexts(table(siblings).items[0])[0]).toBe("Faking good responses | PDS Polytomous | PDS Binary scoring | Cut | IM | Cut | IM");

        // The label column's heading read with the header line above it (the rows' bands run on)
        // stays in the header, also under a header spanning columns over a rule of its own.
        const generator = page([
            line(100, [[280, 400, "Radionuclide generator"]]),
            line(116, [[250, 340, "active substances"]]),
            line(128, [[72, 180, "specification parameter"], [250, 340, "(parent radionuclide)"], [380, 470, "finished product"]]),
            line(150, [[72, 180, "radionuclidic ID"], [250, 340, "yes"], [380, 470, "yes"]]),
            line(170, [[72, 180, "radionuclidic impurities"], [250, 340, "yes"], [380, 470, "yes"]]),
            line(190, [[72, 180, "radiochemical ID"], [250, 340, "yes"], [380, 470, "no"]]),
            line(210, [[72, 180, "radiochemical purity"], [250, 340, "no"], [380, 470, "yes"]]),
        ]);
        const generatorRules: Rect[] = [[220, 113, 472, 113.5], [190, 143, 472, 143.5], ...[166, 186, 206].map((y): Rect => [70, y, 472, y + 0.5])];
        expect(rowTexts(table(generator, () => false, generatorRules).items[0])[0]).toBe(
            "Radionuclide generator | specification parameter | active substances (parent radionuclide) | finished product",
        );

        // So in a table that rules its rows, where that rule spans most of the table.
        const ruledRows = page([
            line(100, [[300, 360, "Mediator"]]),
            line(112, [[200, 260, "Violent"], [300, 360, "Property"]]),
            line(124, [[200, 260, "felonies"], [300, 360, "felonies"], [400, 470, "Shootings"]]),
            line(142, [[72, 160, "Total effect"], [200, 260, "0.823"], [300, 360, "1.042"], [400, 470, "1.013"]]),
            line(160, [[72, 160, "Direct effect"], [200, 260, "0.547"], [300, 360, "0.841"], [400, 470, "0.891"]]),
            line(178, [[72, 160, "Indirect effect"], [200, 260, "0.276"], [300, 360, "0.201"], [400, 470, "0.122"]]),
        ]);
        const rowRules: Rect[] = [[190, 111, 472, 111.5], ...[96, 138, 156, 174, 192].map((y): Rect => [70, y, 472, y + 0.5])];
        expect(rowTexts(table(ruledRows, () => false, rowRules).items[0])).toEqual([
            "Mediator | Violent felonies | Property felonies | Shootings",
            "Total effect | 0.823 | 1.042 | 1.013",
            "Direct effect | 0.547 | 0.841 | 0.891",
            "Indirect effect | 0.276 | 0.201 | 0.122",
        ]);

        // The label column's heading, set on the header's last line above the rule under the
        // header, belongs to the header; a label under that rule does not.
        const headed = page([
            line(100, [[250, 320, "Intensified"], [400, 470, "Not Intensified"]]),
            line(112, [[250, 320, "Before"], [400, 470, "Before"]]),
            line(124, [[72, 180, "Characteristic"], [250, 320, "(n = 2074)"], [400, 470, "(n = 12 841)"]]),
            line(142, [[72, 180, "Age"], [250, 320, "76.8"], [400, 470, "76.6"]]),
            line(154, [[72, 180, "Male sex"], [250, 320, "97.5"], [400, 470, "97.8"]]),
            line(166, [[72, 180, "White"], [250, 320, "69.9"], [400, 470, "78.2"]]),
        ]);
        const headerRule: Rect[] = [[70, 137, 472, 137.5]];
        expect(rowTexts(table(headed, () => false, headerRule).items[0]).slice(0, 2)).toEqual([
            "Characteristic | Intensified Before (n = 2074) | Not Intensified Before (n = 12 841)",
            "Age | 76.8 | 76.6",
        ]);
        // So with the rule drawn as one segment per column.
        const segments: Rect[] = [[70, 137, 182, 137.5], [182, 137, 340, 137.5], [340, 137, 472, 137.5]];
        expect(rowTexts(table(headed, () => false, segments).items[0])[0]).toBe(
            "Characteristic | Intensified Before (n = 2074) | Not Intensified Before (n = 12 841)",
        );
        // Without the rule, or with values on the label's line, the label line is a row of its own.
        expect(rowTexts(table(headed).items[0])[1]).toBe("Characteristic | (n = 2074) | (n = 12 841)");
        const valued = page([
            line(100, [[250, 320, "Intensified"], [400, 470, "Not Intensified"]]),
            line(112, [[250, 320, "Before"], [400, 470, "Before"]]),
            line(124, [[72, 180, "Total"], [250, 320, "2074"], [400, 470, "12 841"]]),
            line(142, [[72, 180, "Age"], [250, 320, "76.8"], [400, 470, "76.6"]]),
            line(154, [[72, 180, "Male sex"], [250, 320, "97.5"], [400, 470, "97.8"]]),
            line(166, [[72, 180, "White"], [250, 320, "69.9"], [400, 470, "78.2"]]),
        ]);
        expect(rowTexts(table(valued, () => false, headerRule).items[0])[1]).toBe("Total | 2074 | 12 841");

        // A title set across the label column, and a rule across the table between header
        // lines, keep their lines apart.
        const titled = page([
            line(100, [[72, 470, "Panel A. Outcomes by model"]]),
            line(112, [[250, 320, "(1)"], [400, 470, "(2)"]]),
            line(130, [[72, 180, "Age"], [250, 320, "0.23"], [400, 470, "0.19"]]),
            line(142, [[72, 180, "Income"], [250, 320, "1.10"], [400, 470, "0.98"]]),
            line(154, [[72, 180, "Female"], [250, 320, "2.10"], [400, 470, "1.98"]]),
        ]);
        expect(table(titled).items[0].rows).toHaveLength(5);
        // Unlabelled lines that run on into the first labelled row (a table cut mid-row) are no header.
        const continued = page([
            line(100, [[250, 470, "and practice in the classroom"]]),
            line(112, [[250, 470, "Incorporation and institution-"]]),
            line(124, [[72, 180, "Lozano, 2006"], [250, 470, "alisation of sustainable development"]]),
            line(136, [[72, 180, "Lozano, 2010"], [250, 470, "Diffusion of sustainable development"]]),
            line(148, [[72, 180, "Lukman, 2009"], [250, 470, "Sustainability in higher education"]]),
            line(160, [[72, 180, "Mlinar, 2010"], [250, 470, "Paradigm of sustainability"]]),
        ]);
        expect(rowTexts(table(continued).items[0])[0]).toBe("and practice in the classroom");
        // A record's first line set above its centred label is no header line.
        const record = (y: number, n: string, a: string, b: string) => [
            line(y, [[150, 280, a]]),
            line(y + 8, [[72, 90, n], [350, 390, "4.10"], [460, 490, "A"]]),
            line(y + 16, [[150, 280, b]]),
        ];
        const centred = page([
            line(100, [[150, 200, "Criterion"], [350, 390, "Rating"], [460, 490, "Group"]]),
            ...record(114, "1", "Readiness of the logistics", "for digital transformation."),
            ...record(146, "2", "Provision of human capital", "for digital transformation."),
            line(178, [[72, 90, "3"], [150, 220, "Level of crime"], [350, 390, "3.87"], [460, 490, "B"]]),
            line(194, [[72, 90, "4"], [150, 230, "Quality of roads"], [350, 390, "3.80"], [460, 490, "B"]]),
        ]);
        expect(rowTexts(table(centred).items[0])[0]).toBe("Criterion | Rating | Group");
        // Unlabelled lines making most of the box (rows of a table cut above its labels) are no header.
        const cut = page([
            line(100, [[250, 320, "12"], [400, 470, "13"]]),
            line(112, [[250, 320, "14"], [400, 470, "15"]]),
            line(124, [[250, 320, "16"], [400, 470, "17"]]),
            line(136, [[72, 180, "Age"], [250, 320, "0.23"], [400, 470, "0.19"]]),
            line(148, [[72, 180, "Income"], [250, 320, "1.10"], [400, 470, "0.98"]]),
        ]);
        expect(table(cut).items[0].rows).toHaveLength(5);
        expect(table(p, () => false, [[70, 111, 472, 111.5]]).items[0].rows).toHaveLength(5);
    });

    it("reads each ruled band of a table that rules its rows as one row", () => {
        // A text table: every row ruled off; the definition wraps, the year is centred on it.
        const p = page([
            line(100, [[72, 160, "Authors"], [200, 240, "Year"], [300, 520, "Definition"]]),
            line(120, [[72, 160, "Pal R., Torstensson"], [300, 520, "Capability to be ready in time of crisis and to sustain"]]),
            line(126, [[200, 225, "2014"]]),
            line(132, [[72, 160, "H., and Mattila H."], [300, 520, "superior organizational performance."]]),
            line(152, [[72, 160, "Starr, R., Newfrock,"], [300, 520, "Ability and capacity to withstand systematic"]]),
            line(158, [[200, 225, "2003"]]),
            line(164, [[72, 160, "J., and Delurey, M."], [300, 520, "discontinuities and adapt to new risk environments."]]),
            line(184, [[72, 160, "Lengnick-Hall C.A.,"], [300, 520, "Resilience capacity is defined as a unique blend of"]]),
            line(190, [[200, 225, "2005"]]),
            line(196, [[72, 160, "Beck T.E."], [300, 520, "cognitive and contextual properties."]]),
        ]);
        const ruled: Rect[] = [116, 148, 180, 210].map((y): Rect => [70, y, 522, y + 0.5]);
        expect(rowTexts(table(p, () => false, ruled).items[0])).toEqual([
            "Authors | Year | Definition",
            "Pal R., Torstensson H., and Mattila H. | 2014 | Capability to be ready in time of crisis and to sustain superior organizational performance.",
            "Starr, R., Newfrock, J., and Delurey, M. | 2003 | Ability and capacity to withstand systematic discontinuities and adapt to new risk environments.",
            "Lengnick-Hall C.A., Beck T.E. | 2005 | Resilience capacity is defined as a unique blend of cognitive and contextual properties.",
        ]);
        // A ruled section of one-line rows of values stays row by row.
        const values = page([
            line(100, [[72, 160, "Variable"], [300, 340, "Mean"], [420, 460, "SD"]]),
            ...Array.from({ length: 4 }, (_, k) => line(120 + 12 * k, [[72, 160, `Item ${k + 1}`], [300, 340, `${k}.25`], [420, 460, `${k}.75`]])),
            ...Array.from({ length: 4 }, (_, k) => line(176 + 12 * k, [[72, 160, `Item ${k + 5}`], [300, 340, `${k}.35`], [420, 460, `${k}.85`]])),
        ]);
        const sections: Rect[] = [116, 172, 222, 240].map((y): Rect => [70, y, 462, y + 0.5]);
        expect(table(values, () => false, sections).items[0].rows).toHaveLength(9);
    });

    it("reads a ruled band whose later lines clearly go on with its first as one row", () => {
        // Lines set apart within their band, further than a cell's lines: a label running on,
        // statistics under values.
        const p = page([
            line(100, [[72, 200, "Prop. Black/Hispanic ×"], [250, 320, "0.195"], [400, 470, "−1.344***"]]),
            line(128, [[72, 200, "Boundary value"], [250, 320, "(0.491)"], [400, 470, "(0.353)"]]),
            line(162, [[72, 200, "Constant"], [250, 320, "4.773***"], [400, 470, "2.686***"]]),
            line(190, [[250, 320, "(0.078)"], [400, 470, "(0.393)"]]),
            line(224, [[72, 200, "Observations"], [250, 320, "4,604"], [400, 470, "4,604"]]),
            line(258, [[72, 200, "Log likelihood"], [250, 320, "−32,177"], [400, 470, "−31,178"]]),
        ]);
        const rules: Rect[] = [96, 156, 218, 252, 286].map((y): Rect => [70, y, 472, y + 0.5]);
        expect(rowTexts(table(p, () => false, rules).items[0])).toEqual([
            "Prop. Black/Hispanic × Boundary value | 0.195 (0.491) | −1.344*** (0.353)",
            "Constant | 4.773*** (0.078) | 2.686*** (0.393)",
            "Observations | 4,604 | 4,604",
            "Log likelihood | −32,177 | −31,178",
        ]);
        // A rule across some of the band's columns rules off a row of its own.
        const divided = page([
            line(100, [[72, 200, "Prop. Black/Hispanic ×"], [250, 320, "0.195"], [400, 470, "−1.344***"]]),
            line(128, [[72, 200, "Boundary value"], [250, 320, "(0.491)"], [400, 470, "(0.353)"]]),
            line(162, [[72, 200, "Constant"], [250, 320, "4.773***"], [400, 470, "2.686***"]]),
            line(190, [[72, 200, "Observations"], [250, 320, "4,604"], [400, 470, "4,604"]]),
            line(224, [[72, 200, "Log likelihood"], [250, 320, "−32,177"], [400, 470, "−31,178"]]),
        ]);
        const dividedRules: Rect[] = [...[96, 156, 182, 218, 252].map((y): Rect => [70, y, 472, y + 0.5]), [245, 114, 472, 114.5]];
        expect(table(divided, () => false, dividedRules).items[0].rows).toHaveLength(5);
        // Sub-rows under one label, each with values of its own, stay rows of their own; so do
        // values under values, lower-case one-line records and a new label.
        const grouped = page([
            line(100, [[72, 160, "Bilateral hubs"], [200, 260, "EF"], [300, 340, "3.86"], [400, 440, ".06"]]),
            line(112, [[200, 260, "ER"], [300, 340, "4.47"], [400, 440, ".04"]]),
            line(132, [[72, 160, "Right hubs"], [200, 260, "EF"], [300, 340, "5.58"], [400, 440, ".02"]]),
            line(144, [[300, 340, "8.27"], [400, 440, ".01"]]),
            line(164, [[72, 160, "Left hubs"], [200, 260, "apple"], [300, 340, "0.69"], [400, 440, ".41"]]),
            line(176, [[200, 260, "banana"], [300, 340, "0.32"], [400, 440, ".57"]]),
            line(196, [[72, 160, "Hubs of"], [200, 260, "ToM"], [300, 340, "1.69"], [400, 440, ".29"]]),
            line(208, [[72, 160, "network"], [200, 260, "SCS"], [300, 340, "0.58"], [400, 440, ".45"]]),
            line(228, [[72, 160, "All hubs"], [200, 260, "MMSE"], [300, 340, "1.14"], [400, 440, ".29"]]),
        ]);
        const bands: Rect[] = [96, 126, 158, 190, 222, 242].map((y): Rect => [70, y, 442, y + 0.5]);
        expect(table(grouped, () => false, bands).items[0].rows).toHaveLength(9);
        // A new label over statistics starts a row, in lower case too (a variable's name).
        const named = page([
            line(100, [[72, 160, "cdereg"], [250, 320, "−0.203**"], [400, 470, "−0.203**"]]),
            line(128, [[72, 160, "sdereg"], [250, 320, "(−1.97)"], [400, 470, "(−1.97)"]]),
            line(162, [[72, 160, "Female"], [250, 320, "−0.041"], [400, 470, "−0.042"]]),
            line(190, [[72, 160, "Male"], [250, 320, "(−0.41)"], [400, 470, "(−0.42)"]]),
            line(224, [[72, 160, "Constant"], [250, 320, "0.372"], [400, 470, "0.371"]]),
            line(258, [[72, 160, "Observations"], [250, 320, "4,604"], [400, 470, "4,604"]]),
        ]);
        const namedRules: Rect[] = [96, 156, 218, 252, 286].map((y): Rect => [70, y, 472, y + 0.5]);
        expect(table(named, () => false, namedRules).items[0].rows).toHaveLength(6);
    });

    it("judges a ruled band as read without open phrases, which still join their own lines", () => {
        // The first two lines join on their open phrases; the third starts with a capital. Read
        // without the open phrases, nothing in the band runs on, so the band is no one row.
        const p = page([
            line(100, [[72, 160, "Alpha"], [200, 330, "first part of"], [380, 470, "x of"]]),
            line(112, [[200, 330, "Second part"], [380, 470, "Y values"]]),
            line(124, [[200, 330, "Third part"]]),
            line(144, [[72, 160, "Beta"], [200, 330, "1.0"], [380, 470, "2.0"]]),
            line(164, [[72, 160, "Gamma"], [200, 330, "3.0"], [380, 470, "4.0"]]),
            line(184, [[72, 160, "Delta"], [200, 330, "5.0"], [380, 470, "6.0"]]),
        ]);
        const rules: Rect[] = [96, 140, 160, 180, 198].map((y): Rect => [70, y, 472, y + 0.5]);
        expect(rowTexts(table(p, () => false, rules).items[0])).toEqual([
            "Alpha | first part of Second part | x of Y values",
            "Third part",
            "Beta | 1.0 | 2.0",
            "Gamma | 3.0 | 4.0",
            "Delta | 5.0 | 6.0",
        ]);
    });

    it("keeps one-line records under section rules apart when nothing runs on", () => {
        // Bands that each hold several complete one-line rows are sections of records.
        const fruit = [
            ["apple", "red"],
            ["banana", "yellow"],
            ["cherry", "red"],
            ["grape", "purple"],
            ["lemon", "yellow"],
            ["lime", "green"],
            ["orange", "orange"],
            ["plum", "purple"],
        ];
        const p = page([
            line(100, [[72, 160, "Fruit"], [300, 380, "Colour"]]),
            ...fruit.map(([f, c], k) => line(120 + 12 * k + 8 * Math.floor(k / 2), [[72, 160, f], [300, 380, c]])),
        ]);
        // Section rules after every second record, and above and below the table.
        const sections: Rect[] = [116, 142, 168, 194, 220].map((y): Rect => [70, y, 382, y + 0.5]);
        expect(rowTexts(table(p, () => false, sections).items[0])).toEqual(["Fruit | Colour", ...fruit.map(([f, c]) => `${f} | ${c}`)]);
        // Header cells wrapped at different points leave a row short of a column: one row.
        const headed = page([
            line(100, [[72, 140, "Milieu"], [200, 260, "Micro"], [300, 380, "Rank"]]),
            line(110, [[72, 140, "risico"], [200, 260, "krediet"]]),
            line(120, [[72, 140, "analyse"]]),
            ...fruit.slice(0, 4).map(([f, c], k) => line(140 + 20 * k, [[72, 140, f], [200, 260, c], [300, 380, String(k + 1)]])),
        ]);
        const rows: Rect[] = [96, 134, 156, 176, 196, 216].map((y): Rect => [70, y, 382, y + 0.5]);
        expect(rowTexts(table(headed, () => false, rows).items[0])).toEqual([
            "Milieu risico analyse | Micro krediet | Rank",
            ...fruit.slice(0, 4).map(([f, c], k) => `${f} | ${c} | ${k + 1}`),
        ]);
        // A header wrapped evenly in every column is one band of complete rows: one row.
        const even = page([
            line(100, [[72, 140, "hemmt"], [200, 260, "weder"], [300, 380, "fördert"]]),
            line(110, [[72, 140, "stark"], [200, 260, "noch"], [300, 380, "eher"]]),
            ...fruit.slice(0, 4).map(([f, c], k) => line(140 + 20 * k, [[72, 140, f], [200, 260, c], [300, 380, String(k + 1)]])),
        ]);
        const evenRules: Rect[] = [96, 134, 156, 176, 196, 216].map((y): Rect => [70, y, 382, y + 0.5]);
        expect(rowTexts(table(even, () => false, evenRules).items[0])[0]).toBe("hemmt stark | weder noch | fördert eher");
        // A record whose last cell is set a line lower leaves its rows short of a column: one
        // row, also among sections of records.
        const taste = ["sweet", "soft", "tart", "ripe"];
        const offset = page([
            line(100, [[72, 140, "Fruit"], [200, 260, "Colour"], [300, 380, "Taste"]]),
            line(120, [[72, 140, "quince"], [200, 260, "yellow"]]),
            line(132, [[300, 380, "hard"]]),
            ...fruit.slice(0, 4).map(([f, c], k) => line(150 + 12 * k + 8 * Math.floor(k / 2), [[72, 140, f], [200, 260, c], [300, 380, taste[k]]])),
        ]);
        const offsetRules: Rect[] = [116, 146, 176, 210].map((y): Rect => [70, y, 382, y + 0.5]);
        expect(rowTexts(table(offset, () => false, offsetRules).items[0])).toEqual([
            "Fruit | Colour | Taste",
            "quince | yellow | hard",
            ...fruit.slice(0, 4).map(([f, c], k) => `${f} | ${c} | ${taste[k]}`),
        ]);
    });

    it("ignores rules of another text column beside a table that rules its rows", () => {
        // A text table in the right half of the page; the left column has rules at the same heights.
        const p = page([
            line(100, [[250, 312, "Authors"], [340, 358, "Year"], [410, 564, "Definition"]]),
            line(120, [[250, 312, "Pal R., Torstensson"], [410, 564, "Capability to be ready in time of crisis and to sustain"]]),
            line(126, [[340, 358, "2014"]]),
            line(132, [[250, 312, "H., and Mattila H."], [410, 564, "superior organizational performance."]]),
            line(152, [[250, 312, "Starr, R., Newfrock,"], [410, 564, "Ability and capacity to withstand systematic"]]),
            line(158, [[340, 358, "2003"]]),
            line(164, [[250, 312, "J., and Delurey, M."], [410, 564, "discontinuities and adapt to new risk environments."]]),
            line(184, [[250, 312, "Lengnick-Hall C.A.,"], [410, 564, "Resilience capacity is defined as a unique blend of"]]),
            line(190, [[340, 358, "2005"]]),
            line(196, [[250, 312, "Beck T.E."], [410, 564, "cognitive and contextual properties."]]),
        ]);
        const ys = [116, 148, 180, 210];
        const own: Rect[] = ys.map((y): Rect => [249, y, 565, y + 0.5]);
        const beside: Rect[] = ys.map((y): Rect => [40, y, 100, y + 0.5]);
        const rows = [
            "Authors | Year | Definition",
            "Pal R., Torstensson H., and Mattila H. | 2014 | Capability to be ready in time of crisis and to sustain superior organizational performance.",
            "Starr, R., Newfrock, J., and Delurey, M. | 2003 | Ability and capacity to withstand systematic discontinuities and adapt to new risk environments.",
            "Lengnick-Hall C.A., Beck T.E. | 2005 | Resilience capacity is defined as a unique blend of cognitive and contextual properties.",
        ];
        expect(rowTexts(table(p, () => false, own).items[0])).toEqual(rows);
        expect(rowTexts(table(p, () => false, [...beside, ...own]).items[0])).toEqual(rows);
    });

    it("reads a ruled band whose columns run on independently as one row", () => {
        // A worksheet: a list of patterns beside two paragraphs that run on mid-sentence.
        const p = page([
            line(100, [[72, 200, "E. Problematic Patterns"], [240, 380, "F. Alternative Thought"], [420, 560, "G. Re-rated Belief"]]),
            line(120, [[72, 200, "Jumping to conclusions"], [240, 380, "I hate that my friends died and"], [420, 560, "Re-rate how much you now believe"]]),
            line(132, [[72, 200, "Exaggerating or minimizing"], [240, 380, "although it did not seem critical"], [420, 560, "the thought in section B from zero"]]),
            line(144, [[72, 200, "Ignoring important parts"], [240, 380, "to make that run I do not know what"], [420, 560, "to one hundred percent after all of"]]),
            line(156, [[72, 200, "Oversimplifying"], [240, 380, "the lieutenant was thinking then."], [420, 560, "this, rated here."]]),
            line(176, [[72, 200, "Total"], [240, 380, "Rated 40 percent"], [420, 560, "Rated 60 percent"]]),
            line(196, [[72, 200, "Mean"], [240, 380, "Rated 50 percent"], [420, 560, "Rated 70 percent"]]),
        ]);
        const ruled: Rect[] = [116, 170, 190].map((y): Rect => [70, y, 562, y + 0.5]);
        expect(rowTexts(table(p, () => false, ruled).items[0])).toEqual([
            "E. Problematic Patterns | F. Alternative Thought | G. Re-rated Belief",
            "Jumping to conclusions Exaggerating or minimizing Ignoring important parts Oversimplifying | I hate that my friends died and although it did not seem critical to make that run I do not know what the lieutenant was thinking then. | Re-rate how much you now believe the thought in section B from zero to one hundred percent after all of this, rated here.",
            "Total | Rated 40 percent | Rated 60 percent",
            "Mean | Rated 50 percent | Rated 70 percent",
        ]);
        // Rows of their own start together across the columns, and stay rows; so do rows
        // whose label wraps beside a value that starts its next line.
        const rows = page([
            line(100, [[72, 250, "Pattern"], [300, 520, "Example"]]),
            line(120, [[72, 250, "Jumping to conclusions"], [300, 520, "He wanted us dead"]]),
            line(132, [[72, 250, "Exaggerating or minimizing"], [300, 520, "It was the worst day"]]),
            line(144, [[72, 250, "Forward primers for the mouse"], [300, 520, "Integrated DNA Technologies,"]]),
            line(156, [[72, 250, "papillomavirus 5-TAGCTTTGTCTG-3"], [300, 520, "Brendle et al."]]),
            line(168, [[72, 250, "Reverse primers for the mouse"], [300, 520, "Integrated DNA Technologies,"]]),
            line(180, [[72, 250, "papillomavirus 5-GTCAGTGGTGTC-3"], [300, 520, "Brendle et al."]]),
            line(200, [[72, 250, "Total"], [300, 520, "Three"]]),
            line(220, [[72, 250, "Mean"], [300, 520, "One"]]),
        ]);
        expect(table(rows, () => false, [116, 194, 214].map((y): Rect => [70, y, 522, y + 0.5])).items[0].rows.length).toBeGreaterThanOrEqual(6);
    });

    it("reads a ruled band one of whose columns a rule of its own divides as one row", () => {
        // B and its follow-up section C share a column, ruled apart; A runs on beside both.
        const p = page([
            line(100, [[72, 250, "A. Situation and its setting"], [300, 520, "B. Thought or stuck point here"]]),
            line(120, [[72, 170, "My lieutenant sent us."], [300, 400, "He got them killed."]]),
            line(133, [[72, 160, "Four friends died."], [300, 360, "C. Emotions"]]),
            line(146, [[72, 150, "Because of him."], [300, 390, "Angry, all of it."]]),
            line(168, [[72, 150, "Total"], [300, 420, "Rated 40 percent"]]),
            line(188, [[72, 150, "Mean"], [300, 420, "Rated 60 percent"]]),
        ]);
        const ruled: Rect[] = [116, 162, 182].map((y): Rect => [70, y, 522, y + 0.5]);
        const local: Rect = [298, 131.8, 522, 132.2];
        expect(rowTexts(table(p, () => false, [...ruled, local]).items[0])).toEqual([
            "A. Situation and its setting | B. Thought or stuck point here",
            "My lieutenant sent us. Four friends died. Because of him. | He got them killed. C. Emotions Angry, all of it.",
            "Total | Rated 40 percent",
            "Mean | Rated 60 percent",
        ]);
    });

    it("splits cells of neighbouring columns that one structured-text line joins at their gutter", () => {
        const p = page([
            line(100, [[72, 110, "Name"], [150, 200, "Location"], [300, 360, "Role"]]),
            line(115, [[72, 118, "Shuhei"], [150, 220, "Neurology"], [300, 380, "Analysis"]]),
            // MuPDF set the name and the location as one line, 12 pt apart across the gutter.
            line(130, [[72, 138, "Ryo Ogawa,"], [150, 230, "Department"], [300, 380, "Revision"]]),
            line(145, [[72, 120, "Juichi"], [150, 220, "Pharmacy"], [300, 380, "Supervision"]]),
            // A note whose word gaps do not fall in the gutters stays one cell.
            line(160, [[72, 160, "Note values"], [168, 380, "are means of the three ratings"]]),
        ]);
        const { items } = table(p);
        expect(rowTexts(items[0])).toEqual([
            "Name | Location | Role",
            "Shuhei | Neurology | Analysis",
            "Ryo Ogawa, | Department | Revision",
            "Juichi | Pharmacy | Supervision",
            "Note values are means of the three ratings",
        ]);
    });

    it("honours row rules in a sideways table", () => {
        // The upright table of the rule case, turned to read down the page: an upright
        // line at y covers page x from 600 - y - 11 to 600 - y, its text running down.
        const sideways = (y: number, y0: number, y1: number, text: string): RawLineDetailed => {
            const x = 600 - y - 11;
            const step = (y1 - y0) / text.length;
            const font = { name: "Times-Roman", family: "Times", weight: "normal", style: "normal", size: BS };
            return {
                wmode: 0,
                bbox: { l: x, t: y0, r: x + 11, b: y1, origin: "top-left" },
                font,
                x,
                y: y0,
                text,
                rotation: 90,
                chars: [...text].map((c, i) => ({ c, quad: [], bbox: { l: x, t: y0 + i * step, r: x + 11, b: y0 + (i + 1) * step, origin: "top-left" } })),
                spans: [{ start: 0, font }],
            } as unknown as RawLineDetailed;
        };
        const p = page([
            sideways(100, 72, 140, "Planning"),
            sideways(100, 200, 498, "Change can be controlled by senior managers in a"),
            sideways(112, 200, 470, "top-down fashion through formal plans and"),
        ]);
        expect(table(p).items[0].rows).toHaveLength(1);
        expect(table(p, () => false, [], [[488, 195, 488.5, 500]]).items[0].rows).toHaveLength(2);
    });

    it("starts a row at a new sentence in the first column", () => {
        const p = page([
            line(100, [[72, 240, "Managers set the strategy for the firm."], [300, 540, "They decide which markets the firm will enter."]]),
            line(112, [[72, 240, "Employees carry out the daily work there."], [300, 540, "They report progress to their managers weekly."]]),
        ]);
        expect(rowTexts(table(p).items[0])).toEqual([
            "Managers set the strategy for the firm. | They decide which markets the firm will enter.",
            "Employees carry out the daily work there. | They report progress to their managers weekly.",
        ]);
    });

    it("honours row rules in an upside-down table", () => {
        // The upright table of the rule case, turned 180 degrees on the page.
        const H = 800;
        const turned = (y: number, cells: Cell[]) => line(H - y - 11, cells.map(([x0, x1, t]): Cell => [612 - x1, 612 - x0, t]).reverse(), 180);
        const p = page([
            turned(100, [[72, 140, "Planning"], [200, 498, "Change can be controlled by senior managers in a"]]),
            turned(112, [[200, 470, "top-down fashion through formal plans and"]]),
        ]);
        expect(table(p).items[0].rows).toHaveLength(1);
        expect(table(p, () => false, [[112, H - 112, 417, H - 111.5]]).items[0].rows).toHaveLength(2);
    });

    it("keeps one-line rows of a list apart, and lines set apart from their cell", () => {
        const fitted = (x: number, t: string): Cell => [x, x + 5.5 * t.length, t];
        const list = page(
            ["Concept|Search term", "cultural capital|‘cultural*capital*’ or ‘capital*cultural’", "economic capital|‘economic*capital*’ or ‘capital*economic’", "social capital|‘social*capital*’ or ‘capital*social’"].map((r, i) => {
                const [a, b] = r.split("|");
                return line(100 + 12 * i, [fitted(72, a), fitted(200, b)]);
            }),
        );
        expect(table(list).items[0].rows).toHaveLength(4);
        // Two lists set side by side: an entry missing on the right does not make the row ragged.
        const symbols = page([
            line(100, [[72, 90, "Pe"], [115, 200, "Peclet number"], [300, 310, "h"], [335, 440, "angle around the pin"]]),
            line(112, [[72, 90, "q00"], [115, 270, "heat flux at any axial section."]]),
            line(124, [[72, 90, "Re"], [115, 200, "Reynolds number"], [300, 310, "e"], [335, 440, "dissipation rate"]]),
        ]);
        expect(table(symbols).items[0].rows).toHaveLength(3);

        const wrapped = (second: Cell, y = 112) =>
            page([
                line(100, [[72, 140, "Planning"], [200, 498, "Change can be controlled by senior managers in a"]]),
                line(y, [second]),
                line(170, [[72, 140, "Control"], [200, 498, "Monitoring of change by ticking activities off charts."]]),
            ]);
        expect(table(wrapped([200, 470, "top-down fashion through formal plans."])).items[0].rows).toHaveLength(2);
        // Too far below, or indented too far, to be the cell's next line.
        expect(table(wrapped([200, 470, "top-down fashion through formal plans."], 140)).items[0].rows).toHaveLength(3);
        expect(table(wrapped([260, 500, "top-down fashion through formal plans."])).items[0].rows).toHaveLength(3);
    });

    it("starts a row at a new list item even when another column wraps", () => {
        const p = page([
            line(100, [[72, 160, "Definition"], [200, 300, "Definition"], [350, 500, "Revenue - Percentage (RP)"]]),
            line(112, [[72, 160, "for 3+ consecutive"], [200, 300, "over a period of 3"], [350, 500, "Employees - Absolute (EA)"]]),
            // "years" continues its cell, but "Employees - Percentage" is the next item of a list.
            line(124, [[72, 100, "years"], [200, 228, "years"], [350, 500, "Employees - Percentage (EP)"]]),
        ]);
        expect(table(p).items[0].rows.map((r) => r.map((c) => c.text).join(" | "))).toEqual([
            "Definition | Definition | Revenue - Percentage (RP)",
            "for 3+ consecutive | over a period of 3 | Employees - Absolute (EA)",
            "years | years | Employees - Percentage (EP)",
        ]);
    });

    it("keeps lists set side by side in one row: an item cannot start a row mid-sentence beside it", () => {
        const p = page([
            line(100, [[72, 250, "Minimum Characteristics"], [320, 500, "Advanced Characteristics"]]),
            line(118, [[72, 250, "• Access is facilitated to tools"], [320, 500, "• Greater access to clinical"]]),
            line(130, [[84, 250, "and resources such as clinical"], [332, 500, "supports is facilitated for all"]]),
            line(142, [[84, 250, "and quality improvement tools."], [320, 500, "• PCN co-designs and tests new"]]),
            line(154, [[72, 250, "• PCN collaborates with local"], [332, 500, "primary-care focused digital tools."]]),
            line(166, [[84, 250, "and provincial partners."], [332, 380, ""]].filter(([, , t]) => t)),
        ]);
        expect(table(p).items[0].rows.map((r) => r.map((c) => c.text).join(" | "))).toEqual([
            "Minimum Characteristics | Advanced Characteristics",
            "• Access is facilitated to tools and resources such as clinical and quality improvement tools. • PCN collaborates with local and provincial partners. | " +
                "• Greater access to clinical supports is facilitated for all • PCN co-designs and tests new primary-care focused digital tools.",
        ]);
    });

    it("judges whether a region reads as a table on its rows without the header or open phrases joined", () => {
        // A header line in lower case is a fragment of the rows read line by line, as before the
        // header was read as one row: the table of running text stays in the prose.
        const p = page([
            line(100, [[250, 330, "Violent"], [400, 470, "Property"]]),
            line(112, [[250, 330, "crimes"], [400, 470, "crimes"]]),
            line(130, [[72, 180, "Age"], [250, 330, "Older people are less often the victims"], [400, 470, "A weaker effect than the one for violence"]]),
            line(142, [[72, 180, "Income"], [250, 330, "Richer people are less often the victims"], [400, 470, "Richer households are more often the target"]]),
            line(154, [[72, 180, "Gender"], [250, 330, "Men are more often the victims of assault"], [400, 470, "No difference between men and women here"]]),
            line(166, [[72, 180, "Region"], [250, 330, "Cities have more of the reported offences"], [400, 470, "Cities again have more reported offences"]]),
        ]);
        const d = detection(p, [["table", [60, 60, 560, 700]]]);
        d.routing!.flags = d.routing!.lines.map((l) => (l.words >= 6 ? LINE_RUNNING : 0));
        expect(regionItemsForPage(p, d).items).toEqual([]);
    });

    it("leaves a table of running text to the prose when its rows are fragments of sentences", () => {
        // Questions wrapping over several lines whose continuations fall into rows of their own.
        const rows: [string, string?][] = [
            ["Question", "Method"],
            ["How can the local supply chains plan", "Robust optimization"],
            ["to respond to disasters at a local"],
            ["and global scale in terms of relief?"],
            ["How smart cities can help to support", "System dynamics"],
            ["epidemic epicenters and their hospitals?", "and simulation"],
            ["What makes operations in disturbed", "Stochastic"],
            ["supply chains resilient to the shock?", "programming"],
        ];
        const p = page(rows.map(([a, b], k) => line(100 + 30 * k, b ? [[72, 250, a], [320, 420, b]] : [[72, 250, a]])));
        const d = detection(p, [["table", [60, 60, 560, 700]]]);
        // The long cells read as running text; the table holds them all the same.
        d.routing!.flags = d.routing!.lines.map((l) => (l.words >= 6 ? LINE_RUNNING : 0));
        expect(regionItemsForPage(p, d).items).toEqual([]);
        // So does one with rules that leave several rows between them.
        d.routing!.rules = [120, 240, 300].map((y): Rect => [70, y, 422, y + 0.5]);
        expect(regionItemsForPage(p, d).items).toEqual([]);
        // With its cells whole, the same table reads row by row.
        const whole = page([
            line(100, [[72, 250, "Question"], [320, 420, "Method"]]),
            line(130, [[72, 250, "How can the local supply chains respond?"], [320, 420, "Robust optimization"]]),
            line(160, [[72, 250, "How can smart cities support epicenters?"], [320, 420, "System dynamics"]]),
            line(190, [[72, 250, "What makes operations resilient to shocks?"], [320, 420, "Stochastic programming"]]),
        ]);
        const w = detection(whole, [["table", [60, 60, 560, 700]]]);
        w.routing!.flags = w.routing!.lines.map((l) => (l.words >= 6 ? LINE_RUNNING : 0));
        expect(regionItemsForPage(whole, w).items[0].rows).toHaveLength(4);
    });

    it("keeps a table ruled under every row whose key columns happen to run in order", () => {
        const records = [
            ["Alpha", "Mouse", "0.91"],
            ["Bravo", "Rabbit", "0.87"],
            ["Charlie", "Rat", "0.78"],
            ["Delta", "Sheep", "0.82"],
            ["Echo", "Swine", "0.69"],
            ["Foxtrot", "Wolf", "0.95"],
        ];
        const p = page([
            line(100, [[72, 150, "Accession"], [220, 300, "Model"], [380, 420, "Score"]]),
            ...records.map(([a, m, v], k) => line(124 + 20 * k, [[72, 150, a], [220, 300, m], [380, 420, v]])),
        ]);
        const rows = ["Accession | Model | Score", ...records.map((r) => r.join(" | "))];
        const rules: Rect[] = [96, 118, 140, 160, 180, 200, 220, 240].map((y): Rect => [70, y, 422, y + 0.5]);
        const d = detection(p, [["table", [60, 60, 560, 700]]]);
        d.routing!.rules = rules;
        expect(rowTexts(regionItemsForPage(p, d).items[0])).toEqual(rows);
        // Without rules between its rows the value column still pairs each record.
        const open = detection(p, [["table", [60, 60, 560, 700]]]);
        open.routing!.rules = [96, 118, 240].map((y): Rect => [70, y, 422, y + 0.5]);
        expect(rowTexts(regionItemsForPage(p, open).items[0])).toEqual(rows);
    });

    it("keeps a text table ruled under every row whose cells start lower case", () => {
        const records = [
            ["enrolment", "education", "total enrolled students divided by the population"],
            ["literacy", "education", "share of adults who can read and write a short text"],
            ["income", "economy", "gross household income per adult member in dollars"],
            ["tenure", "housing", "share of households that own the dwelling they live in"],
        ];
        const p = page([
            line(100, [[72, 150, "Variable"], [190, 260, "Category"], [300, 540, "Definition"]]),
            ...records.map(([v, c, d], k) => line(124 + 20 * k, [[72, 150, v], [190, 260, c], [300, 540, d]])),
        ]);
        const rules: Rect[] = [96, 118, 140, 160, 180, 200].map((y): Rect => [70, y, 542, y + 0.5]);
        const d = detection(p, [["table", [60, 60, 560, 700]]]);
        d.routing!.flags = d.routing!.lines.map((l) => (l.words >= 6 ? LINE_RUNNING : 0));
        d.routing!.rules = rules;
        expect(rowTexts(regionItemsForPage(p, d).items[0])).toEqual(["Variable | Category | Definition", ...records.map((r) => r.join(" | "))]);
    });

    it("never reads a decimal value as a list item", () => {
        const p = page([
            line(100, [[72, 330, "(metaverse, digital economy and its main users)"], [400, 440, "0.923"]]),
            line(112, [[72, 330, "(digital economy, digital transformation and"], [400, 440, "0.902"]]),
            line(124, [[72, 330, "(digital economy, wearable device and services)"], [400, 440, "0.829"]]),
        ]);
        expect(table(p).items[0].rows).toHaveLength(3);
    });

    it("takes columns from rows whose cells stand side by side, not from pieces stacked in a row", () => {
        // Labels set as two short pieces stacked in each row: four pieces but three columns.
        const stacked = (y: number, a: string, b: string, mean: string, sd: string) => [
            line(y, [[72, 90, a], [200, 230, mean], [300, 330, sd]]),
            line(y + 3, [[73, 89, b]]),
        ];
        const p = page([
            ...stacked(100, "Core", "var", "0.003", "0.618"),
            ...stacked(115, "Ctrl", "var", "1.821", "0.619"),
            ...stacked(130, "Main", "var", "2.221", "4.698"),
            line(145, [[72, 120, "Age"], [200, 230, "63.09"], [300, 330, "11.65"]]),
            line(160, [[72, 120, "Gender"], [200, 230, "0.845"], [300, 330, "0.362"]]),
        ]);
        const { items } = table(p);
        expect(items[0].columns).toBe(3);
        expect(items[0].rows.slice(-2).map((r) => r.map((c) => c.column))).toEqual([
            [0, 1, 2],
            [0, 1, 2],
        ]);
    });

    it("takes columns from rows that align, not from a line split at wide word gaps, and joins its pieces", () => {
        const p = page([
            line(100, [[72, 160, "Student (2020)"], [200, 350, "Businesses are tourism operators"], [400, 540, "Operators decrease"]]),
            // Justified word gaps split one line of the middle column into pieces.
            line(112, [[200, 240, "Returns;"], [265, 300, "revenue;"], [325, 350, "costs;"], [400, 540, "For all types."]]),
            line(124, [[72, 160, "Suh (2019)"], [200, 350, "Households travel by car"], [400, 540, "Protection is effective"]]),
            line(136, [[72, 160, "Sun (2020)"], [200, 350, "Travel by car or transit"], [400, 540, "Results are mixed"]]),
        ]);
        const { items } = table(p);
        expect(items[0].columns).toBe(3);
        // The split line's pieces in one column are one cell again.
        expect(items[0].rows.map((r) => r.map((c) => c.column ?? -1))).toEqual([[0, 1, 2], [1, 2], [0, 1, 2], [0, 1, 2]]);
        expect(items[0].rows[1].map((c) => c.text)).toEqual(["Returns; revenue; costs;", "For all types."]);
    });

    it("never takes columns from rows whose values sit in different columns", () => {
        // Centred headers over right-aligned values; each row lacks one of the two values.
        const p = page([
            line(100, [[72, 130, "Variable"], [255, 295, "Model 1"], [395, 435, "Model 2"]]),
            line(115, [[72, 110, "Age"], [300, 320, "0.23"]]),
            line(130, [[72, 120, "Income"], [400, 460, "123456.789"]]),
            line(145, [[72, 120, "Female"], [305, 320, "1.5"]]),
            line(160, [[72, 120, "Married"], [445, 460, "2.1"]]),
        ]);
        const { items } = table(p);
        expect(items[0].columns).toBe(3);
        const cell = (text: string) => items[0].rows.flat().find((c) => c.text === text)!;
        expect(cell("123456.789").column).not.toBe(cell("0.23").column ?? -1);
    });

    it("takes columns from all rows with the most cells, though they do not line up cell by cell", () => {
        // A matrix whose values sit between its header labels.
        const p = page([
            line(100, [[72, 110, "Variable"], [150, 170, "ESG"], [250, 270, "Size"], [350, 370, "Roe"]]),
            line(115, [[72, 100, "ESG"], [180, 210, "0.204"], [280, 310, "0.154"], [380, 410, "-0.105"]]),
            line(130, [[72, 100, "Size"], [180, 210, "0.185"], [280, 310, "0.041"], [380, 410, "0.228"]]),
            line(145, [[72, 100, "Roe"], [180, 210, "0.012"], [280, 310, "0.310"], [380, 410, "0.093"]]),
        ]);
        const { items } = table(p);
        expect(items[0].columns).toBe(4);
        expect(items[0].rows.map((r) => r.map((c) => c.column))).toEqual(Array.from({ length: 4 }, () => [0, 1, 2, 3]));
    });

    it("keeps a label column that only the header row spans", () => {
        const p = page([
            line(100, [[72, 150, "Variable"], [250, 320, "Model 1"], [400, 470, "Model 2"]]),
            line(115, [[72, 200, "Free school meals"]]),
            line(130, [[250, 320, "0.221"], [400, 470, "0.375"]]),
            line(145, [[72, 200, "Neighbourhood deprivation"]]),
            line(160, [[250, 320, "0.178"], [400, 470, "0.265"]]),
        ]);
        const { items } = table(p);
        expect(items[0].columns).toBe(3);
        expect(items[0].rows[2].map((c) => c.column)).toEqual([1, 2]);
    });

    it("leaves a table without column structure or with its text left in the prose to the prose", () => {
        // A code listing: one cell per line, the long lines read as running text.
        const code = [
            line(100, [[72, 160, "def approx(q):"]]),
            line(112, [[90, 540, "    return conf.periods[i] * lookup(q, window=conf.window, scatter=True, mask=mask_bits)"]]),
            line(124, [[90, 200, "    for i in range:"]]),
            line(136, [[108, 540, "        accumulate(conf.window, q, lookup(q, window=conf.window, scatter=False))"]]),
            line(148, [[108, 200, "        q.free()"]]),
        ];
        const listing = page(code);
        const isLong = (t: string) => t.length > 60;
        const out = table(listing, isLong);
        expect(out.items).toEqual([]);
        expect(allText(out.page)).toEqual(code.map((l) => l.text));

        // Values whose row labels were read as running text.
        const stranded = page(
            [line(100, [[72, 240, "Mother smoked prior to pregnancy"]]), line(112, [[72, 240, "Mother drank during pregnancy"]]), line(124, [[72, 240, "Mother went to mothercraft"]])],
            [line(100, [[300, 340, "0.318"], [400, 440, "0.273"]]), line(112, [[300, 340, "0.950"], [400, 440, "0.988"]]), line(124, [[300, 340, "0.366"], [400, 440, "0.359"]])],
            [line(88, [[72, 120, "Variable"], [300, 340, "Model 1"], [400, 440, "Model 2"]]), line(136, [[72, 110, "Total"], [300, 340, "0.501"], [400, 440, "0.512"]])],
        );
        expect(table(stranded, (t) => t.startsWith("Mother")).items).toEqual([]);

        // Single lines with one row of two cells: no column structure.
        const lines = page([
            line(100, [[72, 77, "{"]]),
            line(112, [[90, 172, "\"Type\": \"array\","]]),
            line(124, [[90, 140, "\"Items\": {"]]),
            line(136, [[108, 178, "\"Name\": \"step\""], [300, 355, "// the step"]]),
            line(148, [[108, 203, "\"Kind\": \"object\","]]),
            line(160, [[90, 100, "},"]]),
            line(172, [[90, 163, "\"Size\": 1024,"]]),
            line(184, [[72, 77, "}"]]),
        ]);
        expect(table(lines).items).toEqual([]);

        // A title alone.
        expect(table(page([line(100, [[72, 250, "PARAMETER SETTINGS"]])])).items).toEqual([]);
    });

    it("counts only text within the table's columns as left out of it", () => {
        // A two-column table took in two lines of the text column beside it; the prose
        // between them is not text of the table.
        const rows = Array.from({ length: 30 }, (_, i) => line(100 + 12 * i, [[72, 150, `Characteristic ${i}`], [250, 290, `${i} (4.4)`]]));
        const beside = Array.from({ length: 30 }, (_, i) =>
            line(100 + 12 * i, [[318, 548, i === 3 ? "RESULTS" : i === 20 ? "in upper tract in a third of patients." : `patients received the treatment in cycle ${i} of the study`]]),
        );
        const strays = new Set(["RESULTS", "in upper tract in a third of patients."]);
        const out = table(page(rows, beside), (t) => t.startsWith("patients received"));
        expect(out.items).toHaveLength(1);
        expect(out.items[0].rows).toHaveLength(30);
        expect(out.items[0].rows.flat().filter((c) => strays.has(c.text))).toHaveLength(2);
    });

    it("leaves a one-column listing with lines left in the prose to the prose", () => {
        const short = (y: number, i: number) => line(y, [[72, 180, `Q${i} = lookup(conf, ${i})`]]);
        const lines = [
            ...Array.from({ length: 5 }, (_, i) => short(100 + 12 * i, i)),
            line(160, [[72, 400, "Accumulate(conf.window, q, lookup(q, window=conf.window))"]]),
            ...Array.from({ length: 5 }, (_, i) => short(172 + 12 * i, i + 5)),
        ];
        const p = page(lines);
        // Kept whole it is a list; with its long line left out it is a fragment.
        expect(table(p).items[0].rows).toHaveLength(11);
        expect(table(p, (t) => t.startsWith("Accumulate")).items).toEqual([]);
    });

    it("leaves a list set in columns to the prose: it reads down the columns", () => {
        const left = ["additive bilingualism", "adolescent register", "alphabetic principle", "automaticity", "bottom-up model", "deep orthographies"];
        const right = ["narrative mode", "paradigmatic mode", "phonological recoding", "reading for meaning", "segmentation", "submersion"];
        const p = page(left.map((t, k) => line(100 + 15 * k, [[72, 220, t], [320, 470, right[k]]])));
        expect(table(p).items).toEqual([]);
        // Reference entries under a hanging indent, an author heading several of them.
        const refs = page([
            line(100, [[72, 220, "Abbott, Andrew"], [320, 470, "Bechky, Beth A."]]),
            line(112, [[90, 230, "1988 The system of professions"], [338, 480, "2003b Object lessons"]]),
            line(124, [[72, 220, "Balogun, J., and P. Johnson"], [320, 470, "Bechky, Beth A."]]),
            line(136, [[90, 230, "2003 Three responses to the"], [338, 480, "2006a Gaffers, gofers"]]),
            line(148, [[72, 220, "Barley, Stephen R."], [320, 470, "Brown, John Seely"]]),
            line(160, [[90, 230, "1996a Technicians in the"], [338, 480, "1991 Organizational learning"]]),
            line(172, [[72, 220, "Barley, Stephen R."], [320, 470, "Bryan, Lowell L."]]),
        ]);
        expect(table(refs).items).toEqual([]);
    });

    it("keeps a table whose columns are in order across its rows, or repeat values", () => {
        // Terms and their abbreviations: in order down the columns and across the rows.
        const terms = ["alpha", "beta", "delta", "gamma", "kappa", "sigma"];
        const p = page(terms.map((t, k) => line(100 + 15 * k, [[72, 220, `${t} level`], [320, 470, `${t} rate`]])));
        expect(table(p).items).toHaveLength(1);
        // Sorted parameter columns of a results table key nothing: bare numbers are no entries.
        const grid = page(Array.from({ length: 6 }, (_, k) => line(100 + 15 * k, [[72, 120, String(5 * (k + 1))], [200, 250, "0"], [320, 370, "0.81"]])));
        expect(table(grid).items).toHaveLength(1);
        // Label columns each in order down the rows, but the second does not start where the first ends.
        const labels = [["HEiDi", "Cold"], ["HEiDi", "Cold"], ["HEiDi", "Ice"], ["TriCS", "Ice"]];
        const runs = page(labels.map(([a, b], k) => line(100 + 15 * k, [[72, 120, a], [200, 250, b], [320, 370, "0.81"]])));
        expect(table(runs).items).toHaveLength(1);
    });

    it("keeps a clean one-column list, and a table without a text layer as an empty item", () => {
        const list = page([
            line(100, [[72, 200, "Pre-operative"]]),
            line(115, [[90, 220, "Beta-blocker therapy"]]),
            line(130, [[72, 200, "Operative technique"]]),
            line(145, [[90, 260, "Internal mammary artery use"]]),
        ]);
        const { items } = table(list);
        expect(rowTexts(items[0])).toEqual(["Pre-operative", "Beta-blocker therapy", "Operative technique", "Internal mammary artery use"]);
        expect(items[0].columns).toBeUndefined();

        // A raster table: no text stands in its box.
        const prose = page([line(800, [[72, 540, PROSE]])]);
        const empty = table(prose);
        expect(empty.items.map((i) => [i.kind, i.rows])).toEqual([["table", []]]);
        // A table whose text all went back to the prose is no item.
        const returned = page([line(120, [[72, 540, PROSE]])]);
        expect(table(returned, () => true).items).toEqual([]);
    });
});

function textItem(index: number, box: Rect, sentences: string[], joinWithNext = false): DocItem {
    const id = `p0:i${index}`;
    const bbox: BoundingBox = { l: box[0], t: box[1], r: box[2], b: box[3], origin: "top-left" };
    return {
        kind: "text",
        id,
        pageIndex: 0,
        index,
        bbox,
        columnIndex: box[0] > 300 ? 1 : 0,
        text: sentences.join(" "),
        lines: [{ text: sentences.join(" "), bbox }],
        sentences: sentences.map((text, i) => ({
            parentId: id,
            index: i,
            text,
            bboxes: [bbox],
            ...(joinWithNext && i === sentences.length - 1 ? { joinWithNext: true } : {}),
        })),
    };
}

function draft(kind: RegionItemDraft["kind"], box: Rect, rows: string[][] = []): RegionItemDraft {
    const bbox: BoundingBox = { l: box[0], t: box[1], r: box[2], b: box[3], origin: "top-left" };
    return { kind, region: 0, bbox, rows: rows.map((r) => r.map((text) => ({ text, bbox }))) };
}

describe("placeRegionItems", () => {
    // Two columns: left 72–290, right 320–540.
    const left = [textItem(0, [72, 80, 290, 200], ["A1.", "A2."]), textItem(1, [72, 400, 290, 500], ["B1."])];
    const right = [textItem(2, [320, 80, 540, 150], ["C1."]), textItem(3, [320, 450, 540, 520], ["D1."])];

    it("puts a region before the first item below it in its column and renumbers items and sentences", () => {
        const items = [...left, ...right];
        const table = draft("table", [320, 200, 540, 400], [["a", "b"], ["1", "2"]]);
        const out = placeRegionItems(0, items, [table]);

        expect(out.items.map((i) => i.kind)).toEqual(["text", "text", "text", "table", "text"]);
        expect(out.items.map((i) => i.id)).toEqual(["p0:i0", "p0:i1", "p0:i2", "p0:i3", "p0:i4"]);
        expect(out.items.map((i) => i.index)).toEqual([0, 1, 2, 3, 4]);
        const tableItem = out.items[3] as Extract<DocItem, { kind: "table" }>;
        expect(tableItem.text).toBe("a | b\n1 | 2");
        expect(tableItem.columnIndex).toBe(1);
        expect(tableItem.sentences?.map((s) => [s.parentId, s.index, s.text])).toEqual([
            ["p0:i3", 0, "a | b"],
            ["p0:i3", 1, "1 | 2"],
        ]);
        // Sentences follow item order, and moved items carry their sentences along.
        expect(out.sentences.map((s: SentenceItem) => `${s.parentId}/${s.text}`)).toEqual([
            "p0:i0/A1.", "p0:i0/A2.", "p0:i1/B1.", "p0:i2/C1.", "p0:i3/a | b", "p0:i3/1 | 2", "p0:i4/D1.",
        ]);
        expect(out.renamed.get("p0:i3")).toBe("p0:i4");
    });

    it("appends a region below every item and orders several regions top to bottom", () => {
        const eq = draft("formula", [72, 600, 290, 620], [["x = y", "(1)"]]);
        const fig = draft("picture", [72, 540, 290, 590]);
        const out = placeRegionItems(0, left, [eq, fig]);
        expect(out.items.map((i) => i.kind)).toEqual(["text", "text", "picture", "formula"]);
        expect(out.items[3].text).toBe("x = y (1)");
        expect(out.items[2].text).toBe("");
    });

    it("keeps column order for regions that close one column and open the next", () => {
        // Left column ends with item 1; the right column starts with item 2.
        const endOfLeft = draft("formula", [72, 600, 290, 620], [["x = 1"]]);
        const startOfRight = draft("formula", [320, 20, 540, 60], [["y = 2"]]);
        const out = placeRegionItems(0, [...left, ...right], [startOfRight, endOfLeft]);
        expect(out.items.map((i) => (i.kind === "formula" ? i.text : i.kind))).toEqual([
            "text", "text", "x = 1", "y = 2", "text", "text",
        ]);
    });

    it("reads side-by-side regions left to right, then the row below", () => {
        // Panels a | b above the caption, b set a little higher; panel c under them.
        const caption = textItem(0, [72, 400, 540, 420], ["Figure 1."]);
        const a = draft("picture", [72, 100, 290, 250], [["a"]]);
        const b = draft("picture", [320, 95, 540, 250], [["b"]]);
        const c = draft("picture", [72, 270, 540, 390], [["c"]]);
        const out = placeRegionItems(0, [caption], [c, b, a]);
        expect(out.items.map((i) => i.text)).toEqual(["a", "b", "c", "Figure 1."]);

        // Stacked boxes that overlap stay top to bottom, even when the lower one
        // starts further left.
        const upper = draft("formula", [100, 100, 400, 140], [["x = 1"]]);
        const lower = draft("formula", [80, 115, 380, 160], [["y = 2"]]);
        const stacked = placeRegionItems(0, [caption], [lower, upper]);
        expect(stacked.items.map((i) => i.text)).toEqual(["x = 1", "y = 2", "Figure 1."]);
    });

    it("never separates a sentence from its continuation past the column's footnotes", () => {
        // The left column ends mid-sentence above its footnote; the sentence
        // goes on at the top of the right column, under a figure.
        const body = textItem(0, [72, 80, 290, 600], ["Starts here and"], true);
        const note = { ...textItem(1, [72, 650, 290, 700], ["1 A note."]), kind: "footnote" } as DocItem;
        const items = [body, note, textItem(2, [320, 450, 540, 520], ["goes on here."])];
        const fig = draft("picture", [320, 80, 540, 400]);
        const out = placeRegionItems(0, items, [fig]);
        expect(out.items.map((i) => i.kind)).toEqual(["text", "footnote", "text", "picture"]);
    });

    it("never separates a sentence from its continuation in the next item", () => {
        const items = [textItem(0, [72, 80, 290, 700], ["Starts here and"], true), right[0], right[1]];
        const fig = draft("picture", [320, 20, 540, 60]);
        const out = placeRegionItems(0, items, [fig]);
        expect(out.items.map((i) => i.kind)).toEqual(["text", "text", "picture", "text"]);

        // A display equation is part of its sentence: at the foot of the left
        // column it comes before the sentence's continuation in the right one.
        const intro = textItem(0, [72, 80, 290, 600], ["We minimize the loss:"], true);
        const eq = draft("formula", [72, 620, 290, 660], [["L = Σ p log q (2)"]]);
        const placed = placeRegionItems(0, [intro, right[0], right[1]], [eq]);
        expect(placed.items.map((i) => i.kind)).toEqual(["text", "formula", "text", "text"]);
    });

    it("splits an equation box merged across the gutter and places each equation in its column", () => {
        // Each column: an introduction, an equation, the rest. One box took both
        // equations; column detection reads the columns through it and reports
        // which of its lines lie in which column.
        const intro = [textItem(0, [100, 100, 300, 240], ["Left intro:"]), textItem(2, [320, 100, 520, 240], ["Right intro:"])];
        const rest = [textItem(1, [100, 400, 300, 550], ["Left rest."]), textItem(3, [320, 400, 520, 550], ["Right rest."])];
        const cell = (text: string, box: Rect) => ({ text, bbox: { l: box[0], t: box[1], r: box[2], b: box[3], origin: "top-left" as const } });
        const merged: RegionItemDraft = {
            kind: "formula",
            region: 0,
            bbox: { l: 100, t: 260, r: 520, b: 370, origin: "top-left" },
            rows: [[cell("x = 1 (1)", [130, 300, 290, 320]), cell("y = 2 (2)", [350, 305, 520, 325])]],
        };
        const page = {
            pageIndex: 0,
            pageNumber: 1,
            width: 620,
            height: 700,
            blocks: [...intro, ...rest].map((item) => ({
                type: "text" as const,
                bbox: item.bbox,
                lines: [{ wmode: 0, bbox: item.bbox, font: { name: "Body", family: "Body", weight: "normal", style: "normal", size: 10 }, x: item.bbox.l, y: item.bbox.t, text: "body text" }],
            })),
        };
        const toRect = (b: BoundingBox) => ({ x: b.l, y: b.t, w: b.r - b.l, h: b.b - b.t });
        const columns = detectColumns(page, {
            regionBarriers: [{ box: toRect(merged.bbox), content: merged.rows.flat().map((c) => toRect(c.bbox)) }],
        });
        expect(columns.regionPieces).toEqual([[{ members: [0], body: [0] }, { members: [1], body: [1] }]]);
        const inOrder = [intro[0], rest[0], intro[1], rest[1]];
        const out = placeRegionItems(0, inOrder, splitRegionItems([merged], columns.regionPieces));
        expect(out.items.map((i) => i.text)).toEqual(["Left intro:", "x = 1 (1)", "Left rest.", "Right intro:", "y = 2 (2)", "Right rest."]);
        expect(out.items[1].bbox).toEqual(merged.rows[0][0].bbox);
    });

    it("anchors each piece of a region at the union of its body's cells", () => {
        const cell = (text: string, box: Rect) => ({ text, bbox: { l: box[0], t: box[1], r: box[2], b: box[3], origin: "top-left" as const } });
        const bb = (box: Rect) => ({ l: box[0], t: box[1], r: box[2], b: box[3], origin: "top-left" as const });
        const region: RegionItemDraft = {
            kind: "formula",
            region: 0,
            bbox: bb([40, 100, 560, 200]),
            rows: [
                [cell("(1)", [40, 100, 55, 110]), cell("a = b", [120, 100, 200, 110]), cell("c = d", [400, 100, 480, 110])],
                [cell("+ e", [130, 120, 210, 130]), cell("+ f", [410, 120, 490, 130])],
            ],
        };
        // One piece: the item keeps its rows and box and is placed by its body.
        const [whole] = splitRegionItems([region], [[{ members: [0, 1, 2, 3, 4], body: [1, 3] }]]);
        expect(whole.rows).toBe(region.rows);
        expect(whole.bbox).toEqual(region.bbox);
        expect(whole.anchor).toEqual(bb([120, 100, 210, 130]));
        // Two pieces: each takes its cells, its box spans them, its anchor its body.
        const [left, right] = splitRegionItems([region], [[{ members: [0, 1, 3], body: [1, 3] }, { members: [2, 4], body: [2, 4] }]]);
        expect(left.rows.map((r) => r.map((c) => c.text))).toEqual([["(1)", "a = b"], ["+ e"]]);
        expect(left.bbox).toEqual(bb([40, 100, 210, 130]));
        expect(left.anchor).toEqual(bb([120, 100, 210, 130]));
        expect(right.anchor).toEqual(bb([400, 100, 490, 130]));
        // Regions column detection left whole are passed through.
        expect(splitRegionItems([region], [undefined])).toEqual([region]);
    });

    it("places an equation by its body when a label in the other column's margin widens its box", () => {
        // A right-column equation with its number at the left margin; the left
        // column is one block running past it.
        const left = textItem(0, [100, 100, 300, 550], ["Left column."]);
        const intro = textItem(1, [320, 100, 520, 240], ["Right intro:"]);
        const rest = textItem(2, [320, 400, 520, 550], ["Right rest."]);
        const cell = (text: string, box: Rect) => ({ text, bbox: { l: box[0], t: box[1], r: box[2], b: box[3], origin: "top-left" as const } });
        const labelled: RegionItemDraft = {
            kind: "formula",
            region: 0,
            bbox: { l: 100, t: 270, r: 520, b: 360, origin: "top-left" },
            rows: [[cell("(4)", [100, 300, 115, 320]), cell("z = x + y", [350, 300, 500, 320])]],
        };
        const page = {
            pageIndex: 0,
            pageNumber: 1,
            width: 620,
            height: 700,
            blocks: [left, intro, rest].map((item) => ({
                type: "text" as const,
                bbox: item.bbox,
                lines: [{ wmode: 0, bbox: item.bbox, font: { name: "Body", family: "Body", weight: "normal", style: "normal", size: 10 }, x: item.bbox.l, y: item.bbox.t, text: "body text" }],
            })),
        };
        const toRect = (b: BoundingBox) => ({ x: b.l, y: b.t, w: b.r - b.l, h: b.b - b.t });
        const columns = detectColumns(page, {
            regionBarriers: [{ box: toRect(labelled.bbox), content: labelled.rows.flat().map((c) => toRect(c.bbox)) }],
        });
        const out = placeRegionItems(0, [left, intro, rest], splitRegionItems([labelled], columns.regionPieces));
        expect(out.items.map((i) => i.text)).toEqual(["Left column.", "Right intro:", "(4) z = x + y", "Right rest."]);
        // The item keeps its whole box.
        expect(out.items[2].bbox).toEqual(labelled.bbox);
    });

    it("places regions in the reading frame of a sideways page and keeps MuPDF-frame boxes", () => {
        // The upright two-column layout as it sits on a 792×612 page whose text runs bottom to top.
        const frame = { rotation: 90 as const, sourceWidth: 792, sourceHeight: 612 };
        const toSource = (b: BoundingBox) => inverseRotateBBox(b, frame.rotation, frame.sourceWidth, frame.sourceHeight);
        const items = [...left, ...right].map((item) => ({ ...item, bbox: toSource(item.bbox) }));
        const table = draft("table", [320, 200, 540, 400], [["a", "b"]]);
        const sourceTable = { ...table, bbox: toSource(table.bbox) };

        const out = placeRegionItems(0, items, [sourceTable], frame);
        expect(out.items.map((i) => i.kind)).toEqual(["text", "text", "text", "table", "text"]);
        expect(out.items[3].bbox).toEqual(sourceTable.bbox);
        expect(out.items[4].bbox).toEqual(items[3].bbox);
    });
});
