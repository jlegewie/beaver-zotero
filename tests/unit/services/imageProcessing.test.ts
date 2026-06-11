import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_MAX_IMAGE_DIMENSION,
    HARD_MAX_IMAGE_DIMENSION,
    MAX_DECODED_PIXELS,
    MAX_OUTPUT_IMAGE_BYTES,
    ImageDecodeError,
    ImageProcessingError,
    UnsupportedImageFormatError,
    parseImageDimensions,
    processImageBytes,
    sniffImageMimeType,
    uint8ToBase64,
    type ProcessImageOptions,
} from '../../../src/services/agentDataProvider/imageProcessing';

// ---------------------------------------------------------------------------
// Header builders — minimal valid headers for each format
// ---------------------------------------------------------------------------

function writeU32BE(bytes: Uint8Array, offset: number, value: number) {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
}

function pngBytes(width = 100, height = 80): Uint8Array {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    b[11] = 13; // IHDR length
    b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
    writeU32BE(b, 16, width);
    writeU32BE(b, 20, height);
    return b;
}

function jpegBytes(width = 100, height = 80): Uint8Array {
    // SOI + APP0 stub + SOF0 frame header
    return new Uint8Array([
        0xff, 0xd8,
        0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, length 4
        0xff, 0xc0, 0x00, 0x11, 0x08,        // SOF0, length 17, precision 8
        (height >> 8) & 0xff, height & 0xff,
        (width >> 8) & 0xff, width & 0xff,
        0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
}

function gifBytes(width = 100, height = 80): Uint8Array {
    const b = new Uint8Array(13);
    b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // 'GIF89a'
    b[6] = width & 0xff;
    b[7] = (width >> 8) & 0xff;
    b[8] = height & 0xff;
    b[9] = (height >> 8) & 0xff;
    return b;
}

function bmpBytes(width = 100, height = 80): Uint8Array {
    const b = new Uint8Array(30);
    b[0] = 0x42; // 'B'
    b[1] = 0x4d; // 'M'
    b[14] = 40; // BITMAPINFOHEADER size
    new DataView(b.buffer).setInt32(18, width, true);
    new DataView(b.buffer).setInt32(22, height, true);
    return b;
}

function webpVp8lBytes(width = 100, height = 80): Uint8Array {
    const b = new Uint8Array(32);
    b.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
    b.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
    b.set([0x56, 0x50, 0x38, 0x4c], 12); // 'VP8L'
    b[20] = 0x2f; // signature
    const bits = (width - 1) | ((height - 1) << 14);
    new DataView(b.buffer).setUint32(21, bits, true);
    return b;
}

function webpVp8xBytes(width = 100, height = 80): Uint8Array {
    const b = new Uint8Array(32);
    b.set([0x52, 0x49, 0x46, 0x46], 0);
    b.set([0x57, 0x45, 0x42, 0x50], 8);
    b.set([0x56, 0x50, 0x38, 0x58], 12); // 'VP8X'
    const w = width - 1;
    const h = height - 1;
    b[24] = w & 0xff; b[25] = (w >> 8) & 0xff; b[26] = (w >> 16) & 0xff;
    b[27] = h & 0xff; b[28] = (h >> 8) & 0xff; b[29] = (h >> 16) & 0xff;
    return b;
}

function webpVp8Bytes(width = 100, height = 80): Uint8Array {
    const b = new Uint8Array(32);
    b.set([0x52, 0x49, 0x46, 0x46], 0);
    b.set([0x57, 0x45, 0x42, 0x50], 8);
    b.set([0x56, 0x50, 0x38, 0x20], 12); // 'VP8 '
    b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; // sync code
    new DataView(b.buffer).setUint16(26, width & 0x3fff, true);
    new DataView(b.buffer).setUint16(28, height & 0x3fff, true);
    return b;
}

function avifBytes(): Uint8Array {
    const b = new Uint8Array(16);
    b.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
    b.set([0x61, 0x76, 0x69, 0x66], 8); // 'avif'
    return b;
}

function tiffBytes(): Uint8Array {
    const b = new Uint8Array(12);
    b.set([0x49, 0x49, 0x2a, 0x00], 0); // little-endian TIFF
    return b;
}

// ---------------------------------------------------------------------------
// Fake main window with createImageBitmap + OffscreenCanvas
// ---------------------------------------------------------------------------

interface CtxOp {
    op: string;
    args: unknown[];
}

class FakeContext {
    ops: CtxOp[] = [];
    imageSmoothingEnabled = false;
    imageSmoothingQuality = '';
    private _fillStyle = '';

    set fillStyle(value: string) {
        this._fillStyle = value;
        this.ops.push({ op: 'fillStyle', args: [value] });
    }

    get fillStyle(): string {
        return this._fillStyle;
    }

    fillRect(...args: unknown[]) {
        this.ops.push({ op: 'fillRect', args });
    }

    drawImage(...args: unknown[]) {
        this.ops.push({ op: 'drawImage', args });
    }
}

function makeFakeWin(config: {
    bitmapWidth?: number;
    bitmapHeight?: number;
    decodeRejects?: boolean;
    /** Sequential convertToBlob results; falls back to a 3-byte default. */
    encodeQueue?: Uint8Array[];
} = {}) {
    const canvases: Array<{ constructorDims: [number, number]; ctx: FakeContext }> = [];
    const blobCalls: Array<{ type?: string; quality?: number } | undefined> = [];
    const encodeQueue = [...(config.encodeQueue ?? [])];
    const bitmap = {
        width: config.bitmapWidth ?? 100,
        height: config.bitmapHeight ?? 80,
        close: vi.fn(),
    };

    class FakeOffscreenCanvas {
        width: number;
        height: number;
        constructorDims: [number, number];
        ctx = new FakeContext();

        constructor(width: number, height: number) {
            this.width = width;
            this.height = height;
            this.constructorDims = [width, height];
            canvases.push(this);
        }

        getContext() {
            return this.ctx;
        }

        async convertToBlob(opts?: { type?: string; quality?: number }) {
            blobCalls.push(opts);
            const data = encodeQueue.length ? encodeQueue.shift()! : new Uint8Array([9, 9, 9]);
            return {
                arrayBuffer: async () =>
                    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
            };
        }
    }

    const createImageBitmap = vi.fn(async (_blob: Blob, _opts?: unknown) => {
        if (config.decodeRejects) {
            throw new Error('decode failure');
        }
        return bitmap;
    });

    const win = { createImageBitmap, OffscreenCanvas: FakeOffscreenCanvas };
    const getMainWindow = vi.fn(() => win);
    (globalThis as any).Zotero.getMainWindow = getMainWindow;
    return { win, canvases, blobCalls, bitmap, createImageBitmap, getMainWindow };
}

function defaultOptions(overrides: Partial<ProcessImageOptions> = {}): ProcessImageOptions {
    return {
        maxWidth: DEFAULT_MAX_IMAGE_DIMENSION,
        maxHeight: DEFAULT_MAX_IMAGE_DIMENSION,
        format: 'auto',
        jpegQuality: 85,
        maxOutputBytes: MAX_OUTPUT_IMAGE_BYTES,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe('sniffImageMimeType', () => {
    it('detects formats from magic bytes', () => {
        expect(sniffImageMimeType(pngBytes(), null)).toBe('image/png');
        expect(sniffImageMimeType(jpegBytes(), null)).toBe('image/jpeg');
        expect(sniffImageMimeType(gifBytes(), null)).toBe('image/gif');
        expect(sniffImageMimeType(webpVp8lBytes(), null)).toBe('image/webp');
        expect(sniffImageMimeType(bmpBytes(), null)).toBe('image/bmp');
        expect(sniffImageMimeType(tiffBytes(), null)).toBe('image/tiff');
        expect(sniffImageMimeType(avifBytes(), null)).toBe('image/avif');
    });

    it('detects big-endian TIFF', () => {
        const b = new Uint8Array(12);
        b.set([0x4d, 0x4d, 0x00, 0x2a], 0);
        expect(sniffImageMimeType(b, 'image/png')).toBe('image/tiff');
    });

    it('detects HEIC from the ftyp brand', () => {
        const b = new Uint8Array(16);
        b.set([0x66, 0x74, 0x79, 0x70], 4);
        b.set([0x68, 0x65, 0x69, 0x63], 8); // 'heic'
        expect(sniffImageMimeType(b, null)).toBe('image/heic');
    });

    it('sniffed type wins over a wrong declared type', () => {
        expect(sniffImageMimeType(tiffBytes(), 'image/png')).toBe('image/tiff');
    });

    it('falls back to the declared type for unknown bytes', () => {
        const unknown = new Uint8Array(16).fill(0x42);
        unknown[0] = 0x00; // avoid accidental 'BM' match
        expect(sniffImageMimeType(unknown, 'image/webp')).toBe('image/webp');
        expect(sniffImageMimeType(unknown, null)).toBeNull();
    });

    it('detects a leading <svg tag', () => {
        const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
        expect(sniffImageMimeType(svg, 'image/png')).toBe('image/svg+xml');
    });

    it('detects SVG behind a BOM, whitespace, and XML preamble', () => {
        const text = '﻿ \n\t<?xml version="1.0" encoding="UTF-8"?>\n<svg width="10"/>';
        const svg = new TextEncoder().encode(text);
        expect(sniffImageMimeType(svg, 'image/png')).toBe('image/svg+xml');
    });

    it('does not classify non-SVG XML as SVG', () => {
        const xml = new TextEncoder().encode('<?xml version="1.0"?>\n<feed></feed>');
        expect(sniffImageMimeType(xml, 'image/png')).toBe('image/png');
    });
});

describe('uint8ToBase64', () => {
    function nodeBase64(bytes: Uint8Array): string {
        return Buffer.from(bytes).toString('base64');
    }

    it('matches Buffer encoding for low and high bytes', () => {
        const bytes = new Uint8Array([0x00, 0x01, 0x41, 0x7f, 0x80, 0xc3, 0xfe, 0xff]);
        expect(uint8ToBase64(bytes)).toBe(nodeBase64(bytes));
    });

    it('matches Buffer encoding across chunk boundaries (>32 KB)', () => {
        const pattern = new Uint8Array(256);
        for (let i = 0; i < 256; i++) pattern[i] = i;
        const big = new Uint8Array(256 * 200);
        for (let i = 0; i < 200; i++) big.set(pattern, i * 256);
        expect(uint8ToBase64(big)).toBe(nodeBase64(big));
    });
});

describe('parseImageDimensions', () => {
    it('parses PNG IHDR dimensions', () => {
        expect(parseImageDimensions(pngBytes(640, 480), 'image/png')).toEqual({ width: 640, height: 480 });
    });

    it('parses JPEG SOF dimensions past other segments', () => {
        expect(parseImageDimensions(jpegBytes(1024, 768), 'image/jpeg')).toEqual({ width: 1024, height: 768 });
    });

    it('parses GIF logical screen descriptor', () => {
        expect(parseImageDimensions(gifBytes(320, 200), 'image/gif')).toEqual({ width: 320, height: 200 });
    });

    it('parses BMP info header including negative (top-down) height', () => {
        expect(parseImageDimensions(bmpBytes(800, 600), 'image/bmp')).toEqual({ width: 800, height: 600 });
        expect(parseImageDimensions(bmpBytes(800, -600), 'image/bmp')).toEqual({ width: 800, height: 600 });
    });

    it('parses WebP VP8X, VP8, and VP8L headers', () => {
        expect(parseImageDimensions(webpVp8xBytes(1200, 900), 'image/webp')).toEqual({ width: 1200, height: 900 });
        expect(parseImageDimensions(webpVp8Bytes(1200, 900), 'image/webp')).toEqual({ width: 1200, height: 900 });
        expect(parseImageDimensions(webpVp8lBytes(1200, 900), 'image/webp')).toEqual({ width: 1200, height: 900 });
    });

    it('returns null for truncated headers and unsupported formats', () => {
        expect(parseImageDimensions(pngBytes().slice(0, 16), 'image/png')).toBeNull();
        expect(parseImageDimensions(gifBytes().slice(0, 8), 'image/gif')).toBeNull();
        expect(parseImageDimensions(avifBytes(), 'image/avif')).toBeNull();
        expect(parseImageDimensions(new Uint8Array([0xff, 0xd8]), 'image/jpeg')).toBeNull();
    });
});

describe('processImageBytes', () => {
    it('rejects known-undecodable declared types before touching the window', async () => {
        const { getMainWindow } = makeFakeWin();
        const opaque = new Uint8Array(16).fill(0x11);
        await expect(
            processImageBytes(opaque, 'image/tiff', defaultOptions()),
        ).rejects.toBeInstanceOf(UnsupportedImageFormatError);
        expect(getMainWindow).not.toHaveBeenCalled();
    });

    it('rejects SVG bytes hiding behind a wrong declared MIME', async () => {
        makeFakeWin();
        const svg = new TextEncoder().encode('<?xml version="1.0"?><svg width="10"/>');
        const error = await processImageBytes(svg, 'image/png', defaultOptions())
            .then(() => null, (e) => e);
        expect(error).toBeInstanceOf(UnsupportedImageFormatError);
        expect((error as UnsupportedImageFormatError).mimeType).toBe('image/svg+xml');
    });

    it('rejects header-declared decompression bombs before decoding', async () => {
        const { createImageBitmap } = makeFakeWin();
        const bomb = pngBytes(10000, 10000); // 100 MP > 64 MP cap
        await expect(
            processImageBytes(bomb, 'image/png', defaultOptions()),
        ).rejects.toBeInstanceOf(ImageProcessingError);
        expect(createImageBitmap).not.toHaveBeenCalled();
    });

    it('enforces the pixel cap post-decode when headers are unparseable', async () => {
        const oversized = Math.ceil(Math.sqrt(MAX_DECODED_PIXELS)) + 100;
        const { canvases, bitmap } = makeFakeWin({
            bitmapWidth: oversized,
            bitmapHeight: oversized,
        });
        await expect(
            processImageBytes(avifBytes(), 'image/avif', defaultOptions()),
        ).rejects.toBeInstanceOf(ImageProcessingError);
        expect(canvases).toHaveLength(0);
        expect(bitmap.close).toHaveBeenCalled();
    });

    it('maps decode rejection to ImageDecodeError', async () => {
        makeFakeWin({ decodeRejects: true });
        await expect(
            processImageBytes(pngBytes(), 'image/png', defaultOptions()),
        ).rejects.toBeInstanceOf(ImageDecodeError);
    });

    it('passes small PNG bytes through untouched on the fast path', async () => {
        const { canvases } = makeFakeWin({ bitmapWidth: 100, bitmapHeight: 80 });
        const bytes = pngBytes(100, 80);
        const result = await processImageBytes(bytes, 'image/png', defaultOptions());
        expect(result.data).toBe(bytes);
        expect(result).toMatchObject({
            format: 'png',
            width: 100,
            height: 80,
            originalWidth: 100,
            originalHeight: 80,
            sourceMime: 'image/png',
            resized: false,
            converted: false,
        });
        expect(canvases).toHaveLength(0);
    });

    it('skips the fast path when the original bytes exceed the byte budget', async () => {
        const { canvases } = makeFakeWin({ bitmapWidth: 100, bitmapHeight: 80 });
        const bytes = pngBytes(100, 80);
        const result = await processImageBytes(
            bytes, 'image/png',
            defaultOptions({ maxOutputBytes: bytes.byteLength - 1 }),
        );
        expect(result.data).not.toBe(bytes);
        expect(canvases.length).toBeGreaterThan(0);
    });

    it('downscales to fit max dimensions with iterative halving', async () => {
        const { canvases } = makeFakeWin({ bitmapWidth: 4000, bitmapHeight: 3000 });
        const result = await processImageBytes(
            pngBytes(4000, 3000), 'image/png', defaultOptions(),
        );
        expect(result).toMatchObject({
            width: 1568,
            height: 1176,
            originalWidth: 4000,
            originalHeight: 3000,
            resized: true,
            converted: false,
        });
        // One halving pass (4000×3000 → 2000×1500), then the encode canvas.
        expect(canvases.map((c) => c.constructorDims)).toEqual([
            [2000, 1500],
            [1568, 1176],
        ]);
    });

    it('never upscales but re-encodes non-PNG/JPEG sources', async () => {
        makeFakeWin({ bitmapWidth: 800, bitmapHeight: 600 });
        const result = await processImageBytes(
            webpVp8lBytes(800, 600), 'image/webp', defaultOptions(),
        );
        expect(result).toMatchObject({
            format: 'png',
            width: 800,
            height: 600,
            resized: false,
            converted: true,
            sourceMime: 'image/webp',
        });
    });

    it('keeps the JPEG family on auto resize: resized=true, converted=false', async () => {
        const { blobCalls } = makeFakeWin({ bitmapWidth: 4000, bitmapHeight: 3000 });
        const result = await processImageBytes(
            jpegBytes(4000, 3000), 'image/jpeg',
            defaultOptions({ jpegQuality: 70 }),
        );
        expect(result).toMatchObject({
            format: 'jpeg',
            resized: true,
            converted: false,
        });
        expect(blobCalls[0]).toEqual({ type: 'image/jpeg', quality: 0.7 });
    });

    it('composites on white before drawing when encoding JPEG', async () => {
        const { canvases } = makeFakeWin({ bitmapWidth: 100, bitmapHeight: 80 });
        await processImageBytes(
            pngBytes(100, 80), 'image/png', defaultOptions({ format: 'jpeg' }),
        );
        const encodeCanvas = canvases[canvases.length - 1];
        const ops = encodeCanvas.ctx.ops;
        const fillStyleIdx = ops.findIndex((o) => o.op === 'fillStyle');
        const fillRectIdx = ops.findIndex((o) => o.op === 'fillRect');
        const drawIdx = ops.findIndex((o) => o.op === 'drawImage');
        expect(ops[fillStyleIdx].args).toEqual(['#ffffff']);
        expect(ops[fillRectIdx].args).toEqual([0, 0, 100, 80]);
        expect(fillStyleIdx).toBeLessThan(fillRectIdx);
        expect(fillRectIdx).toBeLessThan(drawIdx);
    });

    it('falls back from PNG to JPEG when the budget is exceeded', async () => {
        const { blobCalls } = makeFakeWin({
            bitmapWidth: 100,
            bitmapHeight: 80,
            encodeQueue: [new Uint8Array(20), new Uint8Array(5)],
        });
        const bytes = pngBytes(100, 80);
        const result = await processImageBytes(
            bytes, 'image/png', defaultOptions({ maxOutputBytes: 10 }),
        );
        expect(result.format).toBe('jpeg');
        expect(result.converted).toBe(true);
        expect(result.data.byteLength).toBe(5);
        expect(blobCalls[0]?.type).toBe('image/png');
        expect(blobCalls[1]?.type).toBe('image/jpeg');
    });

    it('fails when the output never fits the byte budget', async () => {
        makeFakeWin({
            bitmapWidth: 100,
            bitmapHeight: 80,
            encodeQueue: Array.from({ length: 5 }, () => new Uint8Array(20)),
        });
        await expect(
            processImageBytes(
                pngBytes(100, 80), 'image/png', defaultOptions({ maxOutputBytes: 10 }),
            ),
        ).rejects.toBeInstanceOf(ImageProcessingError);
    });

    it('invokes the checkpoint across phases and aborts when it throws', async () => {
        makeFakeWin({ bitmapWidth: 4000, bitmapHeight: 3000 });
        const phases: string[] = [];
        await processImageBytes(pngBytes(4000, 3000), 'image/png', defaultOptions({
            checkpoint: (phase) => phases.push(phase),
        }));
        expect(phases).toContain('mime_sniff');
        expect(phases).toContain('header_dims');
        expect(phases).toContain('decode');
        expect(phases).toContain('resize_pass');
        expect(phases).toContain('encode');

        const { bitmap } = makeFakeWin({ bitmapWidth: 4000, bitmapHeight: 3000 });
        const deadline = new Error('deadline exceeded');
        await expect(
            processImageBytes(pngBytes(4000, 3000), 'image/png', defaultOptions({
                checkpoint: (phase) => {
                    if (phase === 'decode') throw deadline;
                },
            })),
        ).rejects.toBe(deadline);
        expect(bitmap.close).toHaveBeenCalled();
    });

    it('passes exactly the view bytes to the decoder for offset views', async () => {
        const { createImageBitmap } = makeFakeWin({ bitmapWidth: 100, bitmapHeight: 80 });
        const png = pngBytes(100, 80);
        const backing = new Uint8Array(10 + png.byteLength + 7);
        backing.set(png, 10);
        const view = new Uint8Array(backing.buffer, 10, png.byteLength);

        await processImageBytes(view, 'image/png', defaultOptions({ format: 'png' }));

        const blob = createImageBitmap.mock.calls[0][0] as Blob;
        expect(blob.size).toBe(png.byteLength);
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
    });

    it('keeps the byte budget within the base64 5 MB wire limit', () => {
        // base64 expands by 4/3; the budget must leave room under 5 MB encoded
        expect(Math.ceil((MAX_OUTPUT_IMAGE_BYTES / 3) * 4)).toBeLessThan(5 * 1024 * 1024);
        expect(HARD_MAX_IMAGE_DIMENSION).toBeGreaterThanOrEqual(DEFAULT_MAX_IMAGE_DIMENSION);
    });
});
