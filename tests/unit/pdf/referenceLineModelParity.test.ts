import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LINE_FEATURES, LINE_FEATURE_VERSION, lineStartProbability } from "../../../src/beaver-extract/references/lines";
import { REFERENCE_LINE_MODEL } from "../../../src/beaver-extract/references/weights";

/**
 * Line-feature rows and the entry-start probabilities the research
 * pipeline's Python implementation computed for them with the shipped
 * weights.
 */
interface ParityFixture {
    model: string;
    lines: { x: number[][]; probs: number[] };
}

const fixture = JSON.parse(
    readFileSync(join(__dirname, "fixtures/referenceLineModelParity.json"), "utf8"),
) as ParityFixture;

describe("reference line model parity with the training pipeline", () => {
    it("ships weights for the current line features", () => {
        expect(REFERENCE_LINE_MODEL.model.featureVersion).toBe(LINE_FEATURE_VERSION);
        expect(REFERENCE_LINE_MODEL.model.features).toEqual([...LINE_FEATURES]);
    });

    it("reproduces line entry-start probabilities", () => {
        expect(fixture.lines.x.length).toBeGreaterThan(0);
        fixture.lines.x.forEach((x, i) => {
            expect(lineStartProbability(REFERENCE_LINE_MODEL, x)).toBeCloseTo(fixture.lines.probs[i], 9);
        });
    });
});
