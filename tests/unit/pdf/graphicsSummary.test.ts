import { describe, expect, it } from "vitest";
import {
    GRAPHICS_SUMMARY_HEADER,
    GRAPHICS_SUMMARY_STRIDE,
    GS_FLAG,
    GS_KIND,
    graphicsRecord,
    parseGraphicsSummary,
} from "../../../src/beaver-extract/worker/graphicsSummary";

function summaryBytes(records: number[][], opts: { overflow?: boolean; version?: number } = {}): Uint8Array {
    const grid = opts.overflow ? new Array(32 * 32).fill(0).map((_, i) => (i === 5 ? 7 : 0)) : [];
    const header = new Array(GRAPHICS_SUMMARY_HEADER).fill(0);
    header[0] = opts.version ?? 1;
    header[1] = records.length;
    header[2] = GRAPHICS_SUMMARY_STRIDE;
    header[3] = 3; // fill paths seen
    header[5] = 1; // images seen
    header[8] = opts.overflow ? 1 : 0;
    header[9] = opts.overflow ? 32 : 0;
    header.splice(10, 4, 0, 0, 612, 792);
    return new Uint8Array(new Float32Array([...header, ...records.flat(), ...grid]).buffer);
}

const fillRect = [GS_KIND.fillPath, 10, 20, 110, 70, GS_FLAG.isRect, 0xff8000, 255, 5, 0, 0, 0];
const image = [GS_KIND.image, 50, 100, 350, 400, GS_FLAG.clipped, 0, 128, 0, 640, 480, 0xabcdef];

describe("parseGraphicsSummary", () => {
    it("decodes the header, records and page area", () => {
        const summary = parseGraphicsSummary(summaryBytes([fillRect, image]));
        expect(summary.count).toBe(2);
        expect(summary.area).toEqual([0, 0, 612, 792]);
        expect(summary.seen).toEqual({ fillPath: 3, strokePath: 0, image: 1, imageMask: 0, shade: 0 });
        expect(summary.overflow).toBe(false);
        expect(summary.grid).toBeNull();
        expect(graphicsRecord(summary, 0)).toMatchObject({
            kind: GS_KIND.fillPath,
            bbox: [10, 20, 110, 70],
            flags: GS_FLAG.isRect,
            rgb: 0xff8000,
            segments: 5,
        });
        expect(graphicsRecord(summary, 1)).toMatchObject({
            kind: GS_KIND.image,
            widthOrStroke: 640,
            imageHeight: 480,
            imageHash: 0xabcdef,
        });
    });

    it("exposes the overflow grid when the record cap was reached", () => {
        const summary = parseGraphicsSummary(summaryBytes([fillRect], { overflow: true }));
        expect(summary.overflow).toBe(true);
        expect(summary.gridSize).toBe(32);
        expect(summary.grid?.[5]).toBe(7);
    });

    it("copies the bytes so the source buffer can be freed", () => {
        const bytes = summaryBytes([fillRect]);
        const summary = parseGraphicsSummary(bytes);
        bytes.fill(0);
        expect(graphicsRecord(summary, 0).bbox).toEqual([10, 20, 110, 70]);
    });

    it("rejects unknown versions and malformed buffers", () => {
        expect(() => parseGraphicsSummary(summaryBytes([fillRect], { version: 2 }))).toThrow(/version/);
        expect(() => parseGraphicsSummary(summaryBytes([fillRect]).subarray(0, 70))).toThrow(/length/);
        const truncated = summaryBytes([fillRect, image]);
        expect(() => parseGraphicsSummary(truncated.subarray(0, truncated.length - 4))).toThrow(/expected/);
    });
});
