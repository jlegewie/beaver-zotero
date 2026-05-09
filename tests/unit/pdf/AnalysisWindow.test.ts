import { describe, it, expect } from "vitest";
import { resolveAnalysisPages } from "../../../src/services/pdf/AnalysisWindow";

describe("resolveAnalysisPages", () => {
    describe("N=0: targets only", () => {
        it("returns the single target unchanged", () => {
            expect(
                resolveAnalysisPages({
                    targetPageIndices: [3],
                    totalPageCount: 10,
                    analysisWindow: 0,
                }),
            ).toEqual([3]);
        });

        it("returns multiple targets sorted ascending, deduplicated", () => {
            expect(
                resolveAnalysisPages({
                    targetPageIndices: [5, 1, 3, 1],
                    totalPageCount: 10,
                    analysisWindow: 0,
                }),
            ).toEqual([1, 3, 5]);
        });

        it("defaults analysisWindow to 0 when omitted", () => {
            expect(
                resolveAnalysisPages({
                    targetPageIndices: [3],
                    totalPageCount: 10,
                }),
            ).toEqual([3]);
        });
    });

    describe("N>0: window expansion", () => {
        it("expands ±N around a single target", () => {
            expect(
                resolveAnalysisPages({
                    targetPageIndices: [10],
                    totalPageCount: 100,
                    analysisWindow: 3,
                }),
            ).toEqual([7, 8, 9, 10, 11, 12, 13]);
        });

        it("clips at document start", () => {
            expect(
                resolveAnalysisPages({
                    targetPageIndices: [1],
                    totalPageCount: 100,
                    analysisWindow: 5,
                }),
            ).toEqual([0, 1, 2, 3, 4, 5, 6]);
        });

        it("clips at document end", () => {
            expect(
                resolveAnalysisPages({
                    targetPageIndices: [98],
                    totalPageCount: 100,
                    analysisWindow: 5,
                }),
            ).toEqual([93, 94, 95, 96, 97, 98, 99]);
        });

        it("merges overlapping per-target windows for clustered targets", () => {
            expect(
                resolveAnalysisPages({
                    targetPageIndices: [10, 12],
                    totalPageCount: 100,
                    analysisWindow: 2,
                }),
            ).toEqual([8, 9, 10, 11, 12, 13, 14]);
        });

        it("produces a sparse union for scattered targets", () => {
            expect(
                resolveAnalysisPages({
                    targetPageIndices: [10, 50],
                    totalPageCount: 100,
                    analysisWindow: 1,
                }),
            ).toEqual([9, 10, 11, 49, 50, 51]);
        });
    });

    describe("N=Infinity: whole document", () => {
        it("returns every page", () => {
            expect(
                resolveAnalysisPages({
                    targetPageIndices: [2],
                    totalPageCount: 5,
                    analysisWindow: Infinity,
                }),
            ).toEqual([0, 1, 2, 3, 4]);
        });

        it("returns every page when targets span the doc", () => {
            expect(
                resolveAnalysisPages({
                    targetPageIndices: [0, 4],
                    totalPageCount: 5,
                    analysisWindow: Infinity,
                }),
            ).toEqual([0, 1, 2, 3, 4]);
        });
    });

    describe("invalid analysisWindow throws", () => {
        it("rejects fractional window", () => {
            expect(() =>
                resolveAnalysisPages({
                    targetPageIndices: [3],
                    totalPageCount: 10,
                    analysisWindow: 1.5,
                }),
            ).toThrow(/analysisWindow/);
        });

        it("rejects negative window", () => {
            expect(() =>
                resolveAnalysisPages({
                    targetPageIndices: [3],
                    totalPageCount: 10,
                    analysisWindow: -1,
                }),
            ).toThrow(/analysisWindow/);
        });

        it("rejects NaN window", () => {
            expect(() =>
                resolveAnalysisPages({
                    targetPageIndices: [3],
                    totalPageCount: 10,
                    analysisWindow: NaN,
                }),
            ).toThrow(/analysisWindow/);
        });
    });

    describe("invalid targets throw", () => {
        it("throws on negative target", () => {
            expect(() =>
                resolveAnalysisPages({
                    targetPageIndices: [-1],
                    totalPageCount: 10,
                }),
            ).toThrow(/out of range/);
        });

        it("throws on target equal to pageCount", () => {
            expect(() =>
                resolveAnalysisPages({
                    targetPageIndices: [10],
                    totalPageCount: 10,
                }),
            ).toThrow(/out of range/);
        });

        it("throws on fractional target", () => {
            expect(() =>
                resolveAnalysisPages({
                    targetPageIndices: [1.5],
                    totalPageCount: 10,
                }),
            ).toThrow(/out of range/);
        });

        it("throws on empty target array", () => {
            expect(() =>
                resolveAnalysisPages({
                    targetPageIndices: [],
                    totalPageCount: 10,
                }),
            ).toThrow(/non-empty/);
        });

        it("throws when pageCount is zero", () => {
            expect(() =>
                resolveAnalysisPages({
                    targetPageIndices: [0],
                    totalPageCount: 0,
                }),
            ).toThrow(/totalPageCount/);
        });

        it("throws when pageCount is negative", () => {
            expect(() =>
                resolveAnalysisPages({
                    targetPageIndices: [0],
                    totalPageCount: -1,
                }),
            ).toThrow(/totalPageCount/);
        });

        it("throws when pageCount is non-integer", () => {
            expect(() =>
                resolveAnalysisPages({
                    targetPageIndices: [0],
                    totalPageCount: 5.5,
                }),
            ).toThrow(/totalPageCount/);
        });
    });

    describe("output shape", () => {
        it("returns indices sorted ascending", () => {
            const out = resolveAnalysisPages({
                targetPageIndices: [50],
                totalPageCount: 200,
                analysisWindow: 10,
            });
            for (let i = 1; i < out.length; i++) {
                expect(out[i]).toBeGreaterThan(out[i - 1]);
            }
        });

        it("never returns indices below 0 or >= pageCount", () => {
            const out = resolveAnalysisPages({
                targetPageIndices: [0],
                totalPageCount: 5,
                analysisWindow: 10,
            });
            expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
            expect(Math.max(...out)).toBeLessThan(5);
        });

        it("applies no hidden cap — wide windows pass through", () => {
            const out = resolveAnalysisPages({
                targetPageIndices: [500],
                totalPageCount: 1000,
                analysisWindow: 100,
            });
            // 100 + 100 + 1 = 201 pages — callers control cost via N.
            expect(out.length).toBe(201);
        });
    });
});
