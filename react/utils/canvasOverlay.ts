/**
 * Canvas Overlay — paint extraction bboxes onto a rendered page PNG.
 *
 * Used by the dev-only `/beaver/test/pdf-render-overlay` endpoint so an
 * agent can call:
 *   render page via MuPDF (PNG bytes) → drawBBoxOverlayPNG(...) → base64
 * and inspect the result without having a Zotero reader open.
 *
 * Runs in the chrome window. Uses `createImageBitmap` + `OffscreenCanvas`
 * (both available in Zotero's main window) instead of `<img>` / `<canvas>`
 * elements — the main window is XUL, so `document.head` is null and
 * inserting `new Image()` into it fails.
 */
import type { OverlayRect } from "./extractionOverlay";

/**
 * Draw bbox overlays on a rendered page image.
 *
 * @param pngBytes Raw PNG bytes from MuPDF render.
 * @param imageWidth Rendered image width in pixels.
 * @param imageHeight Rendered image height in pixels.
 * @param pageWidth Page width in MuPDF points (used to compute pt→px scale).
 * @param pageHeight Page height in MuPDF points.
 * @param rects Overlay rects in MuPDF top-left point coordinates.
 * @returns PNG bytes with overlays drawn.
 */
export async function drawBBoxOverlayPNG(
    pngBytes: Uint8Array,
    imageWidth: number,
    imageHeight: number,
    pageWidth: number,
    pageHeight: number,
    rects: OverlayRect[],
): Promise<Uint8Array> {
    const win = Zotero.getMainWindow() as any;

    // Slice out exactly the PNG byte range. Handing `pngBytes.buffer`
    // directly to Blob would serialize the entire backing buffer (and
    // ignore non-zero `byteOffset`), corrupting the image whenever the
    // input is a view onto a larger buffer.
    const pngArrayBuffer = pngBytes.buffer.slice(
        pngBytes.byteOffset,
        pngBytes.byteOffset + pngBytes.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([pngArrayBuffer], { type: "image/png" });
    const bitmap = await win.createImageBitmap(blob);

    try {
        const canvas: any = new win.OffscreenCanvas(imageWidth, imageHeight);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not acquire 2D canvas context");

        ctx.drawImage(bitmap, 0, 0, imageWidth, imageHeight);

        const sx = imageWidth / pageWidth;
        const sy = imageHeight / pageHeight;

        ctx.lineWidth = 1;
        for (const r of rects) {
            const x = r.rect.l * sx;
            const y = r.rect.t * sy;
            const w = (r.rect.r - r.rect.l) * sx;
            const h = (r.rect.b - r.rect.t) * sy;
            ctx.fillStyle = hexToRgba(r.color, 0.18);
            ctx.fillRect(x, y, w, h);
            ctx.strokeStyle = r.color;
            ctx.strokeRect(x, y, w, h);
        }

        // Labels in a second pass so per-group identifiers stay readable
        // when rects overlap (sentences across narrow line gaps, etc.).
        const fontSize = Math.max(10, Math.round(8 * sx));
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textBaseline = "top";
        for (const r of rects) {
            if (!r.label) continue;
            const x = r.rect.l * sx;
            const y = r.rect.t * sy;
            drawLabel(ctx, r.label, x, y, fontSize, r.color);
        }

        const outBlob: Blob = await canvas.convertToBlob({ type: "image/png" });
        return new Uint8Array(await outBlob.arrayBuffer());
    } finally {
        bitmap.close?.();
    }
}

function drawLabel(
    ctx: any,
    text: string,
    x: number,
    y: number,
    fontSize: number,
    color: string,
): void {
    const padX = Math.max(2, Math.round(fontSize * 0.25));
    const padY = Math.max(1, Math.round(fontSize * 0.15));
    const metrics = ctx.measureText(text);
    const w = metrics.width + padX * 2;
    const h = fontSize + padY * 2;
    const labelY = y < h ? y : y - h;
    ctx.fillStyle = color;
    ctx.fillRect(x, labelY, w, h);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x + padX, labelY + padY);
}

/**
 * Convert `#rrggbb` to `rgba(r,g,b,a)`. Falls back to a neutral gray when
 * the input isn't a hex triplet — overlays should still render.
 */
function hexToRgba(hex: string, alpha: number): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return `rgba(128,128,128,${alpha})`;
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}
