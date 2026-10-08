import { describe, expect, it } from "vitest";

import {
    assertModelFeatures,
    binaryProbability,
    binaryScore,
    modelProbabilities,
    modelScores,
    treeValue,
    type LogisticModel,
    type TreeModel,
} from "../../../src/beaver-extract/models/runtime";
import { expectModelParity, type ModelParityFixture } from "../../helpers/modelParity";
import parity from "./fixtures/bxmTreesParity.json";

// Written by the training repo's own code (`fit_hgb`, `export_hgb` and
// `parity_fixture` in beaver_models/models/trees.py) on synthetic data with
// missing values, so NaN routing is covered.
const fixtures = parity as unknown as Record<"binary" | "multiclass", { model: TreeModel; parity: ModelParityFixture }>;

describe("model runtime: bxm-trees-v1", () => {
    it("reproduces the training code's binary probabilities", () => {
        expectModelParity(fixtures.binary.model, fixtures.binary.parity);
        const { model, parity } = fixtures.binary;
        for (const row of parity.inputs) {
            const x = row.map((v) => (v === null ? NaN : v));
            expect(binaryScore(model, x)).toBe(modelScores(model, x)[0]);
        }
    });

    it("reproduces the training code's multiclass probabilities", () => {
        expectModelParity(fixtures.multiclass.model, fixtures.multiclass.parity);
    });

    it("routes NaN by missing_left, and right when it is omitted", () => {
        const stump = { score: 0, feature: [0, -1, -1], threshold: [0.5, 0, 0], left: [1, 0, 0], right: [2, 0, 0], value: [0, -1, 1] };
        expect(treeValue({ ...stump, missing_left: [1, 0, 0] }, [NaN])).toBe(-1);
        expect(treeValue({ ...stump, missing_left: [0, 0, 0] }, [NaN])).toBe(1);
        expect(treeValue(stump, [NaN])).toBe(1);
        expect(treeValue(stump, [0.5])).toBe(-1);
    });
});

describe("model runtime: bxm-logistic-v1", () => {
    const logistic: LogisticModel = {
        format: "bxm-logistic-v1",
        features: ["a", "b"],
        classes: [0, 1],
        mean: [1, 0],
        scale: [2, 1],
        coef: [[2, -1]],
        intercept: [0.5],
    };

    it("standardizes inputs and gives one logit for two classes", () => {
        expect(modelScores(logistic, [3, 1])).toEqual([0.5 + 2 * 1 - 1]);
        expect(binaryScore(logistic, [3, 1])).toBe(modelScores(logistic, [3, 1])[0]);
        const p = binaryProbability(logistic, [3, 1]);
        expect(p).toBeCloseTo(1 / (1 + Math.exp(-1.5)), 12);
        expect(modelProbabilities(logistic, [3, 1])).toEqual([1 - p, p]);
    });

    it("gives softmax probabilities for more classes", () => {
        const multi: LogisticModel = { ...logistic, classes: ["x", "y", "z"], coef: [[0, 0], [1, 0], [0, 0]], intercept: [0, 0, 0] };
        const probs = modelProbabilities(multi, [3, 0]);
        expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
        expect(probs[1]).toBeCloseTo(Math.E / (Math.E + 2), 12);
    });

    it("rejects a model trained on another feature set", () => {
        const versioned = { ...logistic, featureVersion: 3 };
        expect(() => assertModelFeatures(versioned, 3, ["a", "b"], "test")).not.toThrow();
        expect(() => assertModelFeatures(versioned, 4, ["a", "b"], "test")).toThrow();
        expect(() => assertModelFeatures(versioned, 3, ["b", "a"], "test")).toThrow();
    });
});
