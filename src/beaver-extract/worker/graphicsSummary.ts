/**
 * Graphics summary produced by the MuPDF fork's graphics-summary device
 * (`mupdf/fitz/graphics-summary.h`): one compact record per filled or stroked
 * path, image, image mask and shading on a page, collected in C without a JS
 * callback per primitive. With `Page.toStructuredTextWithGraphics` it comes
 * from the same interpretation of the page contents as the structured text.
 *
 * Coordinates are in the structured-text frame (top-left origin, page space
 * after the page transform), clipped to the current clip and the page bounds.
 *
 * Worker-safe: no imports outside this file.
 */

/** Layout constants; must match `mupdf/fitz/graphics-summary.h`. */
export const GRAPHICS_SUMMARY_VERSION = 1;
export const GRAPHICS_SUMMARY_HEADER = 16;
export const GRAPHICS_SUMMARY_STRIDE = 12;
/** Records kept per page before further primitives only count in the grid. */
export const DEFAULT_GRAPHICS_SUMMARY_MAX_RECORDS = 4000;

/** Float offsets inside one record. */
export const GS_FIELD = {
    kind: 0,
    x0: 1,
    y0: 2,
    x1: 3,
    y1: 4,
    flags: 5,
    /** 0xRRGGBB (paths and image masks) */
    rgb: 6,
    /** 0-255 */
    alpha: 7,
    /** path segments (paths) */
    segments: 8,
    /** stroke width (stroked paths) or image width in pixels (images) */
    widthOrStroke: 9,
    /** image height in pixels (images) */
    imageHeight: 10,
    /** 24-bit hash of the compressed image data (images) */
    imageHash: 11,
} as const;

export const GS_KIND = {
    fillPath: 1,
    strokePath: 2,
    image: 3,
    imageMask: 4,
    shade: 5,
} as const;

export const GS_FLAG = {
    isRect: 1,
    hasCurve: 2,
    evenOdd: 4,
    clipped: 8,
    /** A tiling-pattern fill: one record for the painted area, fields from the cell's first primitive. */
    tiled: 16,
} as const;

export interface GraphicsSummary {
    /** Page bounds the records were clipped to: [x0, y0, x1, y1]. */
    area: [number, number, number, number];
    /** Primitives drawn per kind, including ones clipped away or past the cap. */
    seen: { fillPath: number; strokePath: number; image: number; imageMask: number; shade: number };
    /** Number of stored records. */
    count: number;
    /** `count * GRAPHICS_SUMMARY_STRIDE` floats; read with `GS_FIELD` offsets. */
    records: Float32Array;
    /** True when the record cap was reached. */
    overflow: boolean;
    /**
     * True when recording stopped at an error (header[14]): the records end
     * there, so primitives drawn after it are missing.
     */
    incomplete: boolean;
    /** Row-major `gridSize x gridSize` counts of primitives past the cap, or null. */
    grid: Float32Array | null;
    gridSize: number;
}

/** One decoded record (convenience for tests and debugging). */
export interface GraphicsRecord {
    kind: number;
    bbox: [number, number, number, number];
    flags: number;
    rgb: number;
    alpha: number;
    segments: number;
    widthOrStroke: number;
    imageHeight: number;
    imageHash: number;
}

/**
 * Parse the summary bytes. The bytes are copied, so the caller may free the
 * WASM buffer they came from. Throws on an unknown version or a malformed
 * buffer.
 */
export function parseGraphicsSummary(bytes: Uint8Array): GraphicsSummary {
    if (bytes.byteLength % 4 !== 0 || bytes.byteLength < GRAPHICS_SUMMARY_HEADER * 4) {
        throw new Error(`graphics summary: bad length ${bytes.byteLength}`);
    }
    const floats = new Float32Array(bytes.slice().buffer);
    const version = floats[0];
    const count = floats[1];
    const stride = floats[2];
    if (version !== GRAPHICS_SUMMARY_VERSION || stride !== GRAPHICS_SUMMARY_STRIDE) {
        throw new Error(`graphics summary: unsupported version ${version} / stride ${stride}`);
    }
    const overflow = floats[8] === 1;
    const gridSize = floats[9];
    const recordsEnd = GRAPHICS_SUMMARY_HEADER + count * stride;
    const expected = recordsEnd + (overflow ? gridSize * gridSize : 0);
    if (floats.length !== expected) {
        throw new Error(`graphics summary: ${floats.length} floats, expected ${expected}`);
    }
    return {
        area: [floats[10], floats[11], floats[12], floats[13]],
        seen: {
            fillPath: floats[3],
            strokePath: floats[4],
            image: floats[5],
            imageMask: floats[6],
            shade: floats[7],
        },
        count,
        records: floats.subarray(GRAPHICS_SUMMARY_HEADER, recordsEnd),
        overflow,
        incomplete: floats[14] === 1,
        grid: overflow ? floats.subarray(recordsEnd, expected) : null,
        gridSize: overflow ? gridSize : 0,
    };
}

export function graphicsRecord(summary: GraphicsSummary, index: number): GraphicsRecord {
    const o = index * GRAPHICS_SUMMARY_STRIDE;
    const r = summary.records;
    return {
        kind: r[o + GS_FIELD.kind],
        bbox: [r[o + GS_FIELD.x0], r[o + GS_FIELD.y0], r[o + GS_FIELD.x1], r[o + GS_FIELD.y1]],
        flags: r[o + GS_FIELD.flags],
        rgb: r[o + GS_FIELD.rgb],
        alpha: r[o + GS_FIELD.alpha],
        segments: r[o + GS_FIELD.segments],
        widthOrStroke: r[o + GS_FIELD.widthOrStroke],
        imageHeight: r[o + GS_FIELD.imageHeight],
        imageHash: r[o + GS_FIELD.imageHash],
    };
}
