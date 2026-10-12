/**
 * Region classifier over `REGION_FEATURES`: a multiclass model of the shared
 * runtime (`../models/runtime.ts`), gradient-boosted trees or multinomial
 * logistic regression. Weights are trained in the research repo
 * (`beaver-extract-research`, `scripts/regions/train_detector.py`) and
 * generated into `weights.ts`.
 */
import { assertModelFeatures, columnsRead, modelProbabilities, type Model, type ModelInfo } from "../models/runtime";
import { GRID_FEATURES, REGION_FEATURES, REGION_FEATURE_VERSION, REGION_GRID_FEATURES, REGION_GRID_FEATURE_VERSION } from "./features";

export type RegionClass = "other" | "picture" | "decoration" | "table" | "formula";

export type RegionModelWeights = Model<RegionClass> & ModelInfo;

/** Weights trained on the grid feature set (`REGION_GRID_FEATURES`) rather than `REGION_FEATURES`. */
export function usesGridFeatures(model: RegionModelWeights): boolean {
    return model.featureVersion === REGION_GRID_FEATURE_VERSION;
}

const gridReads = new WeakMap<RegionModelWeights, readonly [boolean, boolean]>();

/**
 * Whether weights trained on the grid feature set may read a `GRID_FEATURES`
 * value other than `src_grid` for a candidate whose `src_grid` is `srcGrid` (1 for
 * grid candidates, 0 for the others): told from its trees once per model. When it
 * cannot, those values need not be computed.
 */
export function readsGridFeatures(model: RegionModelWeights, srcGrid: 0 | 1): boolean {
    let reads = gridReads.get(model);
    if (!reads) {
        const src = REGION_FEATURES.length;
        const grid = (read: Set<number>) => [...read].some((f) => f > src && f < src + GRID_FEATURES.length);
        reads = [grid(columnsRead(model, new Map([[src, 0]]))), grid(columnsRead(model, new Map([[src, 1]])))];
        gridReads.set(model, reads);
    }
    return reads[srcGrid];
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
