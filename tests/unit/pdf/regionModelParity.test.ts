import { describe, expect, it } from "vitest";

import { assertCompatible, predictRegionClass } from "../../../src/beaver-extract/regions/model";
import { REGION_MODEL } from "../../../src/beaver-extract/regions/weights";
import parity from "./fixtures/regionModelParity.json";

// The fixture is written together with `weights.ts` by the research repo's
// `train_detector.py --write-parity`: sample feature vectors with the
// probabilities the training code computed for them.
describe("shipped region model", () => {
    it("matches the feature set the detector computes", () => {
        expect(REGION_MODEL).not.toBeNull();
        expect(() => assertCompatible(REGION_MODEL!)).not.toThrow();
        expect(parity.trainedOn).toBe(REGION_MODEL!.trainedOn);
    });

    it("reproduces the training code's probabilities", () => {
        for (const c of parity.cases) {
            const probs = predictRegionClass(REGION_MODEL!, c.features);
            parity.classes.forEach((cls, k) => {
                expect(probs[cls as keyof typeof probs]).toBeCloseTo(c.probs[k], 6);
            });
        }
    });
});
