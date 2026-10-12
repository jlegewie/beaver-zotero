/**
 * Region classifier over `REGION_FEATURES`: a multiclass model of the shared
 * runtime (`../models/runtime.ts`), gradient-boosted trees or multinomial
 * logistic regression. Weights are trained in the research repo
 * (`beaver-extract-research`, `scripts/regions/train_detector.py`) and
 * generated into `weights.ts`.
 */
import { assertModelFeatures, modelProbabilities, type Model, type ModelInfo } from "../models/runtime";
import { REGION_FEATURES, REGION_FEATURE_VERSION, REGION_GRID_FEATURES, REGION_GRID_FEATURE_VERSION } from "./features";

export type RegionClass = "other" | "picture" | "decoration" | "table" | "formula";

export type RegionModelWeights = Model<RegionClass> & ModelInfo;

/** Weights trained on the grid feature set (`REGION_GRID_FEATURES`) rather than `REGION_FEATURES`. */
export function usesGridFeatures(model: RegionModelWeights): boolean {
    return model.featureVersion === REGION_GRID_FEATURE_VERSION;
}

/** Throws when weights were trained on a feature set the detector does not compute. */
export function assertCompatible(model: RegionModelWeights): void {
    if (usesGridFeatures(model)) assertModelFeatures(model, REGION_GRID_FEATURE_VERSION, REGION_GRID_FEATURES, "region");
    else assertModelFeatures(model, REGION_FEATURE_VERSION, REGION_FEATURES, "region");
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
