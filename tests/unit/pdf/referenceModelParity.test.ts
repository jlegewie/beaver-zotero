import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CONTEXT_FEATURES, FEATURE_VERSION, ITEM_FEATURES } from "../../../src/beaver-extract/references/features";
import { LINE_FEATURES, LINE_FEATURE_VERSION } from "../../../src/beaver-extract/references/lines";
import {
    lineStartProbability,
    stage1Logit,
    stage2Features,
    stage2Logit,
} from "../../../src/beaver-extract/references/model";
import { REFERENCE_MODEL } from "../../../src/beaver-extract/references/weights";

/**
 * Feature rows (numbers only) and the probabilities the research pipeline's
 * Python implementation computed for them with the shipped weights.
 */
interface ParityFixture {
    model: string;
    docs: Array<{ pageOf: number[]; x1: number[][]; probs: number[] }>;
    lines: { x: number[][]; probs: number[] };
}

const fixture = JSON.parse(
    readFileSync(join(__dirname, "fixtures/referenceModelParity.json"), "utf8"),
) as ParityFixture;

describe("reference model parity with the training pipeline", () => {
    it("ships weights for the current feature layout", () => {
        expect(REFERENCE_MODEL.featureVersion).toBe(FEATURE_VERSION);
        expect(REFERENCE_MODEL.features).toEqual([...ITEM_FEATURES, ...CONTEXT_FEATURES]);
        expect(REFERENCE_MODEL.lines.featureVersion).toBe(LINE_FEATURE_VERSION);
        expect(REFERENCE_MODEL.lines.features).toEqual([...LINE_FEATURES]);
    });

    it("reproduces item probabilities, including the stage-2 neighbour features", () => {
        for (const doc of fixture.docs) {
            const z = doc.x1.map((x) => stage1Logit(REFERENCE_MODEL, x));
            const x2 = stage2Features(z, doc.pageOf, doc.x1);
            x2.forEach((x, i) => {
                const p = 1 / (1 + Math.exp(-stage2Logit(REFERENCE_MODEL, x)));
                expect(p).toBeCloseTo(doc.probs[i], 9);
            });
        }
    });

    it("reproduces line entry-start probabilities", () => {
        fixture.lines.x.forEach((x, i) => {
            expect(lineStartProbability(REFERENCE_MODEL, x)).toBeCloseTo(fixture.lines.probs[i], 9);
        });
    });
});
