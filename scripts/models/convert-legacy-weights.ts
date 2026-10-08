/**
 * One-time conversion of the region and reference weights modules from their
 * own formats to the shared model runtime's (`src/beaver-extract/models/runtime.ts`:
 * `bxm-trees-v1`, `bxm-logistic-v1`). Values are copied as float64 and written
 * as shortest round-trip literals, so every score is bit-identical.
 *
 *   npx tsx scripts/models/convert-legacy-weights.ts 053d29156
 *
 * Reads the legacy modules from git at the given commit (the last one with
 * the old formats) and writes `src/beaver-extract/{regions,references}/weights.ts`.
 * Run from the repository root. Retrain these models in beaver-extract-models,
 * which exports `bxm-trees-v1` directly; the research repo's
 * `train_detector.py` and `fit_final.py` write the retired formats.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { STAGE2_FEATURES } from "../../src/beaver-extract/references/model";

type Num = readonly number[];
const NODE = 5;

/** Region tree: flat [feature, threshold, left, right, value] per node. */
function regionTree(flat: Num, score: number) {
    const t = { score, feature: [] as number[], threshold: [] as number[], left: [] as number[], right: [] as number[], value: [] as number[] };
    for (let o = 0; o < flat.length; o += NODE) {
        t.feature.push(flat[o]);
        t.threshold.push(flat[o + 1]);
        t.left.push(flat[o + 2]);
        t.right.push(flat[o + 3]);
        t.value.push(flat[o + 4]);
    }
    return t;
}

const refTree = (t: { feature: Num; threshold: Num; left: Num; right: Num; value: Num }) => ({
    score: 0, feature: t.feature, threshold: t.threshold, left: t.left, right: t.right, value: t.value,
});

/** A model object as TS source: one tree (or coefficient row) per line. */
function source(value: unknown, indent = "    "): string {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
        return `[\n${value.map((v) => indent + "    " + JSON.stringify(v)).join(",\n")},\n${indent}]`;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(value).map(([k, v]) => `${indent}    ${k}: ${source(v, indent + "    ")}`);
        return `{\n${entries.join(",\n")},\n${indent}}`;
    }
    return JSON.stringify(value);
}

const HEADER = `// Values are shortest round-trip literals of float64 values, which the lint rule
// misreports when it re-rounds them to 17 digits.
/* eslint-disable no-loss-of-precision */`;

/**
 * A legacy weights module at `commit`, loaded: its source from git, with the
 * type import and the annotation of its export removed.
 */
async function legacyModule(commit: string, path: string, dir: string): Promise<Record<string, any>> {
    const source = execFileSync("git", ["show", `${commit}:${path}`], { encoding: "utf8" })
        .replace(/^import type .*$/m, "")
        .replace(/^(export const [A-Z_]+): [^=]+=/m, "$1 =");
    const file = join(dir, path.replace(/\//g, "_"));
    writeFileSync(file, source);
    return import(pathToFileURL(file).href);
}

async function main() {
    const [commit] = process.argv.slice(2);
    if (!commit) throw new Error("usage: convert-legacy-weights.ts <commit>");
    const dir = mkdtempSync(join(tmpdir(), "legacy-weights-"));
    let region: any;
    let ref: any;
    try {
        ({ REGION_MODEL: region } = await legacyModule(commit, "src/beaver-extract/regions/weights.ts", dir));
        ({ REFERENCE_MODEL: ref } = await legacyModule(commit, "src/beaver-extract/references/weights.ts", dir));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    // Regions: trees per class -> one tree list, interleaved by boosting round
    // as the training export writes them (each class keeps its tree order).
    if (region.kind !== "trees") throw new Error("expected tree region weights");
    const rounds = Math.max(...region.trees.map((t: Num[]) => t.length));
    const trees = [];
    for (let r = 0; r < rounds; r++) {
        for (let k = 0; k < region.trees.length; k++) {
            if (r < region.trees[k].length) trees.push(regionTree(region.trees[k][r], k));
        }
    }
    const regionModel = {
        format: "bxm-trees-v1",
        featureVersion: region.featureVersion,
        trainedOn: region.trainedOn,
        features: region.features,
        classes: region.classes,
        baseline: region.baseline,
        trees,
    };
    writeFileSync(
        "src/beaver-extract/regions/weights.ts",
        `/**
 * Trained region-classifier weights (\`../models/runtime.ts\` format); do not edit by hand.
 * Trained by beaver-extract-research \`scripts/regions/train_detector.py\` and converted by
 * \`scripts/models/convert-legacy-weights.ts\`. That generator writes a retired format:
 * retrain in beaver-extract-models, which exports this format directly.
 */
${HEADER}
import type { RegionModelWeights } from "./model";

export const REGION_MODEL: RegionModelWeights | null = ${source(regionModel, "")};
`,
    );

    const stage1Features = ref.features;
    const referenceModel = {
        trainedOn: "model m3: 472911 labeled items from 2506 documents (luna-v1 (d7f7ae1a677e))",
        stage1: {
            format: "bxm-logistic-v1",
            featureVersion: ref.featureVersion,
            features: stage1Features,
            classes: [0, 1],
            mean: ref.stage1.mean,
            scale: ref.stage1.scale,
            coef: [ref.stage1.coef],
            intercept: [ref.stage1.intercept],
        },
        stage2: {
            format: "bxm-trees-v1",
            features: [...STAGE2_FEATURES, ...stage1Features],
            classes: [0, 1],
            baseline: [ref.stage2.baseline],
            trees: ref.stage2.trees.map(refTree),
        },
        threshold: ref.threshold,
        lines: {
            model: {
                format: "bxm-trees-v1",
                featureVersion: ref.lines.featureVersion,
                features: ref.lines.features,
                classes: [0, 1],
                baseline: [ref.lines.baseline],
                trees: ref.lines.trees.map(refTree),
            },
            splitThreshold: ref.lines.splitThreshold,
            mergeThreshold: ref.lines.mergeThreshold,
        },
    };
    writeFileSync(
        "src/beaver-extract/references/weights.ts",
        `/**
 * Trained reference-classifier weights (\`../models/runtime.ts\` format); do not edit by hand.
 * Trained by beaver-extract-research \`scripts/references/fit_final.py\` and converted by
 * \`scripts/models/convert-legacy-weights.ts\`. That generator writes a retired format:
 * retrain in beaver-extract-models, which exports this format directly.
 */
import type { ReferenceModel } from "./model";

export const REFERENCE_MODEL: ReferenceModel = ${source(referenceModel, "")};
`,
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
