/**
 * Overlay → SVG composite string.
 *
 * Produces an SVG document the same size as the rendered page image,
 * with rect fills + strokes + colored labels positioned in pixel space.
 * Two consumers:
 *   - Node CLI overlay: piped into `sharp(...).composite([{ input: svg }])`
 *     to paint onto the rendered page PNG.
 *   - Future browser uses: same SVG can be inlined into HTML for headless
 *     debug previews.
 *
 * Reproduces the visual contract of `react/utils/canvasOverlay.ts`:
 *   - 1px stroke in image-pixel space
 *   - fill at alpha 0.18
 *   - bold sans-serif label sized `max(10, round(8 * sx))`
 *   - label background painted in the rect color, white text
 *   - label drawn above the rect when there's room, otherwise inside it
 *
 * SVG text width estimation is approximate (no `measureText`); label
 * background rects may end up a few pixels wider/narrower than the
 * canvas version. For debug overlays that's invisible.
 */
import type { OverlayRect } from "./overlayBuilders";

const HEX_RE = /^#?([0-9a-f]{6})$/i;

function hexToRgba(hex: string, alpha: number): string {
    const m = HEX_RE.exec(hex);
    if (!m) return `rgba(128,128,128,${alpha})`;
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function escapeXml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

export interface OverlaySvgOptions {
    imageWidth: number;
    imageHeight: number;
    pageWidth: number;
    pageHeight: number;
    rects: OverlayRect[];
}

/**
 * Build a self-contained SVG string sized to `(imageWidth, imageHeight)`
 * with overlay rects + labels positioned in pixel space.
 */
export function buildOverlaySvg(opts: OverlaySvgOptions): string {
    const { imageWidth, imageHeight, pageWidth, pageHeight, rects } = opts;
    const sx = imageWidth / pageWidth;
    const sy = imageHeight / pageHeight;

    // Match the canvas overlay's font sizing.
    const fontSize = Math.max(10, Math.round(8 * sx));
    // Approximate average glyph width for bold sans-serif.
    const glyphWidth = fontSize * 0.55;
    const padX = Math.max(2, Math.round(fontSize * 0.25));
    const padY = Math.max(1, Math.round(fontSize * 0.15));

    const fillStrokeFragments: string[] = [];
    const labelFragments: string[] = [];

    for (const r of rects) {
        const x = r.rect.l * sx;
        const y = r.rect.t * sy;
        const w = (r.rect.r - r.rect.l) * sx;
        const h = (r.rect.b - r.rect.t) * sy;
        const fill = hexToRgba(r.color, 0.18);
        fillStrokeFragments.push(
            `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}" stroke="${r.color}" stroke-width="1" />`,
        );
    }

    for (const r of rects) {
        if (!r.label) continue;
        const x = r.rect.l * sx;
        const y = r.rect.t * sy;
        const labelText = escapeXml(r.label);
        const labelW = labelText.length * glyphWidth + padX * 2;
        const labelH = fontSize + padY * 2;
        // Position above the rect when there's room, otherwise inside it.
        const labelY = y < labelH ? y : y - labelH;
        // SVG uses the default alphabetic baseline (`dominant-baseline`
        // is not reliably honored by librsvg/sharp). With alphabetic
        // baseline, the `y` we pass to `<text>` is the *baseline*, and
        // glyphs extend upward by ~ascent and downward by ~descent.
        // Position the baseline near the bottom of the label background
        // so the glyph cap sits at ~labelY + padY (inside the rect).
        const textY = labelY + padY + fontSize * 0.85;
        labelFragments.push(
            `<rect x="${x.toFixed(2)}" y="${labelY.toFixed(2)}" width="${labelW.toFixed(2)}" height="${labelH.toFixed(2)}" fill="${r.color}" />`,
            `<text x="${(x + padX).toFixed(2)}" y="${textY.toFixed(2)}" font-family="sans-serif" font-weight="bold" font-size="${fontSize}" fill="#ffffff">${labelText}</text>`,
        );
    }

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}" viewBox="0 0 ${imageWidth} ${imageHeight}">` +
        fillStrokeFragments.join("") +
        labelFragments.join("") +
        `</svg>`
    );
}
