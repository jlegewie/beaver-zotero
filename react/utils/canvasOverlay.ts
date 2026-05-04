/**
 * Canvas Overlay — paint extraction bboxes onto a rendered page PNG.
 *
 * Used by the dev-only `/beaver/test/pdf-render-overlay` endpoint so an
 * agent can call:
 *   render page via MuPDF (PNG bytes) → drawBBoxOverlayPNG(...) → base64
 * and inspect the result without having a Zotero reader open.
 *
 * Runs in the chrome window — image loading + canvas drawing use the main
 * window's document (per CLAUDE.md, never bare `window`).
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
    const win = Zotero.getMainWindow();
    const doc = win.document;

    // Load the rendered PNG via a blob URL — the same pattern used in
    // fileUtils.ts (no createImageBitmap dependency).
    const blob = new Blob([pngBytes.buffer as ArrayBuffer], { type: "image/png" });
    const imageUrl = (win as any).URL.createObjectURL(blob);

    try {
        const img = await loadImage(win, imageUrl);

        const canvas = doc.createElement("canvas");
        canvas.width = imageWidth;
        canvas.height = imageHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not acquire 2D canvas context");

        ctx.drawImage(img, 0, 0, imageWidth, imageHeight);

        const sx = imageWidth / pageWidth;
        const sy = imageHeight / pageHeight;

        // Stroke+fill each rect, then layer labels on top so they don't get
        // painted over by subsequent rects.
        ctx.lineWidth = Math.max(1, Math.round(sx));
        for (const r of rects) {
            const x = r.rect.x * sx;
            const y = r.rect.y * sy;
            const w = r.rect.w * sx;
            const h = r.rect.h * sy;
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
            const x = r.rect.x * sx;
            const y = r.rect.y * sy;
            drawLabel(ctx, r.label, x, y, fontSize, r.color);
        }

        return await canvasToPngBytes(canvas);
    } finally {
        (win as any).URL.revokeObjectURL(imageUrl);
    }
}

/**
 * Promise-wrapped HTMLImageElement load. Created in the chrome window so
 * the privileged DOM honors blob URLs created in that same window.
 */
function loadImage(win: Window, src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new (win as any).Image() as HTMLImageElement;
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to load overlay base image"));
        img.src = src;
    });
}

/**
 * Draw `text` near (x, y) with a solid background patch so it stays
 * readable on any underlying image content.
 */
function drawLabel(
    ctx: CanvasRenderingContext2D,
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
    // Pin label inside the page if the rect starts at the very top edge.
    const labelY = y < h ? y : y - h;
    ctx.fillStyle = color;
    ctx.fillRect(x, labelY, w, h);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x + padX, labelY + padY);
}

/**
 * `canvas.toBlob` wrapped as a promise; returns raw PNG bytes.
 */
function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error("Canvas toBlob returned null"));
                return;
            }
            blob.arrayBuffer()
                .then((buf) => resolve(new Uint8Array(buf)))
                .catch(reject);
        }, "image/png");
    });
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
