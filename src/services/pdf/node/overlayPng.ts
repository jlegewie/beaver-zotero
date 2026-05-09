/**
 * Node replacement for `react/utils/canvasOverlay.ts:drawBBoxOverlayPNG`.
 *
 * Composites overlay rects onto a rendered page PNG using `sharp` + an
 * SVG layer. The SVG itself is built by the shared
 * `debug/overlaySvg.ts` so the React/canvas path and the Node/sharp path
 * stay visually consistent.
 *
 * `sharp` is the only Node-native dep added by the CLI. It's a
 * devDependency — never imported from React or worker code, so the
 * Zotero plugin XPI stays clean. The bundle-hygiene grep in
 * `npm run build:dev` enforces this.
 */
import sharp from "sharp";

import { buildOverlaySvg } from "../debug/overlaySvg";
import type { OverlayRect } from "../debug/overlayBuilders";

/**
 * Draw bbox overlays on a rendered page image.
 *
 * Signature mirrors `drawBBoxOverlayPNG` so callers pick the
 * environment-appropriate function without changing the call site shape.
 *
 * @param pngBytes Raw PNG bytes from MuPDF render.
 * @param imageWidth Rendered image width in pixels.
 * @param imageHeight Rendered image height in pixels.
 * @param pageWidth Page width in MuPDF points (used to compute pt→px scale).
 * @param pageHeight Page height in MuPDF points.
 * @param rects Overlay rects in MuPDF top-left point coordinates.
 * @returns PNG bytes with overlays drawn.
 */
export async function drawBBoxOverlayPNGNode(
    pngBytes: Uint8Array,
    imageWidth: number,
    imageHeight: number,
    pageWidth: number,
    pageHeight: number,
    rects: OverlayRect[],
): Promise<Uint8Array> {
    const svg = buildOverlaySvg({
        imageWidth,
        imageHeight,
        pageWidth,
        pageHeight,
        rects,
    });

    // Slice out exactly the PNG byte range — handing `pngBytes.buffer`
    // to sharp without slicing would include any trailing bytes from a
    // shared backing buffer (same trap as the canvas path).
    const pngBuffer = Buffer.from(
        pngBytes.buffer,
        pngBytes.byteOffset,
        pngBytes.byteLength,
    );

    const out = await sharp(pngBuffer)
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .png()
        .toBuffer();

    return new Uint8Array(out);
}
