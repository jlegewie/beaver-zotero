import type { BoundingBox, CoordOrigin } from "../types";
import { bboxToTuple } from "../types";
import type { Rect } from "./schema";

function round(value: number, precision: number): number {
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
}

/** Convert an internal top-left `BoundingBox` into the public tuple rect. */
export function bboxToRect(bbox: BoundingBox, precision = 1): Rect {
    if (bbox.origin !== "top-left") {
        throw new Error("Canonical extraction rects require top-left bboxes");
    }
    return roundRect(bboxToTuple(bbox), precision);
}

/** Convert a public tuple rect back into an internal `BoundingBox`. */
export function rectToBBox(
    rect: Rect,
    origin: CoordOrigin = "top-left",
): BoundingBox {
    return {
        l: rect[0],
        t: rect[1],
        r: rect[2],
        b: rect[3],
        origin,
    };
}

/** Round a rect to the requested decimal precision. */
export function roundRect(rect: Rect, precision: number): Rect {
    return [
        round(rect[0], precision),
        round(rect[1], precision),
        round(rect[2], precision),
        round(rect[3], precision),
    ];
}
