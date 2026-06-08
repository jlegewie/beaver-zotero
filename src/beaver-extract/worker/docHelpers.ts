/**
 * Shared helpers used by every worker op. Extracted so orchestration ops
 * compose them within a single doc-open.
 *
 * Owns the MuPDF/WASM bridge: structured-text option strings, raw-page
 * normalization, image rendering, search, and page-label collection.
 */

import type {
    BoundingBox,
    RawBlock,
    RawLine,
    RawPageData,
    RawPageDataDetailed,
    RawLineDetailed,
    RawChar,
    PageGeometry,
    PDFPageSearchResult,
    PageImageResult,
} from "../types";
import { bboxFromXYWH } from "../types";
import type { RawPageProvider } from "../DocumentAnalyzer";
import type {
    CollectGraphicsOptions,
    DividerLine,
    DocumentLike,
    FillRect,
    FontApi,
    GraphicsLayerPrimitives,
    MuPDFApi,
    QuadTuple,
    RectTuple,
} from "./mupdfApi";
import { ERROR_CODES, postLog, workerError } from "./errors";
import { isRecoverablePageError } from "../wasmFatal";
import { isUnmappedTextLayer, recoveredTextIsAcceptable } from "../unmappedGlyphRecovery";
import { ensureApi } from "./wasmInit";
import {
    aspectRatioRotation,
    dirToRotation,
    type RotationAngle,
} from "../PageRotationNormalizer";

// Duplicate-redraw collapsing: some PDFs — notably OCR tools that stamp the
// invisible text layer many times per page — draw their whole text content
// dozens of times at identical coordinates. MuPDF's `collect-styles` option
// would collapse those (its `check_for_fake_bold` pass), but that pass scans
// every prior glyph for every glyph — O(n^2) per page — making normal
// documents ~7x slower to walk. `dedupOverlappingLines` (below) does the same
// collapse as a cheap O(n) post-pass instead, so `collect-styles` is
// intentionally NOT set here.
const STRUCTURED_TEXT_OPTIONS = "preserve-whitespace";
const STRUCTURED_TEXT_OPTIONS_WITH_IMAGES = "preserve-whitespace,preserve-images";
const STRUCTURED_TEXT_OPTIONS_DETAILED = "preserve-whitespace,preserve-ligatures";
const STRUCTURED_TEXT_OPTIONS_DETAILED_WITH_IMAGES =
    "preserve-whitespace,preserve-ligatures,preserve-images";

// Recovery flags for unmapped glyphs. When MuPDF cannot resolve a glyph to a
// Unicode codepoint it emits U+FFFD. These two stext options recover such
// glyphs heuristically — but both can produce wrong-but-plausible characters
// (a CID/code or a misread "C<n>" name that is not actually the codepoint), so
// the default extraction path leaves them OFF and keeps the detectable U+FFFD.
// They are applied ONLY on the targeted re-extraction of pages detected as
// unmapped text layers (see `unmappedGlyphRecovery.ts`), so ordinary pages —
// including ones with a few unmappable symbol/math glyphs — never have their
// U+FFFD silently rewritten.
//   - use-cid-for-unknown-unicode: falls back to the character code. Recovers
//     e.g. GNU Ghostscript Type 1C subsets whose builtin code IS the Latin-1
//     codepoint, where the whole text layer would otherwise be U+FFFD.
//   - use-glyph-name-for-unknown-unicode (fork-local): decodes numeric "C<n>"
//     glyph names (decimal Unicode codepoint), e.g. Acrobat Distiller 3.x.
const RECOVERY_OPTIONS = "use-cid-for-unknown-unicode,use-glyph-name-for-unknown-unicode";
function withRecoveryFlags(options: string): string {
    return `${options},${RECOVERY_OPTIONS}`;
}

export interface RenderOptionsResolved {
    scale: number;
    dpi: number;
    alpha: boolean;
    showExtras: boolean;
    format: "png" | "jpeg";
    jpegQuality: number;
}

export const DEFAULT_PAGE_IMAGE_OPTIONS: RenderOptionsResolved = {
    scale: 1.0,
    dpi: 0,
    alpha: false,
    showExtras: true,
    format: "png",
    jpegQuality: 85,
};

/** Convert a [x0, y0, x1, y1] tuple (from walk() bboxes) to a BoundingBox. */
export function tupleToBBox(t: RectTuple): BoundingBox {
    return { l: t[0], t: t[1], r: t[2], b: t[3], origin: "top-left" };
}

/** Compute an axis-aligned BoundingBox from a QuadPoint's four corners. */
export function bboxFromQuad(q: QuadTuple): BoundingBox {
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    return { l: minX, t: minY, r: maxX, b: maxY, origin: "top-left" };
}

/** Compute an axis-aligned bbox from an array of quads. */
export function bboxFromQuads(quads: QuadTuple[]): BoundingBox {
    if (!quads.length) return { l: 0, t: 0, r: 0, b: 0, origin: "top-left" };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const q of quads) {
        const [ulx, uly, urx, ury, llx, lly, lrx, lry] = q;
        minX = Math.min(minX, ulx, urx, llx, lrx);
        minY = Math.min(minY, uly, ury, lly, lry);
        maxX = Math.max(maxX, ulx, urx, llx, lrx);
        maxY = Math.max(maxY, uly, ury, lly, lry);
    }
    return { l: minX, t: minY, r: maxX, b: maxY, origin: "top-left" };
}

function jsonBBoxToBBox(bbox: { x: number; y: number; w: number; h: number }): BoundingBox {
    return bboxFromXYWH(bbox.x, bbox.y, bbox.w, bbox.h, "top-left");
}

function normalizeStructuredTextBlocks(blocks: Array<RawBlock & { bbox: any }>): RawBlock[] {
    return blocks.map((block) => {
        const normalized: RawBlock = {
            ...block,
            bbox: jsonBBoxToBBox(block.bbox),
        };
        if (block.type === "text" && block.lines) {
            normalized.lines = block.lines.map((line) => ({
                ...line,
                bbox: jsonBBoxToBBox(line.bbox as any),
            }));
        }
        return normalized;
    });
}

/**
 * Collapse page elements that are exact positional duplicates of an earlier
 * one on the same page: text lines with identical text at the same rounded
 * origin, and image blocks with the same rounded bbox.
 *
 * Some PDFs — notably OCR tools that stamp the invisible text layer many times
 * per page — draw their whole content dozens of times at identical
 * coordinates. MuPDF's structured-text walk faithfully returns every copy,
 * inflating the page 30-50x and exploding downstream memory and time. This is
 * the cheap O(n) equivalent of MuPDF's `collect-styles` fake-bold dedup (see
 * the `STRUCTURED_TEXT_OPTIONS` comment).
 *
 * Returns a new block list: duplicate lines are dropped and any block left
 * with no lines is removed. Origins are rounded to the nearest point so float
 * noise between redraws cannot defeat the match; distinct text lines on a page
 * are always more than a point apart, so normal documents pass through with
 * nothing removed.
 */
function dedupOverlappingLines(blocks: RawBlock[]): RawBlock[] {
    const seen = new Set<string>();
    const out: RawBlock[] = [];
    for (const block of blocks) {
        if (block.type === "text" && block.lines) {
            const kept = (block.lines as RawLine[]).filter((line) => {
                const key = `t:${Math.round(line.bbox.l)},${Math.round(line.bbox.t)}:${line.text}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            if (kept.length === 0) continue;
            block.lines = kept;
            out.push(block);
        } else if (block.type === "image") {
            const b = block.bbox;
            const key = `i:${Math.round(b.l)},${Math.round(b.t)},${Math.round(b.r)},${Math.round(b.b)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(block);
        } else {
            out.push(block);
        }
    }
    return out;
}

/**
 * Open a PDF document and run the encryption check. Throws workerError
 * on empty / encrypted / invalid input. Returns the open `doc` on success.
 */
export async function openDocSafe(pdfData: Uint8Array | ArrayBuffer): Promise<DocumentLike> {
    // Reject empty input before invoking the parser. A 0-byte file would
    // otherwise surface as a generic `INVALID_PDF` parser error; classify it
    // explicitly. `byteLength` covers both `Uint8Array` and `ArrayBuffer`.
    if (!pdfData || pdfData.byteLength === 0) {
        throw workerError(
            ERROR_CODES.EMPTY_DOCUMENT,
            "PDF file is empty (0 bytes)",
            { pageCount: 0 },
        );
    }

    const { Document } = await ensureApi();

    let doc: DocumentLike;
    try {
        doc = Document.openDocument(pdfData, "application/pdf");
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const lower = message.toLowerCase();
        if (lower.includes("password") || lower.includes("encrypted")) {
            throw workerError(
                ERROR_CODES.ENCRYPTED,
                "Document is encrypted and requires a password",
            );
        }
        throw workerError(
            ERROR_CODES.INVALID_PDF,
            `Failed to open PDF: ${message}`,
        );
    }

    // Encryption check — swallow API-shape failures and continue. Some
    // builds of MuPDF lack `needsPassword`; treat that as "not encrypted."
    try {
        if (typeof doc.needsPassword === "function") {
            if (doc.needsPassword()) {
                doc.destroy();
                throw workerError(
                    ERROR_CODES.ENCRYPTED,
                    "Document is encrypted and requires a password",
                );
            }
        } else {
            const enc = doc.getMetadata("encryption");
            if (enc && enc !== "" && enc !== "None") {
                doc.destroy();
                throw workerError(
                    ERROR_CODES.ENCRYPTED,
                    "Document is encrypted and requires a password",
                );
            }
        }
    } catch (e) {
        if (e && (e as { code?: string }).code === ERROR_CODES.ENCRYPTED) {
            throw e;
        }
        postLog(
            "warn",
            `[mupdf-worker] Encryption check failed, continuing: ${e}`,
        );
    }

    return doc;
}

/**
 * Alias for `openDocSafe` re-exported for the doc cache (`./docCache.ts`).
 *
 * The two names exist so call sites read intent: ops that participate in the
 * cache go through `acquireDoc` / `releaseDoc`, which internally calls
 * `openDocUncached` on a miss. Direct callers of `openDocSafe` keep
 * exclusive ownership of the returned doc and are responsible for
 * `doc.destroy()` themselves — never mix `openDocSafe` with `releaseDoc`.
 */
export const openDocUncached = openDocSafe;

/**
 * Extract a single page's structured-text JSON. Honours the
 * `includeImages` switch by selecting STRUCTURED_TEXT_OPTIONS_WITH_IMAGES.
 *
 * Critical: `DocumentAnalyzer.getDetailedOCRAnalysis` calls with
 * `{ includeImages: true }` and inspects image blocks to detect scanned-page
 * coverage. Without this branch the worker-side OCR detection silently
 * over-counts text density and misses the scanned-page case.
 */
// Single structured-text walk. Private: callers use `extractRawPageFromDoc`,
// which adds the unmapped-glyph recovery retry on top of this.
function extractRawPageOnce(
    doc: DocumentLike,
    pageIndex: number,
    opts?: { includeImages?: boolean; recoverUnmappedGlyphs?: boolean },
): RawPageData {
    const page = doc.loadPage(pageIndex);
    try {
        const pb = page.getBounds("CropBox");
        const width = pb[2] - pb[0];
        const height = pb[3] - pb[1];
        const viewBox = page.getViewBox();
        const rotation = page.getRotation();

        let label: string | undefined;
        try {
            label = page.getLabel();
        } catch (_) {
            // label not available
        }

        let stextOptions = opts?.includeImages
            ? STRUCTURED_TEXT_OPTIONS_WITH_IMAGES
            : STRUCTURED_TEXT_OPTIONS;
        if (opts?.recoverUnmappedGlyphs) stextOptions = withRecoveryFlags(stextOptions);
        const stext = page.toStructuredText(stextOptions);
        try {
            const json = JSON.parse(stext.asJSON());
            const blocks = normalizeStructuredTextBlocks(json.blocks || []);

            // Parallel walk just to capture per-line `dir` so the
            // JSON-pass lines can carry a sign-precise `rotation`
            // angle (the JSON serializer truncates bbox floats to
            // integers and never emits `dir`). Match by in-order
            // index, not by bbox key — both walks iterate the same
            // in-memory `stext` tree in identical order, so the n-th
            // text line of the n-th text block matches one-to-one.
            // Aspect-ratio fallback only fires if the parallel walk
            // somehow emits fewer lines than the JSON pass.
            const walkDirs: RotationAngle[][] = [];
            let currentBlockDirs: RotationAngle[] | null = null;
            stext.walk({
                beginTextBlock: () => {
                    currentBlockDirs = [];
                    walkDirs.push(currentBlockDirs);
                },
                endTextBlock: () => {
                    currentBlockDirs = null;
                },
                beginLine: (_bbox, _wmode, dir) => {
                    if (currentBlockDirs) {
                        currentBlockDirs.push(dirToRotation(dir[0], dir[1]));
                    }
                },
            });

            let textBlockIdx = 0;
            for (const block of blocks) {
                if (block.type !== "text") continue;
                const lines = block.lines as RawLine[] | undefined;
                const dirs = walkDirs[textBlockIdx++];
                if (!lines) continue;
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const fromDir = dirs?.[i];
                    line.rotation = fromDir ?? aspectRatioRotation(line.bbox);
                }
            }

            return {
                pageIndex,
                pageNumber: pageIndex + 1,
                width,
                height,
                viewBox,
                rotation,
                label,
                blocks: dedupOverlappingLines(blocks),
            };
        } finally {
            stext.destroy();
        }
    } finally {
        page.destroy();
    }
}

/**
 * Run the page's content stream through a JS device and collect graphics
 * primitives used by layout detection. Fill bboxes and stroked divider
 * endpoints are returned in PDF page coordinates (top-left origin).
 *
 * Used by column detection to find background-shaded display elements
 * (tinted asides, callouts, "facts" boxes). Page load + device run +
 * destroy happens in this single helper so callers don't need to
 * manage the Page lifecycle.
 *
 * **Budget.** `maxFills` and `maxStrokes` forward to `Page.collectGraphics`.
 * Each primitive kind aborts independently when its budget is exceeded,
 * returning an empty array for that kind while still preserving the other
 * side's results.
 *
 * **Failure mode.** Any error from `loadPage` / `collectGraphics` /
 * `destroy` is caught and logged at info level; the helper returns empty
 * arrays. Graphics collection is purely advisory — the downstream
 * `ColumnDetector` treats empty lists as "no graphics boundaries, run
 * legacy behavior".
 */
export function extractGraphicsFromDoc(
    doc: DocumentLike,
    pageIndex: number,
    opts?: CollectGraphicsOptions,
): GraphicsLayerPrimitives {
    let page;
    try {
        page = doc.loadPage(pageIndex);
    } catch (err) {
        postLog(
            "info",
            `extractGraphicsFromDoc: loadPage ${pageIndex} failed: ${String(err)}`,
        );
        return { fills: [], strokes: [] };
    }
    try {
        if (typeof page.collectGraphics === "function") {
            return page.collectGraphics(opts);
        }
        return {
            fills: page.collectFilledRects(opts?.maxFills),
            strokes: [],
        };
    } catch (err) {
        postLog(
            "info",
            `extractGraphicsFromDoc: collectGraphics ${pageIndex} failed: ${String(err)}`,
        );
        return { fills: [], strokes: [] };
    } finally {
        try {
            page.destroy();
        } catch (_) {
            // best-effort cleanup
        }
    }
}

export function extractFilledRectsFromDoc(
    doc: DocumentLike,
    pageIndex: number,
    maxFills?: number,
): FillRect[] {
    return extractGraphicsFromDoc(doc, pageIndex, { maxFills, maxStrokes: 0 }).fills;
}

export function extractStrokedLinesFromDoc(
    doc: DocumentLike,
    pageIndex: number,
    maxStrokes?: number,
): DividerLine[] {
    return extractGraphicsFromDoc(doc, pageIndex, { maxFills: 0, maxStrokes }).strokes;
}

const WHITE_THRESHOLD = 0.97;
const INK_THRESHOLD = 0.03;

export function isNearWhiteOrNoInk(color: number[], colorspaceType: number): boolean {
    switch (colorspaceType) {
        case 1: // Gray
        case 2: // RGB
        case 3: // BGR
            return color.length > 0 && color.every((c) => c >= WHITE_THRESHOLD);
        case 4: // CMYK
            return color.length > 0 && color.every((c) => c <= INK_THRESHOLD);
        case 7: // Separation
        case 8: // DeviceN
            return color.length > 0 && color.every((c) => c <= INK_THRESHOLD);
        default:
            return false;
    }
}

/**
 * Filter raw `FillRect` events down to bboxes suitable for use as
 * column-detection boundaries.
 *
 * Goal: keep fills that look like a "container" for a group of text
 * lines (tinted aside box, callout, sidebar) and drop everything else
 * (page background, hairline rules, tiny graphics, glyph paths). The
 * column detector treats each kept rect as a zone — text inside it must
 * not merge with text outside.
 *
 * Filters (applied in order):
 *   1. Drop fills with alpha ≤ 0 (invisible).
 *   2. Drop fills whose bbox area is < `MIN_FILL_AREA` pt²
 *      (default 30×30 = 900pt²) — skips icons, page-number underlines,
 *      paragraph rules.
 *   3. Drop fills that cover ≥ `MAX_PAGE_COVERAGE` of the page area
 *      (default 90 %) — these are page backgrounds, not display
 *      elements.
 *   4. Drop fills that are pure white / near-white. Colorspace-aware:
 *      - Gray (csType 1) / RGB (2, 3): max-component ≥ `WHITE_THRESHOLD`
 *        (i.e., all components close to 1) is white.
 *      - CMYK (4): all components ≤ `INK_THRESHOLD` is white.
 *      - Separation (7) / DeviceN (8): all components ≤ `INK_THRESHOLD`
 *        is no-ink (white). Separation with `color=[1]` is full
 *        saturation of a typically-tinted plate, so this fires "kept".
 *      - Unknown colorspaces: kept by default (let downstream decide).
 *   5. Path shape — `isAxisAlignedRect` only. Curved or multi-subpath
 *      filled shapes are typically logos / illustrations, not aside
 *      boxes; the column detector wouldn't know what to do with their
 *      bboxes anyway.
 */
export function filterToContainerRects(
    fills: FillRect[],
    pageWidth: number,
    pageHeight: number,
): Array<{ x: number; y: number; w: number; h: number }> {
    const MIN_FILL_AREA = 900; // 30pt × 30pt
    const MAX_PAGE_COVERAGE = 0.9;

    const pageArea = pageWidth * pageHeight;
    const out: Array<{ x: number; y: number; w: number; h: number }> = [];

    for (const f of fills) {
        if (f.alpha <= 0) continue;
        if (!f.isAxisAlignedRect) continue;

        const [x0, y0, x1, y1] = f.bbox;
        const w = x1 - x0;
        const h = y1 - y0;
        if (w <= 0 || h <= 0) continue;
        const area = w * h;
        if (area < MIN_FILL_AREA) continue;
        if (pageArea > 0 && area >= MAX_PAGE_COVERAGE * pageArea) continue;

        if (isNearWhiteOrNoInk(f.color, f.colorspaceType)) continue;

        out.push({ x: x0, y: y0, w, h });
    }

    return out;
}

export function filterToDividerLines(
    strokes: DividerLine[],
    pageWidth: number,
    pageHeight: number,
): Array<{
    orientation: "horizontal" | "vertical";
    position: number;
    start: number;
    end: number;
    thickness: number;
}> {
    const MAX_THICKNESS = 2;
    const MIN_SPAN_RATIO = 0.5;
    const out: Array<{
        orientation: "horizontal" | "vertical";
        position: number;
        start: number;
        end: number;
        thickness: number;
    }> = [];

    for (const stroke of strokes) {
        if (stroke.alpha <= 0) continue;
        if (stroke.thickness <= 0 || stroke.thickness > MAX_THICKNESS) continue;
        if (isNearWhiteOrNoInk(stroke.color, stroke.colorspaceType)) continue;

        if (stroke.orientation === "horizontal") {
            const y = (stroke.a[1] + stroke.b[1]) / 2;
            const start = Math.min(stroke.a[0], stroke.b[0]);
            const end = Math.max(stroke.a[0], stroke.b[0]);
            if (end - start < MIN_SPAN_RATIO * pageWidth) continue;
            out.push({
                orientation: "horizontal",
                position: y,
                start,
                end,
                thickness: stroke.thickness,
            });
        } else {
            const x = (stroke.a[0] + stroke.b[0]) / 2;
            const start = Math.min(stroke.a[1], stroke.b[1]);
            const end = Math.max(stroke.a[1], stroke.b[1]);
            if (end - start < MIN_SPAN_RATIO * pageHeight) continue;
            out.push({
                orientation: "vertical",
                position: x,
                start,
                end,
                thickness: stroke.thickness,
            });
        }
    }

    return out;
}

/**
 * Derive a `family` string from a raw PostScript font name, mirroring
 * how the JSON walker normalizes it (strips style suffixes like Bold,
 * Italic, Oblique, the `MT`/`PS` PostScript tags, and anything after the
 * first comma). Returns the raw name unchanged when the regex strips
 * everything.
 */
function deriveFontFamily(name: string): string {
    return (
        name
            .split(",")[0]
            .replace(/(?:[-+])?(?:Bold|Italic|Oblique|Regular|MT|PS).*$/i, "")
            .trim() || name
    );
}

/**
 * Extract detailed (character-level) page data, including per-character
 * quad and bbox metadata.
 *
 * `fontApi` is required to populate line `font.name` / `family` /
 * `weight` / `style`. Without it (or in test contexts where the WASM
 * font helpers aren't available) the per-line `font` falls back to
 * empty defaults — every text line ends up with `name: ""`, breaking
 * style-based heading detection downstream. The structured extract
 * passes the live API; debug paths must do the same.
 */
// Single detailed (per-char) walk. Private: callers use
// `extractRawPageDetailedFromDoc`, which adds the unmapped-glyph recovery retry.
function extractRawPageDetailedOnce(
    doc: DocumentLike,
    pageIndex: number,
    includeImages: boolean,
    fontApi?: FontApi,
    recoverUnmappedGlyphs?: boolean,
): RawPageDataDetailed {
    const page = doc.loadPage(pageIndex);
    try {
        const pb = page.getBounds("CropBox");
        const width = pb[2] - pb[0];
        const height = pb[3] - pb[1];
        const viewBox = page.getViewBox();
        const rotation = page.getRotation();

        let label: string | undefined;
        try {
            label = page.getLabel();
        } catch (_) {
            // label not available
        }

        let stextOptions = includeImages
            ? STRUCTURED_TEXT_OPTIONS_DETAILED_WITH_IMAGES
            : STRUCTURED_TEXT_OPTIONS_DETAILED;
        if (recoverUnmappedGlyphs) stextOptions = withRecoveryFlags(stextOptions);
        const stext = page.toStructuredText(stextOptions);

        const blocks: RawBlock[] = [];
        let currentBlock: (RawBlock & { type: "text"; lines: RawLineDetailed[] }) | null = null;
        let currentLine: RawLineDetailed | null = null;

        // Memoize per-fontPtr lookups. A typical text-heavy page has
        // thousands of chars sharing a handful of fonts; without caching
        // we'd pay one wasm call per char per attribute.
        type CachedFont = {
            name: string;
            family: string;
            weight: "bold" | "normal";
            style: "italic" | "normal";
        };
        const fontCache = new Map<number, CachedFont>();
        const lookupFont = (fontPtr: number): CachedFont => {
            const cached = fontCache.get(fontPtr);
            if (cached) return cached;
            let entry: CachedFont;
            if (fontApi && fontPtr) {
                const name = fontApi.getName(fontPtr);
                entry = {
                    name,
                    family: deriveFontFamily(name),
                    weight: fontApi.isBold(fontPtr) ? "bold" : "normal",
                    style: fontApi.isItalic(fontPtr) ? "italic" : "normal",
                };
            } else {
                entry = { name: "", family: "", weight: "normal", style: "normal" };
            }
            fontCache.set(fontPtr, entry);
            return entry;
        };

        try {
            stext.walk({
                beginTextBlock: (bbox) => {
                    currentBlock = {
                        type: "text",
                        bbox: tupleToBBox(bbox),
                        lines: [],
                    };
                },
                endTextBlock: () => {
                    if (currentBlock) {
                        blocks.push(currentBlock);
                        currentBlock = null;
                    }
                },
                beginLine: (bbox, wmode, dir) => {
                    currentLine = {
                        wmode,
                        bbox: tupleToBBox(bbox),
                        font: {
                            name: "",
                            family: "",
                            weight: "normal",
                            style: "normal",
                            size: 0,
                        },
                        x: bbox[0],
                        y: bbox[1],
                        text: "",
                        // Snap MuPDF's writing-direction vector to the
                        // nearest cardinal so downstream rotation
                        // normalization gets a stable, sign-precise
                        // angle. See `PageRotationNormalizer`.
                        rotation: dirToRotation(dir[0], dir[1]),
                        chars: [] as RawChar[],
                    } as RawLineDetailed;
                },
                endLine: () => {
                    if (currentLine && currentBlock) {
                        currentBlock.lines.push(currentLine);
                    }
                    currentLine = null;
                },
                onLineFont: (fontPtr, size) => {
                    if (!currentLine) return;
                    const f = lookupFont(typeof fontPtr === "number" ? fontPtr : 0);
                    currentLine.font = {
                        name: f.name,
                        family: f.family,
                        weight: f.weight,
                        style: f.style,
                        // Mirror the JSON walker's `(int)size` truncation
                        // (`extractRawPageFromDoc` -> `stext.asJSON()`).
                        // Without this, body text reported as 9.96 here
                        // rounds to 10 while the same text on JSON-walk
                        // pages rounds to 9, breaking body-style
                        // matching when the detailed page is substituted
                        // into a JSON-walk analysis window.
                        size: typeof size === "number" ? Math.trunc(size) : 0,
                    };
                },
                onChar: (rune, quad) => {
                    if (!currentLine) return;
                    currentLine.text += rune;
                    currentLine.chars.push({
                        c: rune,
                        quad,
                        bbox: bboxFromQuad(quad),
                    } as RawChar);
                },
                onImageBlock: (bbox) => {
                    if (includeImages) {
                        blocks.push({
                            type: "image",
                            bbox: tupleToBBox(bbox),
                        } as RawBlock);
                    }
                },
            });
        } finally {
            stext.destroy();
        }

        return {
            pageIndex,
            pageNumber: pageIndex + 1,
            width,
            height,
            viewBox,
            rotation,
            label,
            blocks: dedupOverlappingLines(blocks),
        } as RawPageDataDetailed;
    } finally {
        page.destroy();
    }
}

/** Render a single page to PNG/JPEG. */
export function renderOnePage(
    api: MuPDFApi,
    doc: DocumentLike,
    pageIndex: number,
    opts: RenderOptionsResolved,
): PageImageResult {
    const { Matrix, ColorSpace } = api;
    const scale = opts.dpi > 0 ? opts.dpi / 72 : opts.scale;
    const effectiveDpi = opts.dpi > 0 ? opts.dpi : opts.scale * 72;

    const page = doc.loadPage(pageIndex);
    try {
        const matrix = Matrix.scale(scale, scale);
        const pixmap = page.toPixmap(
            matrix,
            ColorSpace.DeviceRGB,
            opts.alpha,
            opts.showExtras,
        );
        try {
            const width = pixmap.getWidth();
            const height = pixmap.getHeight();
            let data: Uint8Array;
            let format: "png" | "jpeg" = opts.format;
            if (opts.format === "jpeg") {
                data = pixmap.asJPEG(opts.jpegQuality);
            } else {
                data = pixmap.asPNG();
                format = "png";
            }
            return {
                pageIndex,
                data,
                format,
                width,
                height,
                scale,
                dpi: effectiveDpi,
            };
        } finally {
            pixmap.destroy();
        }
    } finally {
        page.destroy();
    }
}

/** Search a single page for a literal phrase; returns hits with QuadPoints. */
export function searchPageInDoc(
    doc: DocumentLike,
    pageIndex: number,
    query: string,
    maxHits: number,
): PDFPageSearchResult {
    const page = doc.loadPage(pageIndex);
    try {
        const pb = page.getBounds("CropBox");
        const width = pb[2] - pb[0];
        const height = pb[3] - pb[1];

        let label: string | undefined;
        try {
            label = page.getLabel();
        } catch (_) {
            // label not available
        }

        const searchResults = page.search(query, maxHits);
        const hits = searchResults.map((quads) => ({
            quads,
            bbox: bboxFromQuads(quads),
        }));

        return {
            pageIndex,
            label,
            matchCount: hits.length,
            hits,
            width,
            height,
        } as PDFPageSearchResult;
    } finally {
        page.destroy();
    }
}

/**
 * Read cheap document-level info-dict fields via `doc.getMetadata`.
 *
 * Each lookup is a string read from the PDF trailer/info dictionary —
 * no page loading or content parsing. Missing keys come back as
 * undefined/empty and are dropped from the result so callers can
 * spread the object without overwriting with empties.
 *
 * Mirrors MuPDF's standard metadata key naming (`format`, `info:Title`,
 * `info:Author`, etc.).
 */
export function collectDocumentInfo(doc: DocumentLike): {
    format?: string;
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
    creator?: string;
    producer?: string;
    creationDate?: string;
    modDate?: string;
} {
    const read = (key: string): string | undefined => {
        try {
            const v = doc.getMetadata(key);
            return v && v.length > 0 ? v : undefined;
        } catch {
            return undefined;
        }
    };
    const info: ReturnType<typeof collectDocumentInfo> = {};
    const format = read("format");
    if (format) info.format = format;
    const title = read("info:Title");
    if (title) info.title = title;
    const author = read("info:Author");
    if (author) info.author = author;
    const subject = read("info:Subject");
    if (subject) info.subject = subject;
    const keywords = read("info:Keywords");
    if (keywords) info.keywords = keywords;
    const creator = read("info:Creator");
    if (creator) info.creator = creator;
    const producer = read("info:Producer");
    if (producer) info.producer = producer;
    const creationDate = read("info:CreationDate");
    if (creationDate) info.creationDate = creationDate;
    const modDate = read("info:ModDate");
    if (modDate) info.modDate = modDate;
    return info;
}

/** Collect every page's label into a record keyed by 0-based page index. */
export function collectPageLabels(doc: DocumentLike): Record<number, string> {
    const count = doc.countPages();
    const labels: Record<number, string> = {};
    for (let i = 0; i < count; i++) {
        let page;
        try {
            page = doc.loadPage(i);
        } catch (err) {
            // A malformed page tree can claim `count` pages yet fail to
            // resolve some leaves. Skip the bad index and keep going so one
            // unresolvable page does not abort label collection (and, via
            // `opExtract`, the whole document).
            if (!isRecoverablePageError(err)) throw err;
            postLog(
                "warn",
                `[mupdf-worker] collectPageLabels: skipping unresolvable page ${i}: ${String(err)}`,
            );
            continue;
        }
        try {
            const label = page.getLabel();
            if (label) labels[i] = label;
        } catch (_) {
            // label not available
        } finally {
            page.destroy();
        }
    }
    return labels;
}

/**
 * Collect per-page labels and viewer geometry in one page-tree sweep.
 */
export function collectPagesData(doc: DocumentLike): {
    pageLabels: Record<number, string>;
    pages: (PageGeometry | null)[];
} {
    const count = doc.countPages();
    const pageLabels: Record<number, string> = {};
    const pages: (PageGeometry | null)[] = new Array(count).fill(null);

    for (let i = 0; i < count; i++) {
        let page;
        try {
            page = doc.loadPage(i);
        } catch (err) {
            if (!isRecoverablePageError(err)) throw err;
            postLog(
                "warn",
                `[mupdf-worker] collectPagesData: skipping unresolvable page ${i}: ${String(err)}`,
            );
            continue;
        }
        try {
            try {
                const label = page.getLabel();
                if (label) pageLabels[i] = label;
            } catch (_) {
                // label not available
            }
            const viewBox = page.getViewBox();
            pages[i] = {
                viewBox,
                width: viewBox[2] - viewBox[0],
                height: viewBox[3] - viewBox[1],
                rotation: page.getRotation(),
            };
        } finally {
            page.destroy();
        }
    }

    return { pageLabels, pages };
}

/**
 * Resolve `pageIndices` to a concrete in-bounds list. An empty/undefined
 * `pageIndices` means "all pages"; explicit indices are silently filtered
 * to those in range.
 */
export function resolvePageIndices(pageCount: number, pageIndices?: number[]): number[] {
    return pageIndices && pageIndices.length
        ? pageIndices.filter((i) => i >= 0 && i < pageCount)
        : Array.from({ length: pageCount }, (_, i) => i);
}

/**
 * Throw a classified error when an opened document resolves to no pages.
 *
 * A structurally broken PDF (e.g. an unrepairable xref) can still open
 * successfully yet resolve to 0 pages. Without this guard the extraction
 * ops fail with a raw, unclassified internal error (the OCR gate's plain
 * `Error`, or `resolveAnalysisPages`'s `RangeError`). Call this right
 * after the page count is resolved, before any per-page work.
 *
 * The `{ pageCount: 0 }` payload mirrors PAGE_OUT_OF_RANGE so the
 * MuPDFWorkerClient rehydrator can populate `ExtractionError.pageCount`,
 * which handlers surface as the response's `total_pages` field.
 */
export function assertDocumentHasPages(pageCount: number): void {
    if (!Number.isInteger(pageCount) || pageCount <= 0) {
        throw workerError(
            ERROR_CODES.EMPTY_DOCUMENT,
            "Document has no extractable pages — it may be empty or have a corrupt structure",
            { pageCount: 0 },
        );
    }
}

/**
 * Strict variant of resolvePageIndices for fused ops that defer range
 * validation to the worker.
 *
 * Semantics:
 *  - undefined OR empty array            → returns all pages
 *  - non-empty list, all indices invalid → throws PAGE_OUT_OF_RANGE
 *  - non-empty list, some valid          → returns filtered list
 *
 * Treats undefined and `[]` identically so a caller passing an empty list as
 * a "no filter" sentinel is not punished. Filter requires Number.isInteger
 * because structured-clone passes NaN/0.5/Infinity through and
 * `0.5 >= 0 && 0.5 < pageCount` is true.
 *
 * Throws workerError(PAGE_OUT_OF_RANGE, msg, { pageCount }) so the
 * MuPDFWorkerClient rehydrator can populate ExtractionError.pageCount,
 * which the handler maps into the response's `total_pages` field.
 */
export function resolveExplicitPageIndicesOrThrow(
    pageCount: number,
    pageIndices: number[] | undefined,
): number[] {
    if (!pageIndices || pageIndices.length === 0) {
        return Array.from({ length: pageCount }, (_, i) => i);
    }
    const filtered = pageIndices.filter(
        (i) => Number.isInteger(i) && i >= 0 && i < pageCount,
    );
    if (filtered.length === 0) {
        throw workerError(
            ERROR_CODES.PAGE_OUT_OF_RANGE,
            `All requested page indices are out of range or non-integer (document has ${pageCount} pages)`,
            { pageCount },
        );
    }
    return filtered;
}

/**
 * Resolve a (startIndex, endIndex?, maxPages?) tuple to a concrete index list.
 * - startIndex 0-based, inclusive. Must be a non-negative integer.
 * - endIndex 0-based, inclusive. When provided, must be a non-negative integer >= startIndex.
 *   When undefined, defaults to pageCount-1.
 * - maxPages clamps the resulting span. When provided, must be a positive integer.
 *
 * Throws workerError(PAGE_OUT_OF_RANGE, msg, { pageCount }) for ANY of:
 *   - non-integer or negative startIndex
 *   - non-integer or negative endIndex
 *   - non-positive-integer maxPages
 *   - endIndex < startIndex
 *   - startIndex >= pageCount  (entire range past document end)
 *   - resolved span is empty after clamping
 *
 * The pageCount payload lets the handler populate response `total_pages`
 * instead of returning null in the error path.
 */
export function resolvePageRangeOrThrow(
    pageCount: number,
    range: { startIndex: number; endIndex?: number; maxPages?: number },
): number[] {
    const { startIndex, endIndex, maxPages } = range;
    if (!Number.isInteger(startIndex) || startIndex < 0) {
        throw workerError(
            ERROR_CODES.PAGE_OUT_OF_RANGE,
            `Start index ${startIndex} is invalid (must be a non-negative integer)`,
            { pageCount },
        );
    }
    if (endIndex != null && (!Number.isInteger(endIndex) || endIndex < 0)) {
        throw workerError(
            ERROR_CODES.PAGE_OUT_OF_RANGE,
            `End index ${endIndex} is invalid (must be a non-negative integer)`,
            { pageCount },
        );
    }
    if (maxPages != null && (!Number.isInteger(maxPages) || maxPages <= 0)) {
        throw workerError(
            ERROR_CODES.PAGE_OUT_OF_RANGE,
            `maxPages ${maxPages} is invalid (must be a positive integer)`,
            { pageCount },
        );
    }
    if (endIndex != null && endIndex < startIndex) {
        throw workerError(
            ERROR_CODES.PAGE_OUT_OF_RANGE,
            `End index ${endIndex} is before start index ${startIndex}`,
            { pageCount },
        );
    }
    if (startIndex >= pageCount) {
        throw workerError(
            ERROR_CODES.PAGE_OUT_OF_RANGE,
            `Start index ${startIndex} is out of range (document has ${pageCount} pages)`,
            { pageCount },
        );
    }
    let lastIndex = endIndex != null ? Math.min(endIndex, pageCount - 1) : pageCount - 1;
    if (maxPages != null) {
        lastIndex = Math.min(lastIndex, startIndex + maxPages - 1);
    }
    if (lastIndex < startIndex) {
        // Defensive: should not happen given prior checks.
        throw workerError(
            ERROR_CODES.PAGE_OUT_OF_RANGE,
            `Resolved page range is empty`,
            { pageCount },
        );
    }
    return Array.from({ length: lastIndex - startIndex + 1 }, (_, i) => startIndex + i);
}

/**
 * Return the document's true, loadable page count.
 *
 * `doc.countPages()` reports `/Root/Pages/Count` verbatim. In a corrupt
 * or truncated PDF that value can exceed the number of pages the page
 * tree can actually resolve — MuPDF only reconciles `Count` with reality
 * the first time it walks the page tree (it then rewrites `Count` to the
 * number of pages actually found). Loading any page forces that walk, so
 * a throwaway `loadPage(0)` makes the subsequent `countPages()` reflect
 * the pages that can really be read.
 *
 * Without this, a document claiming 24 pages but holding 7 drives the
 * extractor to `loadPage(7)`, which throws `invalid page number` and
 * aborts the whole extraction instead of returning the 7 real pages.
 */
export function resolveTruePageCount(doc: DocumentLike): number {
    try {
        const page = doc.loadPage(0);
        page.destroy();
    } catch (err) {
        // A page-tree resolution failure still ran the tree walk (and its
        // Count correction), so countPages() below is valid even though page
        // 0 itself is unloadable — swallow it. Any other failure (WASM trap,
        // heap exhaustion) leaves the MuPDF runtime unusable; rethrow so the
        // caller aborts and discards the document, matching how every other
        // page-load site treats non-recoverable errors.
        if (!isRecoverablePageError(err)) throw err;
    }
    return doc.countPages();
}

/**
 * Build a RawPageProvider over an open Document. Lets DocumentAnalyzer
 * run inside the worker against an already-open `doc` (no extra opens).
 *
 * The page count is resolved once via `resolveTruePageCount` (not raw
 * `doc.countPages()`): a corrupt or truncated PDF can advertise more
 * pages in `/Root/Pages/Count` than its page tree can resolve, and
 * `DocumentAnalyzer` samples page indices across that count.
 */
// Unmapped-glyph recovery, applied by DEFAULT on every page walk.
//
// After removing `use-cid-for-unknown-unicode` from the default stext options,
// a page from a CID/glyph-name-fallback PDF would otherwise extract as runs of
// U+FFFD. These two public extractors transparently recover such pages so EVERY
// caller (extraction pipeline, layout analysis, OCR gate, sentence extraction,
// search) gets consistent text — there is no "forgot to route through recovery"
// path. A page is walked once (honest U+FFFD); only when its text layer is
// present but overwhelmingly unmapped is it re-walked with the recovery options
// on, and that result is kept only when it resolved the unknown glyphs and reads
// like natural language. Otherwise the original is kept so the OCR gate still
// sees the unmapped layer. The retry is rare (normal pages never cross the
// threshold), so the common-case cost is one walk plus a cheap string scan. See
// `unmappedGlyphRecovery.ts`.

/** Extract a page's JSON-walk data, recovering an unmapped text layer when present. */
export function extractRawPageFromDoc(
    doc: DocumentLike,
    pageIndex: number,
    opts?: { includeImages?: boolean },
): RawPageData {
    const page = extractRawPageOnce(doc, pageIndex, opts);
    if (!isUnmappedTextLayer(page)) return page;
    const recovered = extractRawPageOnce(doc, pageIndex, {
        ...opts,
        recoverUnmappedGlyphs: true,
    });
    if (!recoveredTextIsAcceptable(recovered)) return page;
    postLog("info", `Recovered unmapped text layer on page ${pageIndex}`);
    return recovered;
}

/** Extract a page's detailed-walk data, recovering an unmapped text layer when present. */
export function extractRawPageDetailedFromDoc(
    doc: DocumentLike,
    pageIndex: number,
    includeImages: boolean,
    fontApi?: FontApi,
): RawPageDataDetailed {
    const page = extractRawPageDetailedOnce(doc, pageIndex, includeImages, fontApi);
    if (!isUnmappedTextLayer(page)) return page;
    const recovered = extractRawPageDetailedOnce(doc, pageIndex, includeImages, fontApi, true);
    if (!recoveredTextIsAcceptable(recovered)) return page;
    postLog("info", `Recovered unmapped text layer on page ${pageIndex}`);
    return recovered;
}

export function rawPageProviderFromDoc(doc: DocumentLike): RawPageProvider {
    const pageCount = resolveTruePageCount(doc);
    return {
        getPageCount: () => pageCount,
        extractRawPage: (i, opts) => extractRawPageFromDoc(doc, i, opts),
    };
}
