/**
 * Group rects that touch after dilating each by `gap / 2`.
 *
 * `clusterRects` is a grid-bucketed union-find (exact); above `GRID_CLUSTER_MIN`
 * rects it switches to `gridCluster`, a linear-time occupancy-grid approximation.
 * Pages with that many primitives are dense drawings (scatter plots, vectorised
 * bitmaps) whose rects pile into a few buckets, where the exact pairwise test
 * turns quadratic; the grid costs a few milliseconds regardless of density.
 */
import { dilate, touches, type Rect } from "./geometry";

const BUCKET = 16;
/** Rects spanning more cells than this are compared against all rects instead. */
const MAX_CELLS_PER_RECT = 64;
export const GRID_CLUSTER_MIN = 2000;
/** Occupancy-grid cells per page stay near this, so oversized pages get coarser cells. */
const GRID_TARGET_CELLS = 500_000;

export function clusterRects(rects: readonly Rect[], gap: number): number[][] {
    if (rects.length > GRID_CLUSTER_MIN) return gridCluster(rects, gap);
    const parent = rects.map((_, i) => i);
    const find = (x: number): number => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };
    const join = (a: number, b: number) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
    };

    const half = gap / 2;
    const grown = rects.map((r) => dilate(r, half));
    const grid = new Map<number, number[]>();
    const big: number[] = [];
    // Cell keys pack (gx, gy) into one number; pages are far smaller than 2^16 buckets.
    const key = (gx: number, gy: number) => gx * 65536 + gy;
    // seenBy[j] === i + 1: rect j was already compared with rect i.
    const seenBy = new Int32Array(rects.length);
    for (let i = 0; i < grown.length; i++) {
        const d = grown[i];
        const x0 = Math.floor(d[0] / BUCKET), y0 = Math.floor(d[1] / BUCKET);
        const x1 = Math.floor(d[2] / BUCKET), y1 = Math.floor(d[3] / BUCKET);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_RECT) {
            big.push(i);
            continue;
        }
        for (let gx = x0; gx <= x1; gx++) {
            for (let gy = y0; gy <= y1; gy++) {
                const k = key(gx, gy);
                let bucket = grid.get(k);
                if (!bucket) {
                    bucket = [];
                    grid.set(k, bucket);
                }
                for (const j of bucket) {
                    if (seenBy[j] === i + 1) continue;
                    seenBy[j] = i + 1;
                    // Already in one component: the geometric test cannot change anything.
                    if (find(j) !== find(i) && touches(d, grown[j])) join(i, j);
                }
                bucket.push(i);
            }
        }
    }
    for (const i of big) {
        for (let j = 0; j < grown.length; j++) {
            if (j !== i && touches(grown[i], grown[j])) join(i, j);
        }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < rects.length; i++) {
        const root = find(i);
        const g = groups.get(root);
        if (g) g.push(i);
        else groups.set(root, [i]);
    }
    return [...groups.values()];
}

/**
 * Connected components of the rects' dilated footprints on a grid of 1pt cells
 * (coarser on oversized pages). Adjacent cells connect, so rects up to one cell
 * beyond the gap can merge; on pages this
 * dense one large plot usually dominates and exact grouping matters little.
 */
export function gridCluster(rects: readonly Rect[], gap: number): number[][] {
    if (rects.length === 0) return [];
    const half = gap / 2;
    let xMax = 0;
    let yMax = 0;
    for (const r of rects) {
        xMax = Math.max(xMax, r[2] + half);
        yMax = Math.max(yMax, r[3] + half);
    }
    const cell = Math.max(1, Math.sqrt((xMax * yMax) / GRID_TARGET_CELLS));
    const cols = Math.ceil(xMax / cell) + 2;
    const rows = Math.ceil(yMax / cell) + 2;
    const cells = (r: Rect): [number, number, number, number] => {
        const x0 = Math.max(0, Math.floor((r[0] - half) / cell));
        const y0 = Math.max(0, Math.floor((r[1] - half) / cell));
        return [
            x0,
            y0,
            Math.min(cols, Math.max(x0 + 1, Math.ceil((r[2] + half) / cell))),
            Math.min(rows, Math.max(y0 + 1, Math.ceil((r[3] + half) / cell))),
        ];
    };
    const occupied = new Uint8Array(cols * rows);
    for (const r of rects) {
        const [x0, y0, x1, y1] = cells(r);
        for (let y = y0; y < y1; y++) occupied.fill(1, y * cols + x0, y * cols + x1);
    }
    // 4-connected component labelling with an explicit stack.
    const label = new Int32Array(cols * rows);
    let next = 0;
    const stack = new Int32Array(cols * rows);
    const visit = (n: number, sp: number): number => {
        if (occupied[n] && !label[n]) {
            label[n] = next;
            stack[sp++] = n;
        }
        return sp;
    };
    for (let start = 0; start < occupied.length; start++) {
        if (!occupied[start] || label[start]) continue;
        next++;
        label[start] = next;
        let sp = 0;
        stack[sp++] = start;
        while (sp > 0) {
            const c = stack[--sp];
            const x = c % cols;
            if (x > 0) sp = visit(c - 1, sp);
            if (x < cols - 1) sp = visit(c + 1, sp);
            if (c >= cols) sp = visit(c - cols, sp);
            if (c + cols < occupied.length) sp = visit(c + cols, sp);
        }
    }
    const groups = new Map<number, number[]>();
    rects.forEach((r, i) => {
        const [x0, y0] = cells(r);
        const id = label[y0 * cols + x0];
        const g = groups.get(id);
        if (g) g.push(i);
        else groups.set(id, [i]);
    });
    return [...groups.values()];
}
