/**
 * MuPDF WASM module worker.
 *
 * Hand-written ESM worker that boots libmupdf-wasm inside its own thread so
 * MuPDF calls do not block Zotero's main JS thread.
 *
 * WASM factory loading: dynamic absolute `import("chrome://...")` inside the
 * RPC handler. This was the variant chosen for PR #1; if it stops working,
 * re-spike the static-absolute and static-relative variants per the plan.
 *
 * IMPORTANT: This file is plain JavaScript and *cannot* import from src/.
 * The `ERROR_CODES` constants below mirror `ExtractionErrorCode` in
 * `src/services/pdf/types.ts` — keep them in sync.
 */

/* eslint-disable no-undef */

// ---------------------------------------------------------------------------
// Error code constants — mirror ExtractionErrorCode in src/services/pdf/types.ts
// ---------------------------------------------------------------------------
const ERROR_CODES = Object.freeze({
    ENCRYPTED: "ENCRYPTED",
    INVALID_PDF: "INVALID_PDF",
    PAGE_OUT_OF_RANGE: "PAGE_OUT_OF_RANGE",
});

function workerError(code, message) {
    return { name: "ExtractionError", code, message };
}

function postLog(level, msg) {
    try {
        self.postMessage({ kind: "log", level, msg });
    } catch (_) {
        // best-effort
    }
}

// ---------------------------------------------------------------------------
// Structured-text option strings — mirror src/services/pdf/MuPDFService.ts
// ---------------------------------------------------------------------------
const STRUCTURED_TEXT_OPTIONS = "preserve-whitespace";
const STRUCTURED_TEXT_OPTIONS_WITH_IMAGES = "preserve-whitespace,preserve-images";
const STRUCTURED_TEXT_OPTIONS_DETAILED = "preserve-whitespace,preserve-ligatures";
const STRUCTURED_TEXT_OPTIONS_DETAILED_WITH_IMAGES =
    "preserve-whitespace,preserve-ligatures,preserve-images";

// ---------------------------------------------------------------------------
// MuPDF font-loading callback (must be installed before WASM init)
// ---------------------------------------------------------------------------
if (typeof globalThis.$libmupdf_load_font_file !== "function") {
    globalThis.$libmupdf_load_font_file = function (_name) {
        return null;
    };
}

// ---------------------------------------------------------------------------
// Module cache
// ---------------------------------------------------------------------------
let _libmupdf = null;
let _initPromise = null;
let _api = null;

const WASM_FACTORY_URL = "chrome://beaver/content/lib/mupdf-wasm.mjs";
const WASM_BINARY_URL = "chrome://beaver/content/lib/mupdf-wasm.wasm";

/**
 * Load the WASM binary via XHR. Workers don't have ChromeUtils/NetUtil and
 * `fetch('chrome://...')` is unreliable in worker scope, so XHR is the only
 * reliable path.
 */
function loadWasmBinaryXHR(url) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.responseType = "arraybuffer";
        xhr.onload = () => {
            if (xhr.status === 200 || xhr.status === 0) {
                const buf = xhr.response;
                const view = new Uint8Array(buf);
                if (
                    view[0] === 0x00 &&
                    view[1] === 0x61 &&
                    view[2] === 0x73 &&
                    view[3] === 0x6d
                ) {
                    resolve(buf);
                } else {
                    reject(new Error("Invalid WASM magic number"));
                }
            } else {
                reject(new Error(`XHR failed with status ${xhr.status}`));
            }
        };
        xhr.onerror = () => reject(new Error("XHR network error"));
        xhr.send();
    });
}

async function ensureInit() {
    if (_libmupdf) return _libmupdf;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        const wasmBinary = await loadWasmBinaryXHR(WASM_BINARY_URL);

        const wasmConfig = {
            wasmBinary,
            locateFile: (path) =>
                path && path.endsWith(".wasm") ? WASM_BINARY_URL : path,
        };

        // Dynamic absolute import inside the worker. Keep this in sync with
        // the comment at the top of the file.
        const mod = await import(WASM_FACTORY_URL);
        const wasmFactory = mod.default;

        const libmupdf = await wasmFactory(wasmConfig);
        libmupdf._wasm_init_context();
        _libmupdf = libmupdf;
        return libmupdf;
    })();

    try {
        return await _initPromise;
    } catch (e) {
        _initPromise = null;
        throw e;
    }
}

/**
 * Lazily build (and cache) the API wrappers around the libmupdf module.
 *
 * `makeDocumentApi` allocates real WASM heap on construction (the
 * `_wasm_string` scratch slot, the `_wasm_matrix` writer, ColorSpace
 * pointers). Calling it per-op would leak those allocations on every
 * request, so the API is cached for the worker's lifetime.
 */
async function ensureApi() {
    const libmupdf = await ensureInit();
    if (!_api) _api = makeDocumentApi(libmupdf);
    return _api;
}

// ---------------------------------------------------------------------------
// MuPDF API wrappers — hand-ported from addon/content/modules/mupdf-loader.mjs
//
// Keep in sync with the loader. The worker is self-contained by design so
// the two files do not import each other; if the loader changes a low-level
// wrapper, mirror the change here.
// ---------------------------------------------------------------------------
function makeDocumentApi(libmupdf) {
    const Malloc = (size) => libmupdf._wasm_malloc(size);
    const Free = (ptr) => libmupdf._wasm_free(ptr);

    const allocateUTF8 = (str) => {
        const size = libmupdf.lengthBytesUTF8(str) + 1;
        const ptr = Malloc(size);
        libmupdf.stringToUTF8(str, ptr, size);
        return ptr;
    };

    const fromString = (ptr) => libmupdf.UTF8ToString(ptr);
    const fromStringFree = (ptr) => {
        const str = libmupdf.UTF8ToString(ptr);
        Free(ptr);
        return str;
    };

    // Scratch UTF8 slot, freed and reallocated on every STRING() call so
    // we never accumulate per-op allocations beyond a single live slot.
    let _wasm_string = [0, 0];
    const STRING = (s) => {
        if (_wasm_string[0]) {
            Free(_wasm_string[0]);
            _wasm_string[0] = 0;
        }
        return (_wasm_string[0] = allocateUTF8(s));
    };

    // Buffer helper — copies bytes into a fresh WASM buffer.
    const createBuffer = (data) => {
        if (data instanceof ArrayBuffer) {
            data = new Uint8Array(data);
        }
        const data_len = data.byteLength;
        const data_ptr = Malloc(data_len);
        libmupdf.HEAPU8.set(data, data_ptr);
        return libmupdf._wasm_new_buffer_from_data(data_ptr, data_len);
    };

    const fromRect = (ptr) => {
        const a = ptr >> 2;
        return [
            libmupdf.HEAPF32[a + 0],
            libmupdf.HEAPF32[a + 1],
            libmupdf.HEAPF32[a + 2],
            libmupdf.HEAPF32[a + 3],
        ];
    };

    const fromQuad = (ptr) => {
        const a = ptr >> 2;
        return [
            libmupdf.HEAPF32[a + 0],
            libmupdf.HEAPF32[a + 1],
            libmupdf.HEAPF32[a + 2],
            libmupdf.HEAPF32[a + 3],
            libmupdf.HEAPF32[a + 4],
            libmupdf.HEAPF32[a + 5],
            libmupdf.HEAPF32[a + 6],
            libmupdf.HEAPF32[a + 7],
        ];
    };

    // Matrix scratch (6 floats), reused across calls.
    const _wasm_matrix = Malloc(4 * 6) >> 2;
    const MATRIX = (m) => {
        libmupdf.HEAPF32[_wasm_matrix + 0] = m[0];
        libmupdf.HEAPF32[_wasm_matrix + 1] = m[1];
        libmupdf.HEAPF32[_wasm_matrix + 2] = m[2];
        libmupdf.HEAPF32[_wasm_matrix + 3] = m[3];
        libmupdf.HEAPF32[_wasm_matrix + 4] = m[4];
        libmupdf.HEAPF32[_wasm_matrix + 5] = m[5];
        return _wasm_matrix << 2;
    };

    const Matrix = {
        identity: [1, 0, 0, 1, 0, 0],
        scale(sx, sy) {
            return [sx, 0, 0, sy, 0, 0];
        },
        translate(tx, ty) {
            return [1, 0, 0, 1, tx, ty];
        },
        rotate(degrees) {
            let d = degrees;
            while (d < 0) d += 360;
            while (d >= 360) d -= 360;
            const s = Math.sin((d * Math.PI) / 180);
            const c = Math.cos((d * Math.PI) / 180);
            return [c, s, -s, c, 0, 0];
        },
        concat(one, two) {
            return [
                one[0] * two[0] + one[1] * two[2],
                one[0] * two[1] + one[1] * two[3],
                one[2] * two[0] + one[3] * two[2],
                one[2] * two[1] + one[3] * two[3],
                one[4] * two[0] + one[5] * two[2] + two[4],
                one[4] * two[1] + one[5] * two[3] + two[5],
            ];
        },
    };

    class ColorSpace {
        constructor(pointer) {
            this.pointer = pointer;
        }
    }
    ColorSpace.DeviceGray = new ColorSpace(libmupdf._wasm_device_gray());
    ColorSpace.DeviceRGB = new ColorSpace(libmupdf._wasm_device_rgb());
    ColorSpace.DeviceBGR = new ColorSpace(libmupdf._wasm_device_bgr());
    ColorSpace.DeviceCMYK = new ColorSpace(libmupdf._wasm_device_cmyk());

    class Pixmap {
        constructor(pointer) {
            this.pointer = pointer;
        }
        getWidth() {
            return libmupdf._wasm_pixmap_get_w(this.pointer);
        }
        getHeight() {
            return libmupdf._wasm_pixmap_get_h(this.pointer);
        }
        getStride() {
            return libmupdf._wasm_pixmap_get_stride(this.pointer);
        }
        getNumberOfComponents() {
            return libmupdf._wasm_pixmap_get_n(this.pointer);
        }
        getAlpha() {
            return libmupdf._wasm_pixmap_get_alpha(this.pointer);
        }
        getSamples() {
            const stride = this.getStride();
            const height = this.getHeight();
            const ptr = libmupdf._wasm_pixmap_get_samples(this.pointer);
            return new Uint8Array(libmupdf.HEAPU8.buffer, ptr, stride * height);
        }
        asPNG() {
            const bufPtr = libmupdf._wasm_new_buffer_from_pixmap_as_png(this.pointer);
            const data = libmupdf._wasm_buffer_get_data(bufPtr);
            const len = libmupdf._wasm_buffer_get_len(bufPtr);
            const result = new Uint8Array(libmupdf.HEAPU8.subarray(data, data + len));
            libmupdf._wasm_drop_buffer(bufPtr);
            return result;
        }
        asJPEG(quality = 85, invertCmyk = false) {
            const bufPtr = libmupdf._wasm_new_buffer_from_pixmap_as_jpeg(
                this.pointer,
                quality,
                invertCmyk ? 1 : 0,
            );
            const data = libmupdf._wasm_buffer_get_data(bufPtr);
            const len = libmupdf._wasm_buffer_get_len(bufPtr);
            const result = new Uint8Array(libmupdf.HEAPU8.subarray(data, data + len));
            libmupdf._wasm_drop_buffer(bufPtr);
            return result;
        }
        destroy() {
            if (this.pointer) {
                libmupdf._wasm_drop_pixmap(this.pointer);
                this.pointer = 0;
            }
        }
    }

    const runSearch = (searchFun, searchThis, needle, maxHits = 500) => {
        let hits = 0;
        let marks = 0;
        try {
            hits = Malloc(32 * maxHits);
            marks = Malloc(4 * maxHits);
            const n = searchFun(searchThis, STRING(needle), marks, hits, maxHits);
            const outer = [];
            if (n > 0) {
                let inner = [];
                for (let i = 0; i < n; i++) {
                    const mark = libmupdf.HEAP32[(marks >> 2) + i];
                    const quad = fromQuad(hits + i * 32);
                    if (i > 0 && mark) {
                        outer.push(inner);
                        inner = [];
                    }
                    inner.push(quad);
                }
                outer.push(inner);
            }
            return outer;
        } finally {
            Free(marks);
            Free(hits);
        }
    };

    class Page {
        constructor(pointer) {
            this.pointer = pointer;
        }
        getBounds(box = "CropBox") {
            const boxTypes = {
                MediaBox: 0,
                CropBox: 1,
                BleedBox: 2,
                TrimBox: 3,
                ArtBox: 4,
            };
            const boxIdx = boxTypes[box] ?? 1;
            return fromRect(libmupdf._wasm_bound_page(this.pointer, boxIdx));
        }
        getLabel() {
            return fromString(libmupdf._wasm_page_label(this.pointer));
        }
        toStructuredText(options = "") {
            const optionsPtr = STRING(options);
            const stextPtr = libmupdf._wasm_new_stext_page_from_page(
                this.pointer,
                optionsPtr,
            );
            if (!stextPtr) {
                throw new Error("Failed to create structured text");
            }
            return new StructuredText(stextPtr);
        }
        toPixmap(matrix, colorspace, alpha = false, showExtras = true) {
            let result;
            if (showExtras) {
                result = libmupdf._wasm_new_pixmap_from_page(
                    this.pointer,
                    MATRIX(matrix),
                    colorspace.pointer,
                    alpha ? 1 : 0,
                );
            } else {
                result = libmupdf._wasm_new_pixmap_from_page_contents(
                    this.pointer,
                    MATRIX(matrix),
                    colorspace.pointer,
                    alpha ? 1 : 0,
                );
            }
            return new Pixmap(result);
        }
        search(needle, maxHits = 500) {
            return runSearch(
                libmupdf._wasm_search_page,
                this.pointer,
                needle,
                maxHits,
            );
        }
        destroy() {
            if (this.pointer) {
                libmupdf._wasm_drop_page(this.pointer);
                this.pointer = 0;
            }
        }
    }

    class StructuredText {
        constructor(pointer) {
            this.pointer = pointer;
        }
        asJSON(scale = 1) {
            const jsonPtr = libmupdf._wasm_print_stext_page_as_json(
                this.pointer,
                scale,
            );
            return fromStringFree(jsonPtr);
        }
        asText() {
            const textPtr = libmupdf._wasm_print_stext_page_as_text(this.pointer);
            return fromStringFree(textPtr);
        }
        walk(walker) {
            let block = libmupdf._wasm_stext_page_get_first_block(this.pointer);
            while (block) {
                const blockType = libmupdf._wasm_stext_block_get_type(block);
                const blockBBox = fromRect(
                    libmupdf._wasm_stext_block_get_bbox(block),
                );
                if (blockType === 1) {
                    if (walker.onImageBlock) {
                        walker.onImageBlock(blockBBox, null, null);
                    }
                } else {
                    if (walker.beginTextBlock) {
                        walker.beginTextBlock(blockBBox);
                    }
                    let line = libmupdf._wasm_stext_block_get_first_line(block);
                    while (line) {
                        const lineBBox = fromRect(
                            libmupdf._wasm_stext_line_get_bbox(line),
                        );
                        const lineWmode = libmupdf._wasm_stext_line_get_wmode(line);
                        const dirPtr =
                            libmupdf._wasm_stext_line_get_dir(line) >> 2;
                        const lineDir = [
                            libmupdf.HEAPF32[dirPtr + 0],
                            libmupdf.HEAPF32[dirPtr + 1],
                        ];
                        if (walker.beginLine) {
                            walker.beginLine(lineBBox, lineWmode, lineDir);
                        }
                        if (walker.onChar) {
                            let ch = libmupdf._wasm_stext_line_get_first_char(line);
                            while (ch) {
                                const runeCode =
                                    libmupdf._wasm_stext_char_get_c(ch);
                                const rune = String.fromCharCode(runeCode);
                                const originPtr =
                                    libmupdf._wasm_stext_char_get_origin(ch) >> 2;
                                const origin = [
                                    libmupdf.HEAPF32[originPtr + 0],
                                    libmupdf.HEAPF32[originPtr + 1],
                                ];
                                const fontPtr =
                                    libmupdf._wasm_stext_char_get_font(ch);
                                const size =
                                    libmupdf._wasm_stext_char_get_size(ch);
                                const quad = fromQuad(
                                    libmupdf._wasm_stext_char_get_quad(ch),
                                );
                                const color =
                                    libmupdf._wasm_stext_char_get_argb(ch);
                                walker.onChar(rune, origin, fontPtr, size, quad, color);
                                ch = libmupdf._wasm_stext_char_get_next(ch);
                            }
                        }
                        if (walker.endLine) {
                            walker.endLine();
                        }
                        line = libmupdf._wasm_stext_line_get_next(line);
                    }
                    if (walker.endTextBlock) {
                        walker.endTextBlock();
                    }
                }
                block = libmupdf._wasm_stext_block_get_next(block);
            }
        }
        destroy() {
            if (this.pointer) {
                libmupdf._wasm_drop_stext_page(this.pointer);
                this.pointer = 0;
            }
        }
    }

    class Document {
        constructor(pointer) {
            this.pointer = pointer;
        }

        static openDocument(data, magic = "application/pdf") {
            const bufferPtr = createBuffer(data);
            const magicPtr = STRING(magic);
            const docPtr = libmupdf._wasm_open_document_with_buffer(
                magicPtr,
                bufferPtr,
            );
            libmupdf._wasm_drop_buffer(bufferPtr);
            if (!docPtr) {
                throw new Error("Failed to open document");
            }
            return new Document(docPtr);
        }

        needsPassword() {
            if (typeof libmupdf._wasm_needs_password === "function") {
                return libmupdf._wasm_needs_password(this.pointer) !== 0;
            }
            const enc = this.getMetadata("encryption");
            return enc !== undefined && enc !== "" && enc !== "None";
        }

        countPages() {
            return libmupdf._wasm_count_pages(this.pointer);
        }

        getMetadata(key) {
            const valuePtr = libmupdf._wasm_lookup_metadata(
                this.pointer,
                STRING(key),
            );
            if (!valuePtr) return undefined;
            return fromString(valuePtr);
        }

        loadPage(index) {
            const pagePtr = libmupdf._wasm_load_page(this.pointer, index);
            if (!pagePtr) {
                throw new Error(`Failed to load page ${index}`);
            }
            return new Page(pagePtr);
        }

        destroy() {
            if (this.pointer) {
                libmupdf._wasm_drop_document(this.pointer);
                this.pointer = 0;
            }
        }
    }

    return { Document, Page, Pixmap, ColorSpace, Matrix, StructuredText };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Open a PDF document and run the encryption check, mirroring
 * MuPDFService.open() semantics. Throws workerError on encrypted /
 * invalid input. Returns the open `doc` on success.
 */
async function openDocSafe(pdfData) {
    const { Document } = await ensureApi();

    let doc;
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

    // Encryption check — mirrors the swallow-and-continue at MuPDFService.ts:267-272.
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
        if (e && e.code === ERROR_CODES.ENCRYPTED) {
            throw e;
        }
        postLog(
            "warn",
            `[mupdf-worker] Encryption check failed, continuing: ${e}`,
        );
    }

    return doc;
}

/** Convert a [x0, y0, x1, y1] tuple (from walk() bboxes) to RawBBox. */
function tupleToBBox(t) {
    return { x: t[0], y: t[1], w: t[2] - t[0], h: t[3] - t[1] };
}

/** Compute an axis-aligned RawBBox from a QuadPoint's four corners. */
function bboxFromQuad(q) {
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Compute an axis-aligned bbox from an array of quads. */
function bboxFromQuads(quads) {
    if (!quads.length) return { x: 0, y: 0, w: 0, h: 0 };
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
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ---------------------------------------------------------------------------
// Op: getPageCount — kept for PR #1 callers (unchanged contract).
// ---------------------------------------------------------------------------
async function opGetPageCount({ pdfData }) {
    const doc = await openDocSafe(pdfData);
    try {
        return { result: { count: doc.countPages() } };
    } finally {
        doc.destroy();
    }
}

// ---------------------------------------------------------------------------
// Op: getPageCountAndLabels
// ---------------------------------------------------------------------------
async function opGetPageCountAndLabels({ pdfData }) {
    const doc = await openDocSafe(pdfData);
    try {
        const count = doc.countPages();
        const labels = {};
        for (let i = 0; i < count; i++) {
            const page = doc.loadPage(i);
            try {
                const label = page.getLabel();
                if (label) labels[i] = label;
            } catch (_) {
                // label not available
            } finally {
                page.destroy();
            }
        }
        return { result: { count, labels } };
    } finally {
        doc.destroy();
    }
}

// ---------------------------------------------------------------------------
// Op: extractRawPages
//   Mirrors MuPDFService.extractRawPages — silently filters invalid indices.
// ---------------------------------------------------------------------------
async function opExtractRawPages({ pdfData, pageIndices }) {
    const doc = await openDocSafe(pdfData);
    try {
        const pageCount = doc.countPages();
        const indices = pageIndices && pageIndices.length
            ? pageIndices.filter((i) => i >= 0 && i < pageCount)
            : Array.from({ length: pageCount }, (_, i) => i);

        const pages = indices.map((i) => extractRawPage(doc, i));

        return { result: { pageCount, pages } };
    } finally {
        doc.destroy();
    }
}

function extractRawPage(doc, pageIndex) {
    const page = doc.loadPage(pageIndex);
    try {
        const pb = page.getBounds("CropBox");
        const width = pb[2] - pb[0];
        const height = pb[3] - pb[1];

        let label;
        try {
            label = page.getLabel();
        } catch (_) {}

        const stext = page.toStructuredText(STRUCTURED_TEXT_OPTIONS);
        try {
            const json = JSON.parse(stext.asJSON());
            return {
                pageIndex,
                pageNumber: pageIndex + 1,
                width,
                height,
                label,
                blocks: json.blocks || [],
            };
        } finally {
            stext.destroy();
        }
    } finally {
        page.destroy();
    }
}

// ---------------------------------------------------------------------------
// Op: extractRawPageDetailed
//   Single-page op — validates pageIndex and throws PAGE_OUT_OF_RANGE.
// ---------------------------------------------------------------------------
async function opExtractRawPageDetailed({ pdfData, pageIndex, includeImages }) {
    const doc = await openDocSafe(pdfData);
    try {
        const pageCount = doc.countPages();
        if (
            typeof pageIndex !== "number" ||
            pageIndex < 0 ||
            pageIndex >= pageCount
        ) {
            throw workerError(
                ERROR_CODES.PAGE_OUT_OF_RANGE,
                `Page index ${pageIndex} out of range (0..${pageCount - 1})`,
            );
        }

        const page = doc.loadPage(pageIndex);
        try {
            const pb = page.getBounds("CropBox");
            const width = pb[2] - pb[0];
            const height = pb[3] - pb[1];

            let label;
            try {
                label = page.getLabel();
            } catch (_) {}

            const stextOptions = includeImages
                ? STRUCTURED_TEXT_OPTIONS_DETAILED_WITH_IMAGES
                : STRUCTURED_TEXT_OPTIONS_DETAILED;
            const stext = page.toStructuredText(stextOptions);

            const blocks = [];
            let currentBlock = null;
            let currentLine = null;

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
                    beginLine: (bbox, wmode) => {
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
                            chars: [],
                        };
                    },
                    endLine: () => {
                        if (currentLine && currentBlock) {
                            currentBlock.lines.push(currentLine);
                        }
                        currentLine = null;
                    },
                    onChar: (rune, _origin, _font, _size, quad) => {
                        if (!currentLine) return;
                        currentLine.text += rune;
                        currentLine.chars.push({
                            c: rune,
                            quad,
                            bbox: bboxFromQuad(quad),
                        });
                    },
                    onImageBlock: (bbox) => {
                        if (includeImages) {
                            blocks.push({
                                type: "image",
                                bbox: tupleToBBox(bbox),
                            });
                        }
                    },
                });
            } finally {
                stext.destroy();
            }

            return {
                result: {
                    pageIndex,
                    pageNumber: pageIndex + 1,
                    width,
                    height,
                    label,
                    blocks,
                },
            };
        } finally {
            page.destroy();
        }
    } finally {
        doc.destroy();
    }
}

// ---------------------------------------------------------------------------
// Op: renderPagesToImages
//   Mirrors MuPDFService.renderPagesToImages — silently filters invalid indices.
//   Returns transferable image buffers in the dispatch envelope.
// ---------------------------------------------------------------------------
const DEFAULT_PAGE_IMAGE_OPTIONS = {
    scale: 1.0,
    dpi: 0,
    alpha: false,
    showExtras: true,
    format: "png",
    jpegQuality: 85,
};

function renderOnePage(api, doc, pageIndex, opts) {
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
            let data;
            let format = opts.format;
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

async function opRenderPagesToImages({ pdfData, pageIndices, options }) {
    const api = await ensureApi();
    const doc = await openDocSafe(pdfData);
    try {
        const opts = { ...DEFAULT_PAGE_IMAGE_OPTIONS, ...(options || {}) };
        const pageCount = doc.countPages();
        const indices = pageIndices && pageIndices.length
            ? pageIndices.filter((i) => i >= 0 && i < pageCount)
            : Array.from({ length: pageCount }, (_, i) => i);

        const out = [];
        const transfer = [];
        for (const pageIndex of indices) {
            const result = renderOnePage(api, doc, pageIndex, opts);
            out.push(result);
            transfer.push(result.data.buffer);
        }
        return { result: out, transfer };
    } finally {
        doc.destroy();
    }
}

// Single-page render — validates pageIndex and emits PAGE_OUT_OF_RANGE,
// matching extractRawPageDetailed semantics. Avoids the two-open round-trip
// of "getPageCountAndLabels then renderPagesToImages([i])" on the
// PDFExtractor.renderPageToImage path.
async function opRenderPageToImage({ pdfData, pageIndex, options }) {
    const api = await ensureApi();
    const doc = await openDocSafe(pdfData);
    try {
        const pageCount = doc.countPages();
        if (
            typeof pageIndex !== "number" ||
            pageIndex < 0 ||
            pageIndex >= pageCount
        ) {
            throw workerError(
                ERROR_CODES.PAGE_OUT_OF_RANGE,
                `Page index ${pageIndex} out of range (0..${pageCount - 1})`,
            );
        }
        const opts = { ...DEFAULT_PAGE_IMAGE_OPTIONS, ...(options || {}) };
        const result = renderOnePage(api, doc, pageIndex, opts);
        return { result, transfer: [result.data.buffer] };
    } finally {
        doc.destroy();
    }
}

// ---------------------------------------------------------------------------
// Op: searchPages
//   Mirrors MuPDFService.searchPages — silently filters invalid indices.
// ---------------------------------------------------------------------------
async function opSearchPages({ pdfData, query, pageIndices, maxHitsPerPage }) {
    const doc = await openDocSafe(pdfData);
    const limit = typeof maxHitsPerPage === "number" && maxHitsPerPage > 0
        ? maxHitsPerPage
        : 100;
    try {
        const pageCount = doc.countPages();
        const indices = pageIndices && pageIndices.length
            ? pageIndices.filter((i) => i >= 0 && i < pageCount)
            : Array.from({ length: pageCount }, (_, i) => i);

        const results = [];
        for (const pageIndex of indices) {
            const pageResult = searchPage(doc, pageIndex, query, limit);
            if (pageResult.matchCount > 0) {
                results.push(pageResult);
            }
        }
        return { result: results };
    } finally {
        doc.destroy();
    }
}

function searchPage(doc, pageIndex, query, maxHits) {
    const page = doc.loadPage(pageIndex);
    try {
        const pb = page.getBounds("CropBox");
        const width = pb[2] - pb[0];
        const height = pb[3] - pb[1];

        let label;
        try {
            label = page.getLabel();
        } catch (_) {}

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
        };
    } finally {
        page.destroy();
    }
}

// ---------------------------------------------------------------------------
// FIFO queue — serializes ops so concurrent requests can't race on shared
// WASM heap state (`_wasm_string`, `_wasm_matrix`, `createBuffer`
// allocations). Defense-in-depth: most ops only `await ensureApi()` before
// running synchronously, but new ops may grow internal awaits and the
// symptom of a race is silent heap corruption.
//
// Limitation: a slow op (e.g. extractRawPages on a 1000-page doc) blocks
// quick ops behind it. Worker pooling (PR #5) is the answer.
// ---------------------------------------------------------------------------
let _queue = Promise.resolve();
function enqueue(work) {
    const next = _queue.then(work, work);
    _queue = next.catch(() => {}); // chain survives rejections
    return next;
}

// ---------------------------------------------------------------------------
// Dispatcher — returns { result, transfer? }. The onmessage success branch
// pulls `transfer` out and forwards it to postMessage so per-op transfer
// lists are declared at the op site (not centrally).
// ---------------------------------------------------------------------------
async function dispatch(op, args) {
    switch (op) {
        case "__init":
            await ensureApi();
            return { result: {} };
        case "getPageCount":
            return await opGetPageCount(args || {});
        case "getPageCountAndLabels":
            return await opGetPageCountAndLabels(args || {});
        case "extractRawPages":
            return await opExtractRawPages(args || {});
        case "extractRawPageDetailed":
            return await opExtractRawPageDetailed(args || {});
        case "renderPagesToImages":
            return await opRenderPagesToImages(args || {});
        case "renderPageToImage":
            return await opRenderPageToImage(args || {});
        case "searchPages":
            return await opSearchPages(args || {});
        default:
            throw new Error(`Unknown op: ${op}`);
    }
}

self.onmessage = (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;

    const { id, op, args } = data;
    if (typeof id !== "number" || typeof op !== "string") {
        return;
    }

    enqueue(async () => {
        try {
            const { result, transfer } = await dispatch(op, args);
            self.postMessage({ id, ok: true, result }, transfer || []);
        } catch (e) {
            let error;
            if (e && typeof e === "object" && e.name === "ExtractionError") {
                error = {
                    name: "ExtractionError",
                    code: e.code,
                    message: e.message,
                };
            } else {
                const message = e instanceof Error ? e.message : String(e);
                error = { name: "Error", message };
            }
            self.postMessage({ id, ok: false, error });
        }
    });
};
