/**
 * Region classifier over `REGION_FEATURES`: either a multinomial logistic
 * regression or a small gradient-boosted tree ensemble. Weights are trained in
 * the research repo (`beaver-extract-research`, `scripts/regions/train_detector.py`)
 * and generated into `weights.ts`.
 */
import { REGION_FEATURES, REGION_FEATURE_VERSION } from "./features";

export type RegionClass = "other" | "picture" | "decoration" | "table";

interface RegionModelBase {
    featureVersion: number;
    features: readonly string[];
    classes: readonly RegionClass[];
    /** Provenance, for humans. */
    trainedOn: string;
}

export interface LogisticRegionModel extends RegionModelBase {
    kind: "logistic";
    /** Standardisation: x' = (x - mean) / scale. */
    mean: readonly number[];
    scale: readonly number[];
    /** One row per class. */
    coef: readonly (readonly number[])[];
    intercept: readonly number[];
}

/**
 * Gradient-boosted trees: class logit k = baseline[k] + sum of the leaf values
 * of `trees[k]`. Each tree is a flat node array of `TREE_NODE_WIDTH` numbers per
 * node — [feature, threshold, left, right, value] — with feature -1 on leaves.
 * A sample goes left when `x[feature] <= threshold`.
 */
export interface TreeRegionModel extends RegionModelBase {
    kind: "trees";
    baseline: readonly number[];
    trees: readonly (readonly (readonly number[])[])[];
}

export type RegionModelWeights = LogisticRegionModel | TreeRegionModel;

export const TREE_NODE_WIDTH = 5;

/** Throws when weights were trained on a different feature set. */
export function assertCompatible(model: RegionModelWeights): void {
    if (
        model.featureVersion !== REGION_FEATURE_VERSION ||
        model.features.length !== REGION_FEATURES.length ||
        model.features.some((f, i) => f !== REGION_FEATURES[i])
    ) {
        throw new Error(
            `region model was trained on feature version ${model.featureVersion}; detector has ${REGION_FEATURE_VERSION}`,
        );
    }
}

function logisticLogits(model: LogisticRegionModel, x: readonly number[]): number[] {
    return model.coef.map((row, k) => {
        let z = model.intercept[k];
        for (let i = 0; i < row.length; i++) z += row[i] * ((x[i] - model.mean[i]) / model.scale[i]);
        return z;
    });
}

function treeValue(tree: readonly number[], x: readonly number[]): number {
    let node = 0;
    for (;;) {
        const o = node * TREE_NODE_WIDTH;
        const feature = tree[o];
        if (feature < 0) return tree[o + 4];
        node = x[feature] <= tree[o + 1] ? tree[o + 2] : tree[o + 3];
    }
}

function treeLogits(model: TreeRegionModel, x: readonly number[]): number[] {
    return model.trees.map((trees, k) => {
        let z = model.baseline[k];
        for (const tree of trees) z += treeValue(tree, x);
        return z;
    });
}

/** Class probabilities (softmax), keyed by class. */
export function predictRegionClass(model: RegionModelWeights, x: readonly number[]): Record<RegionClass, number> {
    const logits = model.kind === "trees" ? treeLogits(model, x) : logisticLogits(model, x);
    const max = Math.max(...logits);
    const exps = logits.map((z) => Math.exp(z - max));
    const total = exps.reduce((a, b) => a + b, 0);
    const probs: Record<RegionClass, number> = { other: 0, picture: 0, decoration: 0, table: 0 };
    model.classes.forEach((cls, k) => {
        probs[cls] = exps[k] / total;
    });
    return probs;
}
