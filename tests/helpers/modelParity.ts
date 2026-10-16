import { expect } from "vitest";

import { modelProbabilities, type Model } from "../../src/beaver-extract/models/runtime";

/**
 * A parity fixture as the training repo writes it (`parity_fixture()` in
 * `beaver_models/models/trees.py`): input rows (`null` for a missing value)
 * and the class probabilities the training code computed for them.
 */
export interface ModelParityFixture {
    format: string;
    classes: readonly (string | number)[];
    inputs: readonly (readonly (number | null)[])[];
    expected: readonly (readonly number[])[];
}

/** The runtime reproduces every probability of `fixture` with `model`. */
export function expectModelParity(model: Model, fixture: ModelParityFixture, digits = 9): void {
    expect(model.format).toBe(fixture.format);
    expect(model.classes).toEqual(fixture.classes);
    expect(fixture.inputs.length).toBeGreaterThan(0);
    fixture.inputs.forEach((row, i) => {
        const probs = modelProbabilities(model, row.map((v) => (v === null ? NaN : v)));
        expect(probs).toHaveLength(fixture.expected[i].length);
        probs.forEach((p, k) => expect(p).toBeCloseTo(fixture.expected[i][k], digits));
    });
}
