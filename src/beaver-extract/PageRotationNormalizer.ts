/**
 * Page-rotation normalization for the paragraph / sentence extraction
 * stack.
 *
 * Some PDF pages have body text drawn with a rotated text matrix (e.g.
 * `/Rotate 90` portrait pages displayed as landscape, or figure pages
 * with a side-rotated caption). MuPDF emits the text in its native
 * (top-left origin, y-down) frame regardless, so the resulting line
 * bboxes are tall-narrow vertical strips that stack horizontally. The
 * downstream pipeline (`ColumnDetector`, `ParagraphDetector`,
 * `ParagraphSentenceMapper`) assumes wide-short lines that stack
 * vertically, so multi-line rotated paragraphs come out in **reverse
 * reading order** with adjacent paragraphs mashed together.
 *
 * The helpers here let the pipeline detect a dominant rotation per
 * target page, rotate the raw line/char/block geometry into an upright
 * working frame, and inverse-rotate the emitted paragraph/sentence
 * bboxes back to the MuPDF frame the annotation layer
 * (`react/utils/pdfUtils.ts:applyRotationToBoundingBox`) expects.
 *
 * Scope: only the paragraph/sentence pipeline normalizes. Raw extractor
 * output and other consumers (`PageExtractor` block engine,
 * `DocumentAnalyzer`, `SearchScorer`, trace endpoints, `analyzeLayout`)
 * stay in MuPDF frame.
 *
 * Coordinate convention (MuPDF stext): public bboxes are `BoundingBox`
 * objects with top-left origin and y increasing downward.
 *
 * Per-line `rotation` mapping (observed values from
 * `stext.walk → beginLine(dir)` on real /Rotate-90 and side-caption
 * pages):
 *
 *   dir = [ 1,  0] → 0   (upright body text)
 *   dir = [ 0,  1] → 90  (writes downward in y-down frame)
 *   dir = [-1,  0] → 180
 *   dir = [ 0, -1] → 270 (writes upward in y-down frame)
 */

import type {
    BoundingBox,
    MarginSettings,
    RawBlock,
    RawChar,
    RawLine,
    RawLineDetailed,
    RawPageData,
    RawPageDataDetailed,
    QuadPoint,
} from "./types";
import { bboxHeight, bboxWidth } from "./types";

export type RotationAngle = 0 | 90 | 180 | 270;

/**
 * Snap a `dir` vector emitted by `stext.walk → beginLine(_, _, dir)`
 * (or read off a character quad's UL→UR direction) to the nearest
 * cardinal angle. Returns 0 for degenerate vectors.
 */
export function dirToRotation(dx: number, dy: number): RotationAngle {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax < 0.5 && ay < 0.5) {
        // Degenerate dir (some MuPDF builds emit [0,0] for empty lines).
        return 0;
    }
    if (ax >= ay) {
        return dx >= 0 ? 0 : 180;
    }
    return dy >= 0 ? 90 : 270;
}

/**
 * Bbox aspect-ratio fallback for the JSON-pass when a `dir` vector
 * isn't available for a particular line. Cannot disambiguate 90 vs
 * 270 — returns 90 for all vertical strips. Callers that need
 * reading-order sign should consult `dir`-derived rotations from the
 * parallel walk instead.
 */
export function aspectRatioRotation(bbox: BoundingBox): RotationAngle {
    const width = bboxWidth(bbox);
    const height = bboxHeight(bbox);
    if (width <= 0 || height <= 0) return 0;
    if (height >= 2 * width) return 90;
    return 0;
}

interface DetectOptions {
    /** Minimum non-marginal weighted characters required before
     *  classifying as rotated. Below this, return 0 (no normalization). */
    minWeightedChars?: number;
    /** Required share of the dominant rotation, out of total
     *  weighted chars after marginZone exclusion. */
    dominantShare?: number;
    /** Maximum share of any non-dominant orientation. Pages with too
     *  much horizontal+rotated mix stay un-normalized. */
    maxNonDominantShare?: number;
}

const DEFAULT_DETECT_OPTIONS: Required<DetectOptions> = {
    minWeightedChars: 200,
    dominantShare: 0.8,
    maxNonDominantShare: 0.2,
};

/**
 * Detect the dominant text writing direction on a page.
 *
 * Excludes lines whose bbox center sits inside `marginZone`, then
 * computes a char-length-weighted vote across the four cardinal
 * orientations. Returns the dominant orientation iff it meets the
 * threshold criteria; otherwise returns 0 (the page stays in MuPDF
 * frame).
 *
 * Center-based exclusion is intentional: a long rotated body line that
 * happens to extend into the page edges will keep its center near the
 * middle of the column and pass the filter, so we don't accidentally
 * drop legitimate body text.
 */
export function detectDominantTextOrientation(
    page: RawPageData,
    marginZone: MarginSettings,
    options: DetectOptions = {},
): RotationAngle {
    const opts = { ...DEFAULT_DETECT_OPTIONS, ...options };
    const pageW = page.width;
    const pageH = page.height;
    const leftEdge = marginZone.left;
    const rightEdge = pageW - marginZone.right;
    const topEdge = marginZone.top;
    const bottomEdge = pageH - marginZone.bottom;

    const votes: Record<RotationAngle, number> = { 0: 0, 90: 0, 180: 0, 270: 0 };
    let total = 0;

    for (const block of page.blocks) {
        if (block.type !== "text") continue;
        for (const line of block.lines ?? []) {
            const cx = line.bbox.l + bboxWidth(line.bbox) / 2;
            const cy = line.bbox.t + bboxHeight(line.bbox) / 2;
            // Skip lines whose center is in the marginZone — they're
            // usually page numbers, running headers, JSTOR-style
            // watermarks, etc., not body content. Center-based test
            // keeps long lines straddling the edge.
            if (cx < leftEdge || cx > rightEdge) continue;
            if (cy < topEdge || cy > bottomEdge) continue;

            const weight = line.text.trim().length;
            if (weight === 0) continue;
            const rot = (line.rotation ?? 0) as RotationAngle;
            votes[rot] += weight;
            total += weight;
        }
    }

    if (total < opts.minWeightedChars) return 0;

    let dominant: RotationAngle = 0;
    let dominantCount = 0;
    for (const angle of [0, 90, 180, 270] as RotationAngle[]) {
        if (votes[angle] > dominantCount) {
            dominantCount = votes[angle];
            dominant = angle;
        }
    }
    if (dominant === 0) return 0;
    if (dominantCount / total < opts.dominantShare) return 0;

    // No other orientation may exceed the cap. Prevents sparse mixed
    // pages (e.g. a horizontal body with one rotated caption) from
    // being globally rotated.
    for (const angle of [0, 90, 180, 270] as RotationAngle[]) {
        if (angle === dominant) continue;
        if (votes[angle] / total > opts.maxNonDominantShare) return 0;
    }

    return dominant;
}

// ---------------------------------------------------------------------------
// Geometry — forward and inverse rotation in MuPDF's y-down frame
// ---------------------------------------------------------------------------
//
// A line's `rotation` describes how far its writing direction is
// rotated from upright in the MuPDF frame. To normalize a page whose
// lines have rotation `R`, we apply rotation `-R` to all geometry,
// taking points from the source frame (W_src × H_src) into an upright
// working frame.
//
// Point transforms (forward = source → upright):
//   R=0:   (x, y) → (x, y)
//   R=90:  (x, y) → (y, W_src - x)         // source W×H → upright H×W
//   R=180: (x, y) → (W_src - x, H_src - y) // source W×H → upright W×H
//   R=270: (x, y) → (H_src - y, x)         // source W×H → upright H×W
//
// Point transforms (inverse = upright → source), used at emit sites:
//   R=0:   identity
//   R=90:  (u, v) → (W_src - v, u)
//   R=180: (u, v) → (W_src - u, H_src - v)
//   R=270: (u, v) → (v, H_src - u)
//
// Bbox transforms preserve axis-alignment by mapping the two diagonal
// corners then re-deriving semantic top-left edges.

function rotatePoint(
    x: number,
    y: number,
    rotation: RotationAngle,
    sourceWidth: number,
    sourceHeight: number,
): [number, number] {
    switch (rotation) {
        case 0:
            return [x, y];
        case 90:
            return [y, sourceWidth - x];
        case 180:
            return [sourceWidth - x, sourceHeight - y];
        case 270:
            return [sourceHeight - y, x];
    }
}

function invertPoint(
    u: number,
    v: number,
    rotation: RotationAngle,
    sourceWidth: number,
    sourceHeight: number,
): [number, number] {
    switch (rotation) {
        case 0:
            return [u, v];
        case 90:
            return [sourceWidth - v, u];
        case 180:
            return [sourceWidth - u, sourceHeight - v];
        case 270:
            return [v, sourceHeight - u];
    }
}

export function rotateBBox(
    bbox: BoundingBox,
    rotation: RotationAngle,
    sourceWidth: number,
    sourceHeight: number,
): BoundingBox {
    if (rotation === 0) return { ...bbox };
    const [x0, y0] = rotatePoint(bbox.l, bbox.t, rotation, sourceWidth, sourceHeight);
    const [x1, y1] = rotatePoint(
        bbox.r,
        bbox.b,
        rotation,
        sourceWidth,
        sourceHeight,
    );
    const minX = Math.min(x0, x1);
    const minY = Math.min(y0, y1);
    const maxX = Math.max(x0, x1);
    const maxY = Math.max(y0, y1);
    return { l: minX, t: minY, r: maxX, b: maxY, origin: bbox.origin };
}

function rotateQuad(
    quad: QuadPoint,
    rotation: RotationAngle,
    sourceWidth: number,
    sourceHeight: number,
): QuadPoint {
    if (rotation === 0) return [...quad] as QuadPoint;
    const out: number[] = new Array(8);
    for (let i = 0; i < 4; i++) {
        const [nx, ny] = rotatePoint(
            quad[i * 2],
            quad[i * 2 + 1],
            rotation,
            sourceWidth,
            sourceHeight,
        );
        out[i * 2] = nx;
        out[i * 2 + 1] = ny;
    }
    return out as unknown as QuadPoint;
}

/**
 * BoundingBox inverse — upright working frame → source MuPDF frame.
 * Used at every emit site (sentence/paragraph/column/line bboxes) so
 * downstream consumers see MuPDF coordinates regardless of whether the
 * pipeline normalized internally.
 */
export function inverseRotateBBox(
    bbox: BoundingBox,
    rotation: RotationAngle,
    sourceWidth: number,
    sourceHeight: number,
): BoundingBox {
    if (rotation === 0) return { ...bbox };
    const [x0, y0] = invertPoint(bbox.l, bbox.t, rotation, sourceWidth, sourceHeight);
    const [x1, y1] = invertPoint(
        bbox.r,
        bbox.b,
        rotation,
        sourceWidth,
        sourceHeight,
    );
    const minX = Math.min(x0, x1);
    const minY = Math.min(y0, y1);
    const maxX = Math.max(x0, x1);
    const maxY = Math.max(y0, y1);
    return { l: minX, t: minY, r: maxX, b: maxY, origin: bbox.origin };
}

export interface RotatedPage<T extends RawPageData> {
    /** Page in upright working frame (width/height swapped for 90/270). */
    page: T;
    /** Original MuPDF dims, needed to inverse-transform output bboxes. */
    sourceWidth: number;
    /** Original MuPDF dims, needed to inverse-transform output bboxes. */
    sourceHeight: number;
}

/**
 * Rotate every text block bbox, every line bbox, and every image block
 * bbox into the upright working frame. Lines retain their original
 * `rotation` field (the pipeline doesn't rely on it post-normalization
 * — it's just metadata).
 */
export function rotateRawPage(
    page: RawPageData,
    rotation: RotationAngle,
): RotatedPage<RawPageData> {
    if (rotation === 0) {
        return { page, sourceWidth: page.width, sourceHeight: page.height };
    }
    const sourceWidth = page.width;
    const sourceHeight = page.height;
    const newBlocks: RawBlock[] = [];
    for (const block of page.blocks) {
        if (block.type === "text") {
            const newLines: RawLine[] = [];
            for (const line of block.lines ?? []) {
                newLines.push({
                    ...line,
                    bbox: rotateBBox(line.bbox, rotation, sourceWidth, sourceHeight),
                });
            }
            newBlocks.push({
                type: "text",
                bbox: rotateBBox(block.bbox, rotation, sourceWidth, sourceHeight),
                lines: newLines,
            });
        } else {
            newBlocks.push({
                type: "image",
                bbox: rotateBBox(block.bbox, rotation, sourceWidth, sourceHeight),
            });
        }
    }
    const swapped = rotation === 90 || rotation === 270;
    return {
        page: {
            ...page,
            width: swapped ? sourceHeight : sourceWidth,
            height: swapped ? sourceWidth : sourceHeight,
            blocks: newBlocks,
        },
        sourceWidth,
        sourceHeight,
    };
}

/**
 * Rotate every text block bbox, every line bbox, every char quad and
 * char bbox, and every image block bbox into the upright working
 * frame. Mirrors `rotateRawPage` for the detailed variant used by the
 * sentence mapper.
 */
export function rotateRawPageDetailed(
    page: RawPageDataDetailed,
    rotation: RotationAngle,
): RotatedPage<RawPageDataDetailed> {
    if (rotation === 0) {
        return { page, sourceWidth: page.width, sourceHeight: page.height };
    }
    const sourceWidth = page.width;
    const sourceHeight = page.height;
    const newBlocks = page.blocks.map((block) => {
        if (block.type === "text") {
            const newLines: RawLineDetailed[] = (block.lines ?? []).map((line) => {
                const newChars: RawChar[] = line.chars.map((ch) => {
                    const newQuad = rotateQuad(ch.quad, rotation, sourceWidth, sourceHeight);
                    return {
                        c: ch.c,
                        quad: newQuad,
                        bbox: rotateBBox(ch.bbox, rotation, sourceWidth, sourceHeight),
                    };
                });
                return {
                    ...line,
                    bbox: rotateBBox(line.bbox, rotation, sourceWidth, sourceHeight),
                    chars: newChars,
                };
            });
            return {
                type: "text" as const,
                bbox: rotateBBox(block.bbox, rotation, sourceWidth, sourceHeight),
                lines: newLines,
            };
        }
        return {
            type: "image" as const,
            bbox: rotateBBox(block.bbox, rotation, sourceWidth, sourceHeight),
        };
    });
    const swapped = rotation === 90 || rotation === 270;
    return {
        page: {
            ...page,
            width: swapped ? sourceHeight : sourceWidth,
            height: swapped ? sourceWidth : sourceHeight,
            blocks: newBlocks,
        },
        sourceWidth,
        sourceHeight,
    };
}
