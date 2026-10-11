/**
 * Region classifier over `REGION_FEATURES`: a multiclass model of the shared
 * runtime (`../models/runtime.ts`), gradient-boosted trees or multinomial
 * logistic regression. Weights are trained in the research repo
 * (`beaver-extract-research`, `scripts/regions/train_detector.py`) and
 * generated into `weights.ts`.
 */
import { assertModelFeatures, modelProbabilities, type Model, type ModelInfo } from "../models/runtime";
import { REGION_FEATURES, REGION_FEATURE_VERSION } from "./features";

export type RegionClass = "other" | "picture" | "decoration" | "table" | "formula";

export type RegionModelWeights = Model<RegionClass> & ModelInfo;

/** Throws when weights were trained on a different feature set. */
export function assertCompatible(model: RegionModelWeights): void {
    assertModelFeatures(model, REGION_FEATURE_VERSION, REGION_FEATURES, "region");
}

/** Class probabilities (softmax), keyed by class. */
export function predictRegionClass(model: RegionModelWeights, x: readonly number[]): Record<RegionClass, number> {
    const p = modelProbabilities(model, x);
    const probs: Record<RegionClass, number> = { other: 0, picture: 0, decoration: 0, table: 0, formula: 0 };
    model.classes.forEach((cls, k) => {
        probs[cls] = p[k];
    });
    return probs;
}
