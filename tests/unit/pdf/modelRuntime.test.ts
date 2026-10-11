import { describe, expect, it } from "vitest";

import {
    assertModelFeatures,
    binaryProbability,
    binaryScore,
    decodeBase64,
    modelProbabilities,
    modelScores,
    treeValue,
    type LogisticModel,
    type PackedTreeModel,
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

describe("model runtime: bxm-trees-packed-v1", () => {
    const b64 = (a: Uint8Array | Int16Array | Float64Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
    const MAX = Number.MAX_VALUE;
    // Two depth-2 trees in both formats. Tree 0's right child is a leaf above
    // full depth, padded in the packed form (feature 0, its value copied to
    // both leaves below). Tree 1 splits on the largest finite double, as the
    // export writes a +Infinity threshold, and pads its left child.
    const v1: TreeModel = {
        format: "bxm-trees-v1",
        features: ["a", "b"],
        classes: ["x", "y", "z"],
        baseline: [0.125, -0.5, 0],
        trees: [
            { score: 0, feature: [0, 1, -1, -1, -1], threshold: [0.5, -1, 0, 0, 0], left: [1, 3, 0, 0, 0], right: [2, 4, 0, 0, 0], value: [0, 0, 0.75, 1.5, -2.25], missing_left: [1, 0, 0, 0, 0] },
            { score: 2, feature: [1, -1, 0, -1, -1], threshold: [2, 0, MAX, 0, 0], left: [1, 0, 3, 0, 0], right: [2, 0, 4, 0, 0], value: [0, 0.1, 0, -0.5, 3], missing_left: [0, 0, 1, 0, 0] },
        ],
    };
    const packed: PackedTreeModel = {
        format: "bxm-trees-packed-v1",
        features: v1.features,
        classes: v1.classes,
        baseline: v1.baseline,
        depth: 2,
        trees: 2,
        score: b64(new Uint8Array([0, 2])),
        feature: b64(new Int16Array([0, 1, 0, 1, 0, 0])),
        threshold: b64(new Float64Array([0.5, -1, 0, 2, 0, MAX])),
        missingLeft: b64(new Uint8Array([1, 0, 0, 0, 0, 1])),
        value: b64(new Float64Array([1.5, -2.25, 0.75, 0.75, 0.1, 0.1, -0.5, 3])),
    };
    const values = [NaN, -Infinity, Infinity, -MAX, MAX, -1, -0.5, 0, 0.5, 0.75, 2, 3];
    const inputs = values.flatMap((a) => values.map((b) => [a, b]));

    it("gives bit-identical scores to the bxm-trees-v1 form of the same trees", () => {
        for (const x of inputs) expect(modelScores(packed, x), `x = ${x}`).toEqual(modelScores(v1, x));
        // Every leaf of both trees is reached (tree 0 adds to score 0, tree 1 to score 2).
        expect(new Set(inputs.map((x) => modelScores(v1, x)[0])).size).toBe(3);
        expect(new Set(inputs.map((x) => modelScores(v1, x)[2])).size).toBe(3);
    });

    it("routes NaN by missingLeft, and ±Infinity like any number", () => {
        expect(modelScores(packed, [NaN, -Infinity])).toEqual([0.125 + 1.5, -0.5, 0.1]);
        expect(modelScores(packed, [Infinity, Infinity])).toEqual([0.125 + 0.75, -0.5, 3]);
        expect(modelScores(packed, [NaN, NaN])).toEqual([0.125 - 2.25, -0.5, -0.5]);
    });

    it("gives the binary score and probabilities of the same trees", () => {
        const binary = (m: TreeModel | PackedTreeModel) => ({ ...m, classes: [0, 1], baseline: [0.125] });
        const oneScore = (m: TreeModel | PackedTreeModel) =>
            m.format === "bxm-trees-v1"
                ? { ...binary(m), trees: m.trees.map((t) => ({ ...t, score: 0 })) }
                : { ...binary(m), score: b64(new Uint8Array([0, 0])) };
        const [a, b] = [oneScore(v1), oneScore(packed)];
        for (const x of inputs) {
            expect(binaryScore(b, x)).toBe(binaryScore(a, x));
            expect(binaryProbability(b, x)).toBe(binaryProbability(a, x));
            expect(modelProbabilities(b, x)).toEqual(modelProbabilities(a, x));
        }
    });

    it("rejects arrays of the wrong length and out-of-range indices", () => {
        expect(() => modelScores({ ...packed, value: b64(new Float64Array(7)) }, [0, 0])).toThrow(/value has 56 bytes, expected 64/);
        expect(() => modelScores({ ...packed, score: b64(new Uint8Array([0, 3])) }, [0, 0])).toThrow(/score 3 out of range/);
        expect(() => modelScores({ ...packed, feature: b64(new Int16Array([0, 2, 0, 1, 0, 0])) }, [0, 0])).toThrow(/feature 2 out of range/);
    });

    it("decodes base64 with and without padding", () => {
        for (let n = 0; n < 40; n++) {
            const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n * 31) & 0xff);
            const text = Buffer.from(bytes).toString("base64");
            expect(decodeBase64(text)).toEqual(bytes);
            expect(decodeBase64(text.replace(/=+$/, ""))).toEqual(bytes);
        }
        expect(() => decodeBase64("AA-A")).toThrow(/character/);
        expect(() => decodeBase64("AAAAA")).toThrow(/length/);
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
