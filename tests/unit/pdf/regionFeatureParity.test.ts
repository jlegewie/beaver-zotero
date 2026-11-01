import { describe, expect, it } from "vitest";

import { detectRegions } from "../../../src/beaver-extract/node/api";
import { REGION_FEATURES, REGION_FEATURE_VERSION } from "../../../src/beaver-extract/regions/features";
import { syntheticFigurePdf } from "../../helpers/syntheticRegionPdf";

const round = (v: number) => Math.round(v * 1000) / 1000;

// Pins the feature implementation: the shipped weights were trained on these
// exact feature semantics. A change here needs a REGION_FEATURE_VERSION bump,
// a feature re-export and retraining in the research repo.
describe("region features on a synthetic page", () => {
    it("finds the chart and the photo and pins their features", async () => {
        const result = await detectRegions({ pdfData: syntheticFigurePdf(), pageIndices: [0] });
        const page = result.pages[0];
        expect(page.error).toBeUndefined();
        expect(page.scanned).toBe(false);

        const pictures = page.candidates.filter((c) => c.label === "picture");
        expect(pictures).toHaveLength(2);

        const named = page.candidates.map((c) => ({
            bbox: c.bbox.map(Math.round),
            label: c.label,
            features: Object.fromEntries(REGION_FEATURES.map((f, i) => [f, round(c.features[i])])),
        }));
        expect({ featureVersion: REGION_FEATURE_VERSION, candidates: named }).toMatchSnapshot();
    });
});
