/**
 * Rect helpers for region detection. Rects are `[x0, y0, x1, y1]` tuples in the
 * structured-text frame (top-left origin), which keeps the hot loops free of
 * object allocation.
 */

export type Rect = [number, number, number, number];

export function rectArea(r: Rect): number {
    return Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
}

export function intersect(a: Rect, b: Rect): Rect {
    return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}

export function unionRect(a: Rect, b: Rect): Rect {
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Fraction of `a` covered by `b`. */
export function overlapFrac(a: Rect, b: Rect): number {
    const area = rectArea(a);
    return area > 0 ? rectArea(intersect(a, b)) / area : 0;
}

export function dilate(r: Rect, d: number): Rect {
    return [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
}

/** True when the rects overlap or touch (closed intervals). */
export function touches(a: Rect, b: Rect): boolean {
    return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** Horizontal gap between two rects (0 when they overlap in x). */
export function hgap(a: Rect, b: Rect): number {
    return Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]));
}

/** Vertical gap between two rects (0 when they overlap in y). */
export function vgap(a: Rect, b: Rect): number {
    return Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));
}

export function width(r: Rect): number {
    return r[2] - r[0];
}

export function height(r: Rect): number {
    return r[3] - r[1];
}
