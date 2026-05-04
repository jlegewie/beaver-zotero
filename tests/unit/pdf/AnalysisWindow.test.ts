import { describe, it, expect } from "vitest";
import {
    resolveAnalysisPageIndices,
    DEFAULT_ANALYSIS_WINDOW_CAP,
} from "../../../src/services/pdf/AnalysisWindow";

describe("resolveAnalysisPageIndices", () => {
    describe("whole-document default", () => {
        it("returns every page when analysisPageWindow is undefined", () => {
            expect(resolveAnalysisPageIndices(2, 5)).toEqual([0, 1, 2, 3, 4]);
        });

        it("returns every page when analysisPageWindow is 0", () => {
            expect(resolveAnalysisPageIndices(2, 5, 0)).toEqual([0, 1, 2, 3, 4]);
        });

        it("always includes pageIndex on a single-page doc", () => {
            expect(resolveAnalysisPageIndices(0, 1)).toEqual([0]);
        });
    });

    describe("±N window", () => {
        it("returns ±N pages around pageIndex when N is positive", () => {
            expect(resolveAnalysisPageIndices(10, 100, 3)).toEqual([
                7, 8, 9, 10, 11, 12, 13,
            ]);
        });

        it("clips at document start", () => {
            expect(resolveAnalysisPageIndices(1, 100, 5)).toEqual([
                0, 1, 2, 3, 4, 5, 6,
            ]);
        });

        it("clips at document end", () => {
            expect(resolveAnalysisPageIndices(98, 100, 5)).toEqual([
                93, 94, 95, 96, 97, 98, 99,
            ]);
        });

        it("always includes pageIndex even at extreme bounds", () => {
            expect(resolveAnalysisPageIndices(0, 100, 5)).toContain(0);
            expect(resolveAnalysisPageIndices(99, 100, 5)).toContain(99);
        });
    });

    describe("cap enforcement", () => {
        it("caps the whole-document default at DEFAULT_ANALYSIS_WINDOW_CAP", () => {
            const out = resolveAnalysisPageIndices(500, 1000);
            expect(out.length).toBe(DEFAULT_ANALYSIS_WINDOW_CAP);
            expect(out).toContain(500);
        });

        it("caps a wide ±N window", () => {
            const out = resolveAnalysisPageIndices(500, 1000, 100);
            expect(out.length).toBe(DEFAULT_ANALYSIS_WINDOW_CAP);
            expect(out).toContain(500);
        });

        it("centers the cap on pageIndex when there's room on both sides", () => {
            const out = resolveAnalysisPageIndices(500, 1000, 100);
            expect(out[0]).toBe(500 - Math.floor(DEFAULT_ANALYSIS_WINDOW_CAP / 2));
            expect(out[out.length - 1]).toBe(out[0] + DEFAULT_ANALYSIS_WINDOW_CAP - 1);
        });

        it("shifts the cap right when pageIndex is near document start", () => {
            const out = resolveAnalysisPageIndices(5, 1000);
            expect(out[0]).toBe(0);
            expect(out.length).toBe(DEFAULT_ANALYSIS_WINDOW_CAP);
            expect(out).toContain(5);
        });

        it("shifts the cap left when pageIndex is near document end", () => {
            const out = resolveAnalysisPageIndices(995, 1000);
            expect(out[out.length - 1]).toBe(999);
            expect(out.length).toBe(DEFAULT_ANALYSIS_WINDOW_CAP);
            expect(out).toContain(995);
        });

        it("respects a custom cap", () => {
            const out = resolveAnalysisPageIndices(500, 1000, undefined, 10);
            expect(out.length).toBe(10);
            expect(out).toContain(500);
        });
    });

    describe("invalid input throws", () => {
        it("throws when pageIndex is negative", () => {
            expect(() => resolveAnalysisPageIndices(-1, 10)).toThrow(/out of range/);
        });

        it("throws when pageIndex equals pageCount", () => {
            expect(() => resolveAnalysisPageIndices(10, 10)).toThrow(/out of range/);
        });

        it("throws when pageIndex exceeds pageCount", () => {
            expect(() => resolveAnalysisPageIndices(99999, 10)).toThrow(/out of range/);
        });

        it("throws when pageIndex is non-integer", () => {
            expect(() => resolveAnalysisPageIndices(1.5, 10)).toThrow(/out of range/);
        });

        it("throws when pageCount is zero", () => {
            expect(() => resolveAnalysisPageIndices(0, 0)).toThrow(/pageCount/);
        });

        it("throws when pageCount is negative", () => {
            expect(() => resolveAnalysisPageIndices(0, -1)).toThrow(/pageCount/);
        });

        it("throws when pageCount is non-integer", () => {
            expect(() => resolveAnalysisPageIndices(0, 5.5)).toThrow(/pageCount/);
        });
    });

    describe("output shape", () => {
        it("returns indices in ascending order", () => {
            const out = resolveAnalysisPageIndices(50, 200, 10);
            for (let i = 1; i < out.length; i++) {
                expect(out[i]).toBeGreaterThan(out[i - 1]);
            }
        });

        it("never returns indices below 0 or >= pageCount", () => {
            const out = resolveAnalysisPageIndices(0, 5, 10);
            expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
            expect(Math.max(...out)).toBeLessThan(5);
        });
    });
});
