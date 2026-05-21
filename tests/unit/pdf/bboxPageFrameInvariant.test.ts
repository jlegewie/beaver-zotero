import { describe, expect, it } from "vitest";

import {
    loadExtractFixtures,
    publicRoot,
} from "../../helpers/extractFixtureLoader";
import type {
    Rect,
    StructuredPage,
} from "../../../src/beaver-extract/schema/schema";

function expectTopLeftInPage(
    bbox: Rect,
    page: StructuredPage,
    tolerance: number,
): void {
    expect(bbox[0]).toBeLessThanOrEqual(bbox[2] + tolerance);
    expect(bbox[1]).toBeLessThanOrEqual(bbox[3] + tolerance);
    expect(bbox[0]).toBeGreaterThanOrEqual(-tolerance);
    expect(bbox[1]).toBeGreaterThanOrEqual(-tolerance);
    expect(bbox[2]).toBeLessThanOrEqual(page.width + tolerance);
    expect(bbox[3]).toBeLessThanOrEqual(page.height + tolerance);
}

describe("bbox page-frame invariant", () => {
    it("keeps public extraction fixture bboxes in source MuPDF top-left page space", () => {
        const fixtures = loadExtractFixtures(publicRoot());
        expect(fixtures.length).toBeGreaterThan(0);

        for (const { fixture } of fixtures) {
            const tolerance = fixture.tolerance.bboxAbsPt;
            for (const page of fixture.expected.structured.pages) {
                for (const item of page.items) {
                    expectTopLeftInPage(item.bbox, page, tolerance);
                    if (!("sentences" in item) || !item.sentences) continue;
                    for (const sentence of item.sentences) {
                        for (const bbox of sentence.bboxes) {
                            expectTopLeftInPage(bbox, page, tolerance);
                        }
                    }
                }
            }
        }
    });
});
