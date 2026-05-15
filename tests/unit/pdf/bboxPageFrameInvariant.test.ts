import { describe, expect, it } from "vitest";

import {
    loadExtractFixtures,
    publicRoot,
} from "../../helpers/extractFixtureLoader";
import type {
    SnapshotBBox,
    ExtractionPageSnapshot,
} from "../../../src/beaver-extract/debug/extractionSnapshot";

function expectTopLeftInPage(
    bbox: SnapshotBBox,
    page: ExtractionPageSnapshot,
    tolerance: number,
): void {
    expect(bbox.origin).toBe("top-left");
    expect(bbox.l).toBeLessThanOrEqual(bbox.r + tolerance);
    expect(bbox.t).toBeLessThanOrEqual(bbox.b + tolerance);
    expect(bbox.l).toBeGreaterThanOrEqual(-tolerance);
    expect(bbox.t).toBeGreaterThanOrEqual(-tolerance);
    expect(bbox.r).toBeLessThanOrEqual(page.pageWidth + tolerance);
    expect(bbox.b).toBeLessThanOrEqual(page.pageHeight + tolerance);
}

describe("bbox page-frame invariant", () => {
    it("keeps public extraction fixture bboxes in source MuPDF top-left page space", () => {
        const fixtures = loadExtractFixtures(publicRoot());
        expect(fixtures.length).toBeGreaterThan(0);

        for (const { fixture } of fixtures) {
            const tolerance = fixture.tolerance.bboxAbsPt;
            for (const page of fixture.expected.perPage) {
                for (const item of page.items) {
                    expectTopLeftInPage(item.bbox, page, tolerance);
                }
                for (const sentence of page.sentences) {
                    for (const bbox of sentence.bboxes) {
                        expectTopLeftInPage(bbox, page, tolerance);
                    }
                }
            }
        }
    });
});
