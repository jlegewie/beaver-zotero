/**
 * Geometry of an item's lines, shared by the item models. Sizes are in em of
 * the document's body text and clamped to fixed ranges, so features read the
 * same on every page size.
 */

import type { InputLine } from "./itemInput";

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function median(values: readonly number[]): number {
    if (values.length === 0) return 0;
    if (values.length === 1) return values[0];
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Layout of an item's lines (`lineBlockGeometry`). */
export interface LineBlockGeometry {
    /** Share of lines after the first that the detector read as hanging continuations. */
    hangCont: number;
    /** Indent of the later lines against the first, in em, clamped to [-3, 5] and scaled by 1/5. */
    hangIndent: number;
    /** How far the last line reaches across the item, 0–1. */
    lastFill: number;
    /** Median gap between lines in em, clamped to [-1, 3] and scaled by 1/3. */
    lineGap: number;
    /** First line's indent against the item's left edge in em, clamped to [0, 5] and scaled by 1/5. */
    firstIndent: number;
    /** Item extent: leftmost, rightmost and top line edges (0 without lines). */
    left: number;
    right: number;
    top: number;
}

/** Layout of an item's lines; `em` is the document's body size. */
export function lineBlockGeometry(lines: readonly InputLine[], em: number): LineBlockGeometry {
    let hangCont = 0;
    let hangIndent = 0;
    let lastFill = 1;
    let lineGap = 0;
    if (lines.length >= 2) {
        let cont = 0;
        let minRest = Infinity;
        let maxR = -Infinity;
        let minL = Infinity;
        const gaps: number[] = [];
        for (let k = 0; k < lines.length; k++) {
            const line = lines[k];
            maxR = Math.max(maxR, line.r);
            minL = Math.min(minL, line.l);
            if (k > 0) {
                if (line.role === 2) cont++;
                minRest = Math.min(minRest, line.l);
                gaps.push(line.t - lines[k - 1].b);
            }
        }
        hangCont = cont / (lines.length - 1);
        hangIndent = clamp((minRest - lines[0].l) / em, -3, 5) / 5;
        const last = lines[lines.length - 1];
        lastFill = maxR > minL ? clamp((last.r - minL) / (maxR - minL), 0, 1) : 1;
        lineGap = clamp(median(gaps) / em, -1, 3) / 3;
    }
    const left = lines.length > 0 ? Math.min(...lines.map((l) => l.l)) : 0;
    const right = lines.length > 0 ? Math.max(...lines.map((l) => l.r)) : 0;
    const top = lines.length > 0 ? Math.min(...lines.map((l) => l.t)) : 0;
    const firstIndent = lines.length > 0 ? clamp((lines[0].l - left) / em, 0, 5) / 5 : 0;
    return { hangCont, hangIndent, lastFill, lineGap, firstIndent, left, right, top };
}
