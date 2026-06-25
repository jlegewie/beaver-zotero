/**
 * Image Processing — decode, downscale, and re-encode raster images for
 * agent vision requests.
 *
 * Takes raw bytes + MIME type (no Zotero-item coupling) so any caller that
 * can read a file — attachment handlers today, external image files later —
 * can produce a vision-ready PNG/JPEG.
 *
 * Decoding uses `createImageBitmap` + `OffscreenCanvas` on the main window
 * (both available in Zotero's main window). `<img>`/`<canvas>` elements are
 * avoided because the main window is XUL, where `document.head` is null and
 * element-based image loading fails.
 */

import { logger } from '../../utils/logger';

/** Default maximum output dimension (longest edge) in pixels. */
export const DEFAULT_MAX_IMAGE_DIMENSION = 1568;

/**
 * Hard cap for requested output dimensions. Prevents a request from forcing
 * very large canvas allocations.
 */
export const HARD_MAX_IMAGE_DIMENSION = 4096;

/**
 * Maximum decoded image size in pixels (width × height). Enforced from
 * header-declared dimensions before decode when possible, and from bitmap
 * dimensions after decode as a backstop. The source file-size limit is no
 * guard here — small compressed files can decode to enormous bitmaps.
 */
export const MAX_DECODED_PIXELS = 64_000_000;

/**
 * Maximum encoded output size in raw bytes. Base64 expands by 4/3, so this
 * keeps the wire payload safely under vision-API per-image limits.
 */
export const MAX_OUTPUT_IMAGE_BYTES = Math.floor(3.5 * 1024 * 1024);

/**
 * Image formats Firefox has no decoder for. Rejected deterministically
 * before decode so callers get an actionable error instead of a generic
 * decode failure. SVG is rejected because createImageBitmap does not
 * support SVG blobs in Firefox; rasterization is a possible future path.
 */
const KNOWN_UNDECODABLE_MIMES = new Set([
    'image/tiff',
    'image/x-tiff',
    'image/tif',
    'image/x-tif',
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/jxl',
    'image/svg+xml',
    'image/vnd.adobe.photoshop',
    'image/x-photoshop',
]);

/** Thrown when the image format is known to be undecodable in this runtime. */
export class UnsupportedImageFormatError extends Error {
    constructor(public readonly mimeType: string) {
        super(`Unsupported image format: ${mimeType}`);
        this.name = 'UnsupportedImageFormatError';
    }
}

/** Thrown when the image bytes cannot be decoded (corrupt/truncated file). */
export class ImageDecodeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ImageDecodeError';
    }
}

/** Thrown on resize/encode failures and exceeded pixel/byte limits. */
export class ImageProcessingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ImageProcessingError';
    }
}

export interface ProcessImageOptions {
    /** Maximum output width in pixels. Never upscales. */
    maxWidth: number;
    /** Maximum output height in pixels. Never upscales. */
    maxHeight: number;
    /** Output format; 'auto' keeps the source family (jpeg→jpeg, else png). */
    format: 'png' | 'jpeg' | 'auto';
    /** JPEG quality 1-100. */
    jpegQuality: number;
    /** Raw (pre-base64) output byte budget. */
    maxOutputBytes: number;
    /**
     * Invoked between processing phases (decode, each resize pass, each
     * encode, budget retries). Callers pass a deadline check that throws to
     * abort processing mid-flight.
     */
    checkpoint?: (phase: string) => void;
}

export interface ProcessedImage {
    data: Uint8Array;
    format: 'png' | 'jpeg';
    width: number;
    height: number;
    /** Source dimensions after EXIF orientation. */
    originalWidth: number;
    originalHeight: number;
    /** The MIME type that was actually decoded (sniffed from bytes). */
    sourceMime: string;
    /** True when output dimensions differ from the source. */
    resized: boolean;
    /** True when the output MIME type differs from the source MIME type. */
    converted: boolean;
}

/** Convert raw bytes to base64 in 32 KB chunks to avoid call-stack limits. */
export function uint8ToBase64(bytes: Uint8Array): string {
    const CHUNK_SIZE = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, i + CHUNK_SIZE);
        binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    return btoa(binary);
}

function startsWithAscii(bytes: Uint8Array, ascii: string, offset = 0): boolean {
    if (bytes.length < offset + ascii.length) return false;
    for (let i = 0; i < ascii.length; i++) {
        if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
    }
    return true;
}

/**
 * Detect SVG by content: skip a UTF-8 BOM and leading whitespace, then look
 * for a leading `<svg` tag, or an XML preamble followed by `<svg` within the
 * first kilobyte. Needed because SVGs stored under a wrong binary MIME type
 * would otherwise fall through to decode and fail confusingly.
 */
function sniffSvg(bytes: Uint8Array): boolean {
    let i = 0;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        i = 3;
    }
    while (i < bytes.length) {
        const b = bytes[i];
        if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) i++;
        else break;
    }
    if (startsWithAscii(bytes, '<svg', i)) return true;
    if (startsWithAscii(bytes, '<?xml', i)) {
        const limit = Math.min(bytes.length - 4, i + 1024);
        for (let j = i; j <= limit; j++) {
            if (startsWithAscii(bytes, '<svg', j)) return true;
        }
    }
    return false;
}

/**
 * Sniff the image MIME type from magic bytes, falling back to the declared
 * MIME when the bytes are not recognized. A successful sniff wins over the
 * declared type — attachment content types can be missing or wrong.
 */
export function sniffImageMimeType(
    bytes: Uint8Array,
    declaredMime: string | null,
): string | null {
    const declared = declaredMime ? declaredMime.toLowerCase() : null;
    if (bytes.length >= 12) {
        if (
            bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
            && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
        ) {
            return 'image/png';
        }
        if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
            return 'image/jpeg';
        }
        if (startsWithAscii(bytes, 'GIF8')) {
            return 'image/gif';
        }
        if (startsWithAscii(bytes, 'RIFF') && startsWithAscii(bytes, 'WEBP', 8)) {
            return 'image/webp';
        }
        if (startsWithAscii(bytes, 'BM')) {
            return 'image/bmp';
        }
        if (
            (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
            || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
        ) {
            return 'image/tiff';
        }
        if (startsWithAscii(bytes, 'ftyp', 4)) {
            const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
            if (brand === 'avif' || brand === 'avis') return 'image/avif';
            if (['heic', 'heix', 'hevc', 'hevx', 'heif', 'mif1', 'msf1'].includes(brand)) {
                return 'image/heic';
            }
        }
    }
    if (sniffSvg(bytes)) {
        return 'image/svg+xml';
    }
    return declared;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
    return (
        (bytes[offset] << 24) | (bytes[offset + 1] << 16)
        | (bytes[offset + 2] << 8) | bytes[offset + 3]
    ) >>> 0;
}

function readU16BE(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU16LE(bytes: Uint8Array, offset: number): number {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
    return (
        bytes[offset] | (bytes[offset + 1] << 8)
        | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)
    ) >>> 0;
}

function readI32LE(bytes: Uint8Array, offset: number): number {
    return bytes[offset] | (bytes[offset + 1] << 8)
        | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

function parseJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
    // Walk marker segments after SOI; the first SOFn frame header carries
    // the image dimensions. DHT (C4), JPG (C8), and DAC (CC) share the SOF
    // numeric range but are not frame markers.
    let i = 2;
    while (i + 3 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        // Skip fill bytes
        while (i < bytes.length && bytes[i] === 0xff) i++;
        if (i >= bytes.length) return null;
        const marker = bytes[i];
        i++;
        // Standalone markers without a length field
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
        if (i + 1 >= bytes.length) return null;
        const segmentLength = readU16BE(bytes, i);
        if (segmentLength < 2) return null;
        const isSof = marker >= 0xc0 && marker <= 0xcf
            && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
            if (i + 6 >= bytes.length) return null;
            const height = readU16BE(bytes, i + 3);
            const width = readU16BE(bytes, i + 5);
            return { width, height };
        }
        i += segmentLength;
    }
    return null;
}

function parseWebpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
    if (bytes.length < 30) return null;
    const fourCC = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (fourCC === 'VP8X') {
        // Extended header: 24-bit canvas dimensions minus one
        const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return { width, height };
    }
    if (fourCC === 'VP8 ') {
        // Lossy frame header: sync code 9D 01 2A then 14-bit dimensions
        if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
        const width = readU16LE(bytes, 26) & 0x3fff;
        const height = readU16LE(bytes, 28) & 0x3fff;
        return { width, height };
    }
    if (fourCC === 'VP8L') {
        // Lossless: signature byte then two 14-bit dimensions minus one
        if (bytes[20] !== 0x2f) return null;
        const bits = readU32LE(bytes, 21);
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >> 14) & 0x3fff) + 1;
        return { width, height };
    }
    return null;
}

/**
 * Parse image dimensions from format headers without decoding. Returns null
 * when the header cannot be parsed (truncated, or a format without a simple
 * fixed header such as AVIF) — callers then fall back to post-decode checks.
 */
export function parseImageDimensions(
    bytes: Uint8Array,
    mime: string,
): { width: number; height: number } | null {
    try {
        switch (mime) {
            case 'image/png':
            case 'image/apng': {
                if (bytes.length < 24) return null;
                if (!startsWithAscii(bytes, 'IHDR', 12)) return null;
                return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
            }
            case 'image/jpeg':
                return parseJpegDimensions(bytes);
            case 'image/gif': {
                if (bytes.length < 10) return null;
                return { width: readU16LE(bytes, 6), height: readU16LE(bytes, 8) };
            }
            case 'image/bmp': {
                if (bytes.length < 26) return null;
                const headerSize = readU32LE(bytes, 14);
                if (headerSize === 12) {
                    // BITMAPCOREHEADER stores 16-bit dimensions
                    return { width: readU16LE(bytes, 18), height: readU16LE(bytes, 20) };
                }
                // BITMAPINFOHEADER and later: height is negative for top-down rows
                return {
                    width: Math.abs(readI32LE(bytes, 18)),
                    height: Math.abs(readI32LE(bytes, 22)),
                };
            }
            case 'image/webp':
                return parseWebpDimensions(bytes);
            default:
                return null;
        }
    } catch {
        return null;
    }
}

/** Encode a bitmap/canvas source region to PNG or JPEG bytes. */
async function encodeImage(
    win: any,
    source: any,
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number,
    format: 'png' | 'jpeg',
    jpegQuality: number,
): Promise<Uint8Array> {
    const canvas = new win.OffscreenCanvas(targetWidth, targetHeight);
    try {
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new ImageProcessingError('Could not acquire 2D canvas context');
        }
        if (format === 'jpeg') {
            // JPEG has no alpha channel; the encoder composites transparency
            // on black unless we composite on white first.
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, targetWidth, targetHeight);
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight);
        const blob = await canvas.convertToBlob(
            format === 'jpeg'
                ? { type: 'image/jpeg', quality: jpegQuality / 100 }
                : { type: 'image/png' },
        );
        return new Uint8Array(await blob.arrayBuffer());
    } finally {
        // Zeroing dimensions releases the backing surface promptly.
        canvas.width = 0;
        canvas.height = 0;
    }
}

/**
 * Decode, downscale, and re-encode an image.
 *
 * - Never upscales; `maxWidth`/`maxHeight` only bound the output.
 * - `format: 'auto'` passes PNG/JPEG sources through untouched when no
 *   resize is needed and the bytes fit the budget; otherwise JPEG sources
 *   re-encode as JPEG and everything else as PNG.
 * - Output exceeding `maxOutputBytes` falls back from PNG to JPEG, then
 *   halves dimensions up to three times before failing.
 * - Animated sources decode to their first frame.
 */
export async function processImageBytes(
    bytes: Uint8Array,
    mimeType: string,
    options: ProcessImageOptions,
): Promise<ProcessedImage> {
    const checkpoint = options.checkpoint ?? (() => {});

    const declared = (mimeType || '').toLowerCase();
    const sniffed = sniffImageMimeType(bytes, declared || null);
    const effectiveMime = sniffed ?? declared;
    if (sniffed && declared && sniffed !== declared) {
        logger(`processImageBytes: declared MIME '${declared}' overridden by sniffed '${sniffed}'`, 3);
    }
    if (KNOWN_UNDECODABLE_MIMES.has(effectiveMime)) {
        throw new UnsupportedImageFormatError(effectiveMime);
    }
    checkpoint('mime_sniff');

    // Pre-decode pixel cap: reject decompression bombs before the decoder
    // allocates the bitmap. Header-unparseable formats fall through to the
    // post-decode backstop.
    const headerDims = parseImageDimensions(bytes, effectiveMime);
    if (headerDims && headerDims.width * headerDims.height > MAX_DECODED_PIXELS) {
        const megapixels = (headerDims.width * headerDims.height) / 1_000_000;
        throw new ImageProcessingError(
            `Image is ${headerDims.width}×${headerDims.height} (${megapixels.toFixed(0)} megapixels), `
            + `exceeding the ${MAX_DECODED_PIXELS / 1_000_000} megapixel limit`,
        );
    }
    checkpoint('header_dims');

    const win = Zotero.getMainWindow() as any;
    if (!win) {
        throw new ImageProcessingError('Main window is not available for image processing');
    }

    // Slice out exactly the input byte range — handing `bytes.buffer`
    // directly to Blob would serialize the entire backing buffer (and ignore
    // a non-zero byteOffset), corrupting the image whenever the input is a
    // view onto a larger buffer.
    const arrayBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([arrayBuffer], { type: effectiveMime || undefined });

    let bitmap: any;
    try {
        bitmap = await win.createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (error) {
        throw new ImageDecodeError(
            `Could not decode image (${effectiveMime || 'unknown type'}): `
            + `${error instanceof Error ? error.message : String(error)}`,
        );
    }

    try {
        checkpoint('decode');

        // Dimensions are post-EXIF-orientation.
        const originalWidth: number = bitmap.width;
        const originalHeight: number = bitmap.height;
        if (!originalWidth || !originalHeight) {
            throw new ImageDecodeError('Image has zero dimensions');
        }

        // Post-decode pixel cap backstop for header-unparseable formats.
        if (!headerDims && originalWidth * originalHeight > MAX_DECODED_PIXELS) {
            const megapixels = (originalWidth * originalHeight) / 1_000_000;
            throw new ImageProcessingError(
                `Image is ${originalWidth}×${originalHeight} (${megapixels.toFixed(0)} megapixels), `
                + `exceeding the ${MAX_DECODED_PIXELS / 1_000_000} megapixel limit`,
            );
        }
        checkpoint('pixel_cap');

        const scale = Math.min(
            1,
            options.maxWidth / originalWidth,
            options.maxHeight / originalHeight,
        );
        let targetWidth = Math.max(1, Math.round(originalWidth * scale));
        let targetHeight = Math.max(1, Math.round(originalHeight * scale));
        const needsResize = targetWidth !== originalWidth || targetHeight !== originalHeight;

        const sourceFormat: 'png' | 'jpeg' | null =
            effectiveMime === 'image/jpeg' ? 'jpeg'
                : effectiveMime === 'image/png' ? 'png'
                    : null;

        // Fast path: original bytes already satisfy every constraint.
        if (
            !needsResize
            && options.format === 'auto'
            && sourceFormat !== null
            && bytes.byteLength <= options.maxOutputBytes
        ) {
            return {
                data: bytes,
                format: sourceFormat,
                width: originalWidth,
                height: originalHeight,
                originalWidth,
                originalHeight,
                sourceMime: effectiveMime,
                resized: false,
                converted: false,
            };
        }

        let outputFormat: 'png' | 'jpeg' = options.format === 'auto'
            ? (sourceFormat === 'jpeg' ? 'jpeg' : 'png')
            : options.format;

        // Iterative halving keeps quality on large downscales: a single
        // drawImage step beyond ~2x discards too many source pixels.
        let source: any = bitmap;
        let sourceWidth = originalWidth;
        let sourceHeight = originalHeight;
        let intermediate: any = null;
        try {
            while (sourceWidth / 2 >= targetWidth && sourceHeight / 2 >= targetHeight) {
                const halfWidth = Math.ceil(sourceWidth / 2);
                const halfHeight = Math.ceil(sourceHeight / 2);
                const half = new win.OffscreenCanvas(halfWidth, halfHeight);
                const halfCtx = half.getContext('2d');
                if (!halfCtx) {
                    throw new ImageProcessingError('Could not acquire 2D canvas context');
                }
                halfCtx.imageSmoothingEnabled = true;
                halfCtx.imageSmoothingQuality = 'high';
                halfCtx.drawImage(
                    source, 0, 0, sourceWidth, sourceHeight,
                    0, 0, halfWidth, halfHeight,
                );
                if (intermediate) {
                    intermediate.width = 0;
                    intermediate.height = 0;
                }
                intermediate = half;
                source = half;
                sourceWidth = halfWidth;
                sourceHeight = halfHeight;
                checkpoint('resize_pass');
            }

            let encoded = await encodeImage(
                win, source, sourceWidth, sourceHeight,
                targetWidth, targetHeight, outputFormat, options.jpegQuality,
            );
            checkpoint('encode');

            // Byte budget: PNG can blow past the budget on photographic
            // content — fall back to JPEG before shrinking dimensions.
            if (encoded.byteLength > options.maxOutputBytes && outputFormat === 'png') {
                checkpoint('budget_retry');
                outputFormat = 'jpeg';
                encoded = await encodeImage(
                    win, source, sourceWidth, sourceHeight,
                    targetWidth, targetHeight, outputFormat, options.jpegQuality,
                );
                checkpoint('encode');
            }
            let attempts = 0;
            while (encoded.byteLength > options.maxOutputBytes && attempts < 3) {
                checkpoint('budget_retry');
                targetWidth = Math.max(1, Math.round(targetWidth / 2));
                targetHeight = Math.max(1, Math.round(targetHeight / 2));
                attempts++;
                encoded = await encodeImage(
                    win, source, sourceWidth, sourceHeight,
                    targetWidth, targetHeight, outputFormat, options.jpegQuality,
                );
                checkpoint('encode');
            }
            if (encoded.byteLength > options.maxOutputBytes) {
                throw new ImageProcessingError(
                    `Encoded image is ${encoded.byteLength} bytes after downscaling, `
                    + `exceeding the ${options.maxOutputBytes}-byte limit`,
                );
            }

            return {
                data: encoded,
                format: outputFormat,
                width: targetWidth,
                height: targetHeight,
                originalWidth,
                originalHeight,
                sourceMime: effectiveMime,
                resized: targetWidth !== originalWidth || targetHeight !== originalHeight,
                converted: outputFormat !== sourceFormat,
            };
        } finally {
            if (intermediate) {
                intermediate.width = 0;
                intermediate.height = 0;
            }
        }
    } finally {
        bitmap.close?.();
    }
}
