/**
 * Runtime of every learned model in Beaver Extract: one evaluator for
 * gradient-boosted trees and one for logistic regression, binary and
 * multiclass.
 *
 * Trees use the portable export format `bxm-trees-v1` of the training repo
 * (`beaver_models/models/trees.py`), evaluated exactly as its `decision()`
 * does:
 *
 * - Node k is a leaf when `feature[k] < 0`. Otherwise a sample goes left when
 *   `x[feature] <= threshold`, or, when x is NaN, when `missing_left[k]` is 1.
 * - Each tree adds its leaf value to score `tree.score`, starting from
 *   `baseline`.
 * - Two classes give one score, the logit of `classes[1]` (sigmoid); more
 *   classes give one score per class (softmax).
 *
 * Logistic models (`bxm-logistic-v1`) standardize the input
 * (`(x - mean) / scale`) and give one score per row of `coef`, with the same
 * class convention. NaN inputs propagate.
 *
 * A model's weights live in a generated `weights.ts` next to the model that
 * uses them: the export object plus the feature-set version it was trained
 * on (`ModelInfo`).
 */

export const TREES_FORMAT = "bxm-trees-v1";
export const LOGISTIC_FORMAT = "bxm-logistic-v1";

/** One tree as flat node arrays. */
export interface Tree {
    /** Score (class) the tree adds to. */
    score: number;
    feature: readonly number[];
    threshold: readonly number[];
    left: readonly number[];
    right: readonly number[];
    value: readonly number[];
    /** 1 where NaN goes left. Omitted: NaN goes right everywhere. */
    missing_left?: readonly number[];
}

/** Class labels of a model, as the training code names them. */
export type ClassLabel = string | number;

export interface TreeModel<C extends ClassLabel = ClassLabel> {
    format: typeof TREES_FORMAT;
    /** Input column names, in order. */
    features: readonly string[];
    classes: readonly C[];
    /** One per score. */
    baseline: readonly number[];
    trees: readonly Tree[];
}

export interface LogisticModel<C extends ClassLabel = ClassLabel> {
    format: typeof LOGISTIC_FORMAT;
    features: readonly string[];
    classes: readonly C[];
    /** Standardization: x' = (x - mean) / scale. */
    mean: readonly number[];
    scale: readonly number[];
    /** One row per score. */
    coef: readonly (readonly number[])[];
    intercept: readonly number[];
}

export type Model<C extends ClassLabel = ClassLabel> = TreeModel<C> | LogisticModel<C>;

/** What a weights module adds to a model export. */
export interface ModelInfo {
    /** Version of the feature set the model was trained on. */
    featureVersion: number;
    /** Provenance, for humans. */
    trainedOn: string;
}

export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** Leaf value of `tree` for the input `x`. */
export function treeValue(tree: Tree, x: readonly number[]): number {
    const { feature, threshold, left, right, value, missing_left: missingLeft } = tree;
    let k = 0;
    for (;;) {
        const f = feature[k];
        if (f < 0) return value[k];
        const v = x[f];
        // NaN fails every comparison; route it explicitly.
        const goLeft = v !== v ? missingLeft?.[k] === 1 : v <= threshold[k];
        k = goLeft ? left[k] : right[k];
    }
}

function treeScores(model: TreeModel, x: readonly number[]): number[] {
    const scores = model.baseline.slice();
    for (const tree of model.trees) scores[tree.score] += treeValue(tree, x);
    return scores;
}

function logisticScores(model: LogisticModel, x: readonly number[]): number[] {
    return model.coef.map((row, k) => {
        let z = model.intercept[k];
        for (let j = 0; j < row.length; j++) z += row[j] * ((x[j] - model.mean[j]) / model.scale[j]);
        return z;
    });
}

/**
 * The single score (logit of `classes[1]`) of a binary model, without the
 * per-row allocations of `modelScores`; the same arithmetic in the same order.
 */
export function binaryScore(model: Model, x: readonly number[]): number {
    if (model.format === TREES_FORMAT) {
        let z = model.baseline[0];
        for (const tree of model.trees) z += treeValue(tree, x);
        return z;
    }
    const row = model.coef[0];
    let z = model.intercept[0];
    for (let j = 0; j < row.length; j++) z += row[j] * ((x[j] - model.mean[j]) / model.scale[j]);
    return z;
}

/** Raw scores (logits) of one input row: one for binary models, one per class otherwise. */
export function modelScores(model: Model, x: readonly number[]): number[] {
    return model.format === TREES_FORMAT ? treeScores(model, x) : logisticScores(model, x);
}

/** Probability of `classes[1]` under a binary model. */
export function binaryProbability(model: Model, x: readonly number[]): number {
    return sigmoid(binaryScore(model, x));
}

/** Class probabilities of one input row, in `model.classes` order. */
export function modelProbabilities(model: Model, x: readonly number[]): number[] {
    const scores = modelScores(model, x);
    if (scores.length === 1) {
        const p = sigmoid(scores[0]);
        return [1 - p, p];
    }
    const max = Math.max(...scores);
    const exps = scores.map((z) => Math.exp(z - max));
    const total = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / total);
}

/**
 * Throws unless the model was trained on exactly this feature set (version
 * and column names in order).
 */
export function assertModelFeatures(
    model: Model & Pick<ModelInfo, "featureVersion">,
    featureVersion: number,
    features: readonly string[],
    label: string,
): void {
    if (
        model.featureVersion !== featureVersion ||
        model.features.length !== features.length ||
        model.features.some((f, i) => f !== features[i])
    ) {
        throw new Error(
            `${label} model was trained on feature version ${model.featureVersion}; the runtime computes ${featureVersion}`,
        );
    }
}
