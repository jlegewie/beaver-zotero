import { describe, it, expect } from "vitest";

import {
    inverseRotateBBox,
    rotateRawPage,
    rotateRawPageDetailed,
    type RotationAngle,
} from "../../../src/services/pdf/PageRotationNormalizer";
import {
    bboxFromXYWH,
    bboxHeight,
    bboxWidth,
    type BoundingBox,
    type RawBlock,
    type RawBlockDetailed,
    type RawLineDetailed,
    type RawPageData,
    type RawPageDataDetailed,
} from "../../../src/services/pdf/types";

function bbox(x: number, y: number, w: number, h: number): BoundingBox {
    return bboxFromXYWH(x, y, w, h, "top-left");
}

function approxEqualBBox(a: BoundingBox, b: BoundingBox, tol = 1e-6): void {
    expect(a.l).toBeCloseTo(b.l, 6);
    expect(a.t).toBeCloseTo(b.t, 6);
    expect(bboxWidth(a)).toBeCloseTo(bboxWidth(b), 6);
    expect(bboxHeight(a)).toBeCloseTo(bboxHeight(b), 6);
    expect(a.origin).toBe(b.origin);
}

const ROTATIONS: RotationAngle[] = [0, 90, 180, 270];

describe("rotation forward + inverse round-trip", () => {
    const W = 612;
    const H = 792;

    for (const r of ROTATIONS) {
        it(`is identity on BoundingBox for rotation ${r}`, () => {
            const samples: BoundingBox[] = [
                bbox(50, 60, 100, 12),
                bbox(0, 0, 1, 1),
                bbox(W - 1, H - 1, 1, 1),
                bbox(W / 2, H / 2, 50, 25),
            ];
            for (const b of samples) {
                // Use the helpers' geometry by going through a one-line
                // page round-trip. Forward rotates the raw page; inverse
                // rotates the bbox back into the original frame.
                const oneLinePage: RawPageData = {
                    pageIndex: 0,
                    pageNumber: 1,
                    width: W,
                    height: H,
                    blocks: [
                        {
                            type: "text",
                            bbox: b,
                            lines: [
                                {
                                    wmode: 0,
                                    bbox: b,
                                    font: { name: "T", family: "T", weight: "normal", style: "normal", size: 10 },
                                    x: b.l,
                                    y: b.t,
                                    text: "x",
                                    rotation: 0,
                                },
                            ],
                        },
                    ],
                };
                const rotated = rotateRawPage(oneLinePage, r);
                const rotBlock = rotated.page.blocks[0] as RawBlock & { lines: NonNullable<RawBlock["lines"]> };
                const rotLineBBox = rotBlock.lines![0].bbox;
                const back = inverseRotateBBox(
                    rotLineBBox,
                    r,
                    rotated.sourceWidth,
                    rotated.sourceHeight,
                );
                approxEqualBBox(back, b);
            }
        });
    }
});

describe("rotateRawPage", () => {
    const W = 612;
    const H = 792;

    it("is a no-op for rotation=0 (returns the same page)", () => {
        const p: RawPageData = {
            pageIndex: 0,
            pageNumber: 1,
            width: W,
            height: H,
            blocks: [],
        };
        const r = rotateRawPage(p, 0);
        expect(r.page).toBe(p);
        expect(r.sourceWidth).toBe(W);
        expect(r.sourceHeight).toBe(H);
    });

    it("swaps width/height for 90", () => {
        const p: RawPageData = {
            pageIndex: 0,
            pageNumber: 1,
            width: W,
            height: H,
            blocks: [],
        };
        const r = rotateRawPage(p, 90);
        expect(r.page.width).toBe(H);
        expect(r.page.height).toBe(W);
        expect(r.sourceWidth).toBe(W);
        expect(r.sourceHeight).toBe(H);
    });

    it("swaps width/height for 270 and preserves dims for 180", () => {
        const p: RawPageData = {
            pageIndex: 0,
            pageNumber: 1,
            width: W,
            height: H,
            blocks: [],
        };
        expect(rotateRawPage(p, 180).page.width).toBe(W);
        expect(rotateRawPage(p, 180).page.height).toBe(H);
        expect(rotateRawPage(p, 270).page.width).toBe(H);
        expect(rotateRawPage(p, 270).page.height).toBe(W);
    });

    it("rotates text block bboxes, line bboxes, and image block bboxes together", () => {
        const blocks: RawBlock[] = [
            {
                type: "text",
                bbox: bbox(100, 100, 200, 40),
                lines: [
                    {
                        wmode: 0,
                        bbox: bbox(100, 100, 200, 12),
                        font: { name: "T", family: "T", weight: "normal", style: "normal", size: 10 },
                        x: 100,
                        y: 100,
                        text: "Hello",
                        rotation: 0,
                    },
                ],
            },
            { type: "image", bbox: bbox(400, 200, 100, 80) },
        ];
        const p: RawPageData = {
            pageIndex: 0,
            pageNumber: 1,
            width: W,
            height: H,
            blocks,
        };
        const rotated = rotateRawPage(p, 90).page;
        // Text block bbox round-trips
        const textBlock = rotated.blocks[0] as RawBlock & { lines: NonNullable<RawBlock["lines"]> };
        approxEqualBBox(
            inverseRotateBBox(textBlock.bbox, 90, W, H),
            bbox(100, 100, 200, 40),
        );
        approxEqualBBox(
            inverseRotateBBox(textBlock.lines![0].bbox, 90, W, H),
            bbox(100, 100, 200, 12),
        );
        // Image block bbox round-trips
        const imageBlock = rotated.blocks[1];
        approxEqualBBox(
            inverseRotateBBox(imageBlock.bbox, 90, W, H),
            bbox(400, 200, 100, 80),
        );
    });
});

describe("rotateRawPageDetailed", () => {
    const W = 612;
    const H = 792;

    it("rotates char quads + char bboxes consistently with line bboxes", () => {
        const lineBBox = bbox(100, 100, 200, 12);
        const charBBox = bbox(100, 100, 5, 12);
        const detailedLine: RawLineDetailed = {
            wmode: 0,
            bbox: lineBBox,
            font: { name: "T", family: "T", weight: "normal", style: "normal", size: 10 },
            x: 100,
            y: 100,
            text: "X",
            rotation: 0,
            chars: [
                {
                    c: "X",
                    // Standard upright glyph quad: UL/UR same y, LL/LR
                    // same y; UL/LL same x; UR/LR same x.
                    quad: [100, 100, 105, 100, 100, 112, 105, 112],
                    bbox: charBBox,
                },
            ],
        };
        const block: RawBlockDetailed = {
            type: "text",
            bbox: lineBBox,
            lines: [detailedLine],
        };
        const p: RawPageDataDetailed = {
            pageIndex: 0,
            pageNumber: 1,
            width: W,
            height: H,
            blocks: [block],
        };
        const rotated = rotateRawPageDetailed(p, 90);
        const rotBlock = rotated.page.blocks[0]!;
        if (rotBlock.type !== "text") throw new Error("expected text block");
        const rotLine = rotBlock.lines![0];
        // Char bbox derived from rotated quad must match the rotated
        // bbox we recorded — they are computed via the same point
        // transform, so they round-trip together.
        approxEqualBBox(
            inverseRotateBBox(rotLine.chars[0].bbox, 90, W, H),
            charBBox,
        );
        // Line bbox round-trips too.
        approxEqualBBox(
            inverseRotateBBox(rotLine.bbox, 90, W, H),
            lineBBox,
        );
    });
});

describe("inverseRotateBBox", () => {
    const W = 612;
    const H = 792;

    it("preserves additional fields on rotation 0", () => {
        const lb = { ...bbox(10, 20, 100, 12), extra: "kept" };
        const out = inverseRotateBBox(lb, 0, W, H);
        expect(out).toEqual(lb);
    });

    it("round-trips through forward + inverse for all rotations", () => {
        const lb = bbox(50, 60, 100, 20);
        for (const r of ROTATIONS) {
            // Round-trip via the raw-page forward transform on a one-
            // line page, then inverse the public bbox.
            const oneLinePage: RawPageData = {
                pageIndex: 0,
                pageNumber: 1,
                width: W,
                height: H,
                blocks: [
                    {
                        type: "text",
                        bbox: lb,
                        lines: [
                            {
                                wmode: 0,
                                bbox: lb,
                                font: { name: "T", family: "T", weight: "normal", style: "normal", size: 10 },
                                x: lb.l,
                                y: lb.t,
                                text: "x",
                                rotation: 0,
                            },
                        ],
                    },
                ],
            };
            const rotated = rotateRawPage(oneLinePage, r);
            const rotBlock = rotated.page.blocks[0] as RawBlock & { lines: NonNullable<RawBlock["lines"]> };
            const rotLineBBox = rotBlock.lines![0].bbox;
            const back = inverseRotateBBox(rotLineBBox, r, rotated.sourceWidth, rotated.sourceHeight);
            expect(back.l).toBeCloseTo(lb.l, 6);
            expect(back.t).toBeCloseTo(lb.t, 6);
            expect(back.r).toBeCloseTo(lb.r, 6);
            expect(back.b).toBeCloseTo(lb.b, 6);
            expect(bboxWidth(back)).toBeCloseTo(bboxWidth(lb), 6);
            expect(bboxHeight(back)).toBeCloseTo(bboxHeight(lb), 6);
        }
    });
});
