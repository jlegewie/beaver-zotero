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
import type { DetectedRegion, RegionDetection } from "../../../src/beaver-extract/regions/RegionDetector";
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

    it("keeps figure labels, drops rows of bare numbers and removes decoration text without an item", () => {
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
        expect(allText(rest)).toEqual([]);
        expect(rest.blocks).toHaveLength(0);
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
        expect(scanned).toEqual({ page: p, items: [] });
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
    return { kind, bbox, rows: rows.map((r) => r.map((text) => ({ text, bbox }))) };
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
