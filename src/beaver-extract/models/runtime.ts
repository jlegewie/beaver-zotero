/**
 * Runtime of every learned model in Beaver Extract: one evaluator for
 * gradient-boosted trees and one for logistic regression, binary and
 * multiclass.
 *
 * Trees use the portable export formats of the training repo
 * (`beaver_models/models/trees.py`), evaluated exactly as its `decision()`
 * does. In `bxm-trees-v1`:
 *
 * - Node k is a leaf when `feature[k] < 0`. Otherwise a sample goes left when
 *   `x[feature] <= threshold`, or, when x is NaN, when `missing_left[k]` is 1.
 * - Each tree adds its leaf value to score `tree.score`, starting from
 *   `baseline`.
 * - Two classes give one score, the logit of `classes[1]` (sigmoid); more
 *   classes give one score per class (softmax).
 *
 * At first use a tree model's trees are concatenated into flat typed arrays
 * (`flatTrees`, cached per model object); evaluation walks those, with the
 * same arithmetic in the same order as the per-tree arrays of the export.
 *
 * `bxm-trees-packed-v1` (`pack()` there) holds the same kind of trees as
 * complete binary trees of one `depth`, as base64 little-endian typed arrays
 * over all trees. A tree's `2^depth - 1` split nodes are in implicit layout
 * (node k's children are 2k+1 and 2k+2), followed by its `2^depth` leaves.
 * Evaluation is a fixed `depth`-step descent with the routing rule above,
 * then adds the leaf's value to the tree's score. A leaf of the original tree
 * above full depth is padded into splits (feature 0) whose leaves all hold its
 * value, so routing through the padding cannot change the result: scores are
 * bit-identical to the `bxm-trees-v1` form of the same trees. The arrays are
 * decoded once per model object (`packedTrees`), as views of the decoded
 * bytes.
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
export const PACKED_TREES_FORMAT = "bxm-trees-packed-v1";
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

/** Trees in `bxm-trees-packed-v1`: base64 little-endian typed arrays over all trees. */
export interface PackedTreeModel<C extends ClassLabel = ClassLabel> {
    format: typeof PACKED_TREES_FORMAT;
    /** Input column names, in order. */
    features: readonly string[];
    classes: readonly C[];
    /** One per score. */
    baseline: readonly number[];
    /** Depth of every (complete) tree. */
    depth: number;
    /** Number of trees. */
    trees: number;
    /** Uint8 per tree: the score (class) it adds to. */
    score: string;
    /** Int16 per split node: the feature it reads. */
    feature: string;
    /** Float64 per split node. */
    threshold: string;
    /** Uint8 per split node: 1 where NaN goes left. */
    missingLeft: string;
    /** Float64 per leaf. */
    value: string;
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

export type Model<C extends ClassLabel = ClassLabel> = TreeModel<C> | PackedTreeModel<C> | LogisticModel<C>;

/** What a weights module adds to a model export. */
export interface ModelInfo {
    /** Version of the feature set the model was trained on. */
    featureVersion: number;
    /** Provenance, for humans. */
    trainedOn: string;
}

export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** A model's input row: an array, or a typed array that can be longer than the model's features. */
export type ModelInput = ArrayLike<number>;

/** Leaf value of `tree` for the input `x`. */
export function treeValue(tree: Tree, x: ModelInput): number {
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

/**
 * Every tree of a model in one set of node arrays: tree t starts at node
 * `root[t]`, children are indices into the same arrays, and `missingLeft` is
 * 0 where the export omits it.
 */
interface FlatTrees {
    feature: Int32Array;
    threshold: Float64Array;
    left: Int32Array;
    right: Int32Array;
    value: Float64Array;
    missingLeft: Uint8Array;
    root: Int32Array;
    score: Int32Array;
}

const flatCache = new WeakMap<TreeModel, FlatTrees>();

function flatTrees(model: TreeModel): FlatTrees {
    let flat = flatCache.get(model);
    if (flat) return flat;
    const n = model.trees.reduce((total, tree) => total + tree.feature.length, 0);
    flat = {
        feature: new Int32Array(n),
        threshold: new Float64Array(n),
        left: new Int32Array(n),
        right: new Int32Array(n),
        value: new Float64Array(n),
        missingLeft: new Uint8Array(n),
        root: new Int32Array(model.trees.length),
        score: new Int32Array(model.trees.length),
    };
    let offset = 0;
    model.trees.forEach((tree, t) => {
        flat!.root[t] = offset;
        flat!.score[t] = tree.score;
        for (let k = 0; k < tree.feature.length; k++) {
            flat!.feature[offset + k] = tree.feature[k];
            flat!.threshold[offset + k] = tree.threshold[k];
            flat!.left[offset + k] = tree.left[k] + offset;
            flat!.right[offset + k] = tree.right[k] + offset;
            flat!.value[offset + k] = tree.value[k];
            flat!.missingLeft[offset + k] = tree.missing_left?.[k] === 1 ? 1 : 0;
        }
        offset += tree.feature.length;
    });
    flatCache.set(model, flat);
    return flat;
}

/** A packed model's arrays, decoded. */
interface PackedTrees {
    depth: number;
    score: Uint8Array;
    feature: Int16Array;
    threshold: Float64Array;
    missingLeft: Uint8Array;
    value: Float64Array;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_CODES = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) BASE64_CODES[BASE64.charCodeAt(i)] = i;

/**
 * Bytes of a standard base64 string (padding optional), in a fresh buffer.
 * Plain JS, so it runs alike in the worker, the plugin and Node.
 */
export function decodeBase64(text: string): Uint8Array {
    let end = text.length;
    while (end > 0 && text.charCodeAt(end - 1) === 61 /* = */) end--;
    if (end % 4 === 1) throw new Error("Invalid base64: bad length");
    const bytes = new Uint8Array(Math.floor((end * 3) / 4));
    let bits = 0;
    let nbits = 0;
    let j = 0;
    for (let i = 0; i < end; i++) {
        const c = text.charCodeAt(i);
        const v = c < 128 ? BASE64_CODES[c] : -1;
        if (v < 0) throw new Error(`Invalid base64 character at ${i}`);
        bits = ((bits << 6) | v) & 0xffffff;
        nbits += 6;
        if (nbits >= 8) {
            nbits -= 8;
            bytes[j++] = (bits >> nbits) & 0xff;
        }
    }
    return bytes;
}

/** Typed arrays read the platform's byte order; the export's is little-endian. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const packedCache = new WeakMap<PackedTreeModel, PackedTrees>();

function packedTrees(model: PackedTreeModel): PackedTrees {
    let packed = packedCache.get(model);
    if (packed) return packed;
    if (!LITTLE_ENDIAN) throw new Error(`${PACKED_TREES_FORMAT} needs a little-endian platform`);
    const { depth, trees: n } = model;
    if (!(Number.isInteger(depth) && depth >= 0 && depth <= 16 && Number.isInteger(n) && n >= 0)) {
        throw new Error(`${PACKED_TREES_FORMAT}: bad depth ${depth} or tree count ${n}`);
    }
    const splits = n * (2 ** depth - 1);
    const leaves = n * 2 ** depth;
    // Each array decodes into its own buffer, so every view starts at offset 0 (aligned).
    const view = <T>(name: string, data: string, length: number, size: number, make: (buffer: ArrayBuffer) => T): T => {
        const bytes = decodeBase64(data);
        if (bytes.length !== length * size) {
            throw new Error(`${PACKED_TREES_FORMAT}: ${name} has ${bytes.length} bytes, expected ${length * size}`);
        }
        return make(bytes.buffer as ArrayBuffer);
    };
    packed = {
        depth,
        score: view("score", model.score, n, 1, (b) => new Uint8Array(b)),
        feature: view("feature", model.feature, splits, 2, (b) => new Int16Array(b)),
        threshold: view("threshold", model.threshold, splits, 8, (b) => new Float64Array(b)),
        missingLeft: view("missingLeft", model.missingLeft, splits, 1, (b) => new Uint8Array(b)),
        value: view("value", model.value, leaves, 8, (b) => new Float64Array(b)),
    };
    for (let t = 0; t < n; t++) {
        if (packed.score[t] >= model.baseline.length) throw new Error(`${PACKED_TREES_FORMAT}: score ${packed.score[t]} out of range`);
    }
    for (let i = 0; i < splits; i++) {
        const f = packed.feature[i];
        if (f < 0 || f >= model.features.length) throw new Error(`${PACKED_TREES_FORMAT}: feature ${f} out of range`);
    }
    packedCache.set(model, packed);
    return packed;
}

/** `addTreeValues` for a packed model: a fixed `depth`-step descent per tree. */
function addPackedTreeValues(model: PackedTreeModel, x: ModelInput, scores: number[] | Float64Array): void {
    const { depth, score, feature, threshold, missingLeft, value } = packedTrees(model);
    const splits = 2 ** depth - 1;
    for (let t = 0, node = 0, leaf = 0; t < score.length; t++, node += splits, leaf += splits + 1) {
        let k = 0;
        for (let d = 0; d < depth; d++) {
            const i = node + k;
            const v = x[feature[i]];
            // NaN fails every comparison; route it explicitly.
            k = 2 * k + ((v !== v ? missingLeft[i] === 1 : v <= threshold[i]) ? 1 : 2);
        }
        scores[score[t]] += value[leaf + k - splits];
    }
}

/** Adds each tree's leaf value for `x` to `scores[tree.score]`, in tree order. */
function addTreeValues(model: TreeModel | PackedTreeModel, x: ModelInput, scores: number[] | Float64Array): void {
    if (model.format === PACKED_TREES_FORMAT) {
        addPackedTreeValues(model, x, scores);
        return;
    }
    const { feature, threshold, left, right, value, missingLeft, root, score } = flatTrees(model);
    for (let t = 0; t < root.length; t++) {
        let k = root[t];
        for (;;) {
            const f = feature[k];
            if (f < 0) break;
            const v = x[f];
            // NaN fails every comparison; route it explicitly.
            k = (v !== v ? missingLeft[k] === 1 : v <= threshold[k]) ? left[k] : right[k];
        }
        scores[score[t]] += value[k];
    }
}

/** The score of a binary tree model, accumulated in a reused slot (doubles are stored exactly). */
const binaryTreeScore = new Float64Array(1);

function treeScores(model: TreeModel | PackedTreeModel, x: ModelInput): number[] {
    const scores = model.baseline.slice();
    addTreeValues(model, x, scores);
    return scores;
}

function logisticScores(model: LogisticModel, x: ModelInput): number[] {
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
export function binaryScore(model: Model, x: ModelInput): number {
    if (model.format !== LOGISTIC_FORMAT) {
        binaryTreeScore[0] = model.baseline[0];
        addTreeValues(model, x, binaryTreeScore);
        return binaryTreeScore[0];
    }
    const row = model.coef[0];
    let z = model.intercept[0];
    for (let j = 0; j < row.length; j++) z += row[j] * ((x[j] - model.mean[j]) / model.scale[j]);
    return z;
}

/** Raw scores (logits) of one input row: one for binary models, one per class otherwise. */
export function modelScores(model: Model, x: ModelInput): number[] {
    return model.format === LOGISTIC_FORMAT ? logisticScores(model, x) : treeScores(model, x);
}

/** Probability of `classes[1]` under a binary model. */
export function binaryProbability(model: Model, x: ModelInput): number {
    return sigmoid(binaryScore(model, x));
}

/** Class probabilities of one input row, in `model.classes` order. */
export function modelProbabilities(model: Model, x: ModelInput): number[] {
    return scoreProbabilities(modelScores(model, x));
}

/** Class probabilities from raw scores: the sigmoid of one score, the softmax of several. */
export function scoreProbabilities(scores: readonly number[]): number[] {
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
