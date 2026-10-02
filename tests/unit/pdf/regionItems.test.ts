import { describe, expect, it } from "vitest";

import type {
    BoundingBox,
    DocItem,
    RawLineDetailed,
    RawPageDataDetailed,
    SentenceItem,
} from "@beaver/agent-core/extract/types";

import { inverseRotateBBox } from "../../../src/beaver-extract/PageRotationNormalizer";
import type { Rect } from "../../../src/beaver-extract/regions/geometry";
import type { RegionClass } from "../../../src/beaver-extract/regions/model";
import { mergeRowFragments, pageLines } from "../../../src/beaver-extract/regions/pageSignals";
import {
    LINE_FURNITURE,
    LINE_SKEWED,
    type DetectedRegion,
    type RegionDetection,
} from "../../../src/beaver-extract/regions/RegionDetector";
import {
    PICTURE_TEXT_MAX_CHARS,
    placeRegionItems,
    regionItemsForPage,
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
    return { pageIndex: 0, scanned: false, bodySize: BS, candidates, routing: { lines, flags: lines.map(() => 0), routes }, ms: 0 };
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
        expect(out.items[0].rows).toEqual([]);
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
        expect(items.map((i) => [i.kind, i.rows])).toEqual([["table", []]]);
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
            line(112, [[250, 320, "(0.05)"], [400, 470, "(0.04)"]]),
            line(124, [[72, 150, "Income"], [250, 320, "1.10"], [400, 470, "0.98"]]),
        ]);
        expect(rowTexts(table(values).items[0])).toEqual(["Age | 0.23 | 0.19", "(0.05) | (0.04)", "Income | 1.10 | 0.98"]);

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

    it("takes columns from rows that align, not from a line split at wide word gaps", () => {
        const p = page([
            line(100, [[72, 160, "Student (2020)"], [200, 350, "Businesses are tourism operators"], [400, 540, "Operators decrease"]]),
            // Justified word gaps split one line of the middle column into pieces.
            line(112, [[200, 240, "Returns;"], [265, 300, "revenue;"], [325, 350, "costs;"], [400, 540, "For all types."]]),
            line(124, [[72, 160, "Suh (2019)"], [200, 350, "Households travel by car"], [400, 540, "Protection is effective"]]),
            line(136, [[72, 160, "Sun (2020)"], [200, 350, "Travel by car or transit"], [400, 540, "Results are mixed"]]),
        ]);
        const { items } = table(p);
        expect(items[0].columns).toBe(3);
        expect(items[0].rows.map((r) => r.map((c) => c.column ?? -1))).toEqual([[0, 1, 2], [-1, -1, -1, -1], [0, 1, 2], [0, 1, 2]]);
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

    it("keeps a clean one-column list and a table without text", () => {
        const list = page([
            line(100, [[72, 200, "Pre-operative"]]),
            line(115, [[90, 220, "Beta-blocker therapy"]]),
            line(130, [[72, 200, "Operative technique"]]),
            line(145, [[90, 260, "Internal mammary artery use"]]),
        ]);
        const { items } = table(list);
        expect(rowTexts(items[0])).toEqual(["Pre-operative", "Beta-blocker therapy", "Operative technique", "Internal mammary artery use"]);
        expect(items[0].columns).toBeUndefined();

        const prose = page([line(800, [[72, 540, PROSE]])]);
        const empty = table(prose);
        expect(empty.items.map((i) => [i.kind, i.rows])).toEqual([["table", []]]);
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

    it("never separates a sentence from its continuation in the next item", () => {
        const items = [textItem(0, [72, 80, 290, 700], ["Starts here and"], true), right[0], right[1]];
        const fig = draft("picture", [320, 20, 540, 60]);
        const out = placeRegionItems(0, items, [fig]);
        expect(out.items.map((i) => i.kind)).toEqual(["text", "text", "picture", "text"]);
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
