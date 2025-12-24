var EXPORTED_SYMBOLS = ["MuPDFLoader"];

/**
 * Lightweight loader for MuPDF WASM packaged in the add-on.
 *
 * Usage from Zotero JS Playground (async mode):
 * const { MuPDFLoader } = ChromeUtils.import("chrome://beaver/content/modules/mupdf-loader.js");
 * const mupdf = await MuPDFLoader.init("chrome://beaver/content/");
 * const text = await MuPDFLoader.extractText(pdfUint8Array);
 */
var MuPDFLoader = {
    _libmupdf: null,
    _initPromise: null,

    async init(rootURI) {
        if (this._libmupdf) {
            return this._getAPI();
        }
        if (this._initPromise) {
            return this._initPromise;
        }
        this._initPromise = this._doInit(rootURI);
        return this._initPromise;
    },

    /**
     * Clear cached module and promise.
     * Allows GC to reclaim WASM memory if no other references exist.
     * 
     * NOTE: Callers should ensure all MuPDF objects (Documents, Pages, StructuredText)
     * have been properly destroyed via their .destroy() methods before calling this.
     * Otherwise, WASM memory may not be fully reclaimed.
     * 
     * @returns {Promise<void>}
     */
    async dispose() {
        // Wait for any in-flight initialization to complete before disposing
        // to avoid race conditions where WASM module is orphaned
        if (this._initPromise) {
            try {
                await this._initPromise;
            } catch (e) {
                // Ignore initialization errors during disposal
            }
        }
        
        this._libmupdf = null;
        this._initPromise = null;
    },

    async _doInit(rootURI) {
        const base = rootURI.endsWith("/") ? rootURI : `${rootURI}/`;
        const wasmURL = `${base}lib/mupdf-wasm.wasm`;
        const wasmLoaderURL = `${base}lib/mupdf-wasm.mjs`;

        // Set up required global functions for MuPDF WASM
        // These are callbacks the WASM module expects for font loading
        if (typeof globalThis.$libmupdf_load_font_file !== "function") {
            globalThis.$libmupdf_load_font_file = function (name) {
                // Return null to indicate no external font file available
                // MuPDF will use built-in fonts or substitute
                return null;
            };
        }

        // Pre-load WASM bytes using Zotero-compatible APIs
        // chrome:// URLs don't work well with standard fetch/XHR in extension context
        const wasmBinary = await this._loadWasmBinary(wasmURL);

        // Configure WASM with pre-loaded binary
        const wasmConfig = {
            wasmBinary: wasmBinary,
            locateFile: (path) => (path && path.endsWith(".wasm") ? wasmURL : path),
        };

        // Load the WASM factory module (no top-level await in this file)
        const { ChromeUtils } = globalThis;
        let wasmFactory;

        if (ChromeUtils && ChromeUtils.importESModule) {
            const mod = await ChromeUtils.importESModule(wasmLoaderURL);
            wasmFactory = mod.default;
        } else {
            throw new Error("MuPDF: ChromeUtils.importESModule not available");
        }

        // Initialize the WASM module
        this._libmupdf = await wasmFactory(wasmConfig);
        this._libmupdf._wasm_init_context();

        return this._getAPI();
    },

    /**
     * Load WASM binary using Zotero-compatible APIs
     * @param {string} wasmURL - chrome:// URL to the WASM file
     * @returns {Promise<ArrayBuffer>} - The WASM binary
     */
    async _loadWasmBinary(wasmURL) {
        const { Zotero, ChromeUtils, Components, XMLHttpRequest, fetch } = globalThis;

        // Method 1: Try using XMLHttpRequest (handles binary data correctly)
        try {
            const result = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open("GET", wasmURL, true);
                xhr.responseType = "arraybuffer";
                xhr.onload = () => {
                    if (xhr.status === 200 || xhr.status === 0) {
                        resolve(xhr.response);
                    } else {
                        reject(new Error(`XHR failed with status ${xhr.status}`));
                    }
                };
                xhr.onerror = () => reject(new Error("XHR network error"));
                xhr.send();
            });
            // Validate WASM magic number
            const view = new Uint8Array(result);
            if (view[0] === 0x00 && view[1] === 0x61 && view[2] === 0x73 && view[3] === 0x6d) {
                return result;
            }
            throw new Error("Invalid WASM magic number from XHR");
        } catch (e) {
            Zotero?.debug?.(`MuPDF: XHR method failed: ${e}`);
        }

        // Method 2: Try using NetUtil with BinaryInputStream for proper binary handling
        try {
            const { NetUtil } = ChromeUtils.importESModule(
                "resource://gre/modules/NetUtil.sys.mjs"
            );
            const result = await new Promise((resolve, reject) => {
                NetUtil.asyncFetch(
                    { uri: wasmURL, loadUsingSystemPrincipal: true },
                    (inputStream, status) => {
                        if (!Components.isSuccessCode(status)) {
                            reject(new Error(`Failed to load WASM: ${status}`));
                            return;
                        }
                        try {
                            // Use BinaryInputStream for proper binary data handling
                            const binaryStream = Components.classes[
                                "@mozilla.org/binaryinputstream;1"
                            ].createInstance(Components.interfaces.nsIBinaryInputStream);
                            binaryStream.setInputStream(inputStream);
                            const bytes = binaryStream.readByteArray(binaryStream.available());
                            binaryStream.close();
                            resolve(new Uint8Array(bytes).buffer);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
            // Validate WASM magic number
            const view = new Uint8Array(result);
            if (view[0] === 0x00 && view[1] === 0x61 && view[2] === 0x73 && view[3] === 0x6d) {
                return result;
            }
            throw new Error("Invalid WASM magic number from NetUtil");
        } catch (e) {
            Zotero?.debug?.(`MuPDF: NetUtil method failed: ${e}`);
        }

        // Method 3: Try fetch
        try {
            const response = await fetch(wasmURL);
            const result = await response.arrayBuffer();
            // Validate WASM magic number
            const view = new Uint8Array(result);
            if (view[0] === 0x00 && view[1] === 0x61 && view[2] === 0x73 && view[3] === 0x6d) {
                return result;
            }
            throw new Error("Invalid WASM magic number from fetch");
        } catch (e) {
            Zotero?.debug?.(`MuPDF: fetch method failed: ${e}`);
        }

        throw new Error(`MuPDF: Failed to load WASM binary from ${wasmURL}`);
    },

    /**
     * Returns a high-level API wrapper around the low-level WASM functions
     */
    _getAPI() {
        const libmupdf = this._libmupdf;

        // Helper functions for memory management
        const Malloc = (size) => libmupdf._wasm_malloc(size);
        const Free = (ptr) => libmupdf._wasm_free(ptr);

        const allocateUTF8 = (str) => {
            const size = libmupdf.lengthBytesUTF8(str) + 1;
            const pointer = Malloc(size);
            libmupdf.stringToUTF8(str, pointer, size);
            return pointer;
        };

        const fromString = (ptr) => libmupdf.UTF8ToString(ptr);

        const fromStringFree = (ptr) => {
            const str = libmupdf.UTF8ToString(ptr);
            Free(ptr);
            return str;
        };

        // Reusable string pointers (matching mupdf.mjs pattern)
        let _wasm_string = [0, 0];
        const STRING = (s) => {
            if (_wasm_string[0]) {
                Free(_wasm_string[0]);
                _wasm_string[0] = 0;
            }
            return (_wasm_string[0] = allocateUTF8(s));
        };

        // Buffer helper - creates a buffer from Uint8Array/ArrayBuffer
        const createBuffer = (data) => {
            if (data instanceof ArrayBuffer) {
                data = new Uint8Array(data);
            }
            const data_len = data.byteLength;
            const data_ptr = Malloc(data_len);
            libmupdf.HEAPU8.set(data, data_ptr);
            return libmupdf._wasm_new_buffer_from_data(data_ptr, data_len);
        };

        // Document class wrapper
        class Document {
            constructor(pointer) {
                this.pointer = pointer;
            }

            static openDocument(data, magic = "application/pdf") {
                const bufferPtr = createBuffer(data);
                const magicPtr = STRING(magic);
                const docPtr = libmupdf._wasm_open_document_with_buffer(magicPtr, bufferPtr);
                libmupdf._wasm_drop_buffer(bufferPtr);
                if (!docPtr) {
                    throw new Error("Failed to open document");
                }
                return new Document(docPtr);
            }

            /**
             * Check if the document requires a password to access.
             * Uses metadata check since _wasm_needs_password may not be available.
             * @returns {boolean} True if password is required
             */
            needsPassword() {
                // Try the WASM function if available
                if (typeof libmupdf._wasm_needs_password === "function") {
                    return libmupdf._wasm_needs_password(this.pointer) !== 0;
                }
                // Fallback: check encryption metadata
                // If document is encrypted, opening it without a password typically fails,
                // but some encrypted PDFs allow opening with restrictions.
                // Check the "encryption" metadata field.
                const encryption = this.getMetadata("encryption");
                // If encryption metadata exists and isn't empty/None, document has encryption
                return encryption !== undefined && encryption !== "" && encryption !== "None";
            }

            /**
             * Attempt to authenticate with a password.
             * @param {string} password - Password to try
             * @returns {number} Authentication result:
             *   0 = failed, 1 = user password, 2 = owner password, 4 = full access
             */
            authenticatePassword(password) {
                if (typeof libmupdf._wasm_authenticate_password === "function") {
                    return libmupdf._wasm_authenticate_password(this.pointer, STRING(password));
                }
                // Function not available - return 0 (failed)
                return 0;
            }

            countPages() {
                return libmupdf._wasm_count_pages(this.pointer);
            }

            /**
             * Get a single metadata field from the document.
             * @param {string} key - Metadata key, e.g. "format", "info:Title"
             * @returns {string|undefined} Metadata value if present
             */
            getMetadata(key) {
                const valuePtr = libmupdf._wasm_lookup_metadata(this.pointer, STRING(key));
                if (!valuePtr) {
                    return undefined;
                }
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

        // Helper to read a Rect from WASM memory (4 floats)
        const fromRect = (ptr) => {
            ptr = ptr >> 2;
            return [
                libmupdf.HEAPF32[ptr + 0],
                libmupdf.HEAPF32[ptr + 1],
                libmupdf.HEAPF32[ptr + 2],
                libmupdf.HEAPF32[ptr + 3],
            ];
        };

        // Page class wrapper
        class Page {
            constructor(pointer) {
                this.pointer = pointer;
            }

            /**
             * Get page bounds [x0, y0, x1, y1]
             * @param {string} [box="CropBox"] - Page box type (MediaBox, CropBox, BleedBox, TrimBox, ArtBox)
             * @returns {number[]} - Bounding rectangle [x0, y0, x1, y1]
             */
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

            /**
             * Get the label for this page (as shown in readers when custom page numbering is used).
             * Falls back to a generated label if none is set.
             * @returns {string} Page label, e.g. "220" or "A-3"
             */
            getLabel() {
                return fromString(libmupdf._wasm_page_label(this.pointer));
            }

            toStructuredText(options = "") {
                const optionsPtr = STRING(options);
                const stextPtr = libmupdf._wasm_new_stext_page_from_page(this.pointer, optionsPtr);
                if (!stextPtr) {
                    throw new Error("Failed to create structured text");
                }
                return new StructuredText(stextPtr);
            }

            destroy() {
                if (this.pointer) {
                    libmupdf._wasm_drop_page(this.pointer);
                    this.pointer = 0;
                }
            }
        }

        // StructuredText class wrapper
        class StructuredText {
            constructor(pointer) {
                this.pointer = pointer;
            }

            asJSON(scale = 1) {
                const jsonPtr = libmupdf._wasm_print_stext_page_as_json(this.pointer, scale);
                return fromStringFree(jsonPtr);
            }

            asText() {
                const textPtr = libmupdf._wasm_print_stext_page_as_text(this.pointer);
                return fromStringFree(textPtr);
            }

            destroy() {
                if (this.pointer) {
                    libmupdf._wasm_drop_stext_page(this.pointer);
                    this.pointer = 0;
                }
            }
        }

        // Helper to write a Matrix to WASM memory
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

        // Matrix utilities
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

        // ColorSpace wrapper class
        class ColorSpace {
            constructor(pointer) {
                this.pointer = pointer;
            }
        }

        // Pre-create standard colorspaces
        ColorSpace.DeviceGray = new ColorSpace(libmupdf._wasm_device_gray());
        ColorSpace.DeviceRGB = new ColorSpace(libmupdf._wasm_device_rgb());
        ColorSpace.DeviceBGR = new ColorSpace(libmupdf._wasm_device_bgr());
        ColorSpace.DeviceCMYK = new ColorSpace(libmupdf._wasm_device_cmyk());

        // Pixmap class wrapper
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

            /**
             * Get the raw pixel data as a Uint8Array
             */
            getSamples() {
                const stride = this.getStride();
                const height = this.getHeight();
                const ptr = libmupdf._wasm_pixmap_get_samples(this.pointer);
                return new Uint8Array(libmupdf.HEAPU8.buffer, ptr, stride * height);
            }

            /**
             * Convert pixmap to PNG format
             * @returns {Uint8Array} PNG data
             */
            asPNG() {
                const bufPtr = libmupdf._wasm_new_buffer_from_pixmap_as_png(this.pointer);
                const data = libmupdf._wasm_buffer_get_data(bufPtr);
                const len = libmupdf._wasm_buffer_get_len(bufPtr);
                const result = new Uint8Array(libmupdf.HEAPU8.subarray(data, data + len));
                libmupdf._wasm_drop_buffer(bufPtr);
                return result;
            }

            /**
             * Convert pixmap to JPEG format
             * @param {number} quality - JPEG quality (1-100)
             * @param {boolean} invertCmyk - Whether to invert CMYK colors
             * @returns {Uint8Array} JPEG data
             */
            asJPEG(quality = 85, invertCmyk = false) {
                const bufPtr = libmupdf._wasm_new_buffer_from_pixmap_as_jpeg(
                    this.pointer,
                    quality,
                    invertCmyk ? 1 : 0
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

        // Extend Page class with toPixmap method
        Page.prototype.toPixmap = function (matrix, colorspace, alpha = false, showExtras = true) {
            let result;
            if (showExtras) {
                result = libmupdf._wasm_new_pixmap_from_page(
                    this.pointer,
                    MATRIX(matrix),
                    colorspace.pointer,
                    alpha ? 1 : 0
                );
            } else {
                result = libmupdf._wasm_new_pixmap_from_page_contents(
                    this.pointer,
                    MATRIX(matrix),
                    colorspace.pointer,
                    alpha ? 1 : 0
                );
            }
            return new Pixmap(result);
        };

        return {
            Document,
            Page,
            StructuredText,
            Pixmap,
            ColorSpace,
            Matrix,
            // Expose low-level module for advanced usage
            _libmupdf: libmupdf,
        };
    },

    /**
     * Get the page count of a PDF file
     * @param {Uint8Array|ArrayBuffer} pdfData - The PDF file data
     * @param {string} [rootURI] - Root URI for the addon (uses cached init if already initialized)
     * @returns {Promise<number>} - The number of pages
     */
    async getPageCount(pdfData, rootURI = "chrome://beaver/content/") {
        const mupdf = await this.init(rootURI);
        const doc = mupdf.Document.openDocument(pdfData, "application/pdf");

        try {
            return doc.countPages();
        } finally {
            doc.destroy();
        }
    },

    /**
     * Extract text from a PDF file
     * @param {Uint8Array|ArrayBuffer} pdfData - The PDF file data
     * @param {string} [rootURI] - Root URI for the addon (uses cached init if already initialized)
     * @returns {Promise<string>} - The extracted text
     */
    async extractText(pdfData, rootURI = "chrome://beaver/content/") {
        const mupdf = await this.init(rootURI);
        const doc = mupdf.Document.openDocument(pdfData, "application/pdf");

        try {
            const pageCount = doc.countPages();
            let fullText = "";

            for (let i = 0; i < pageCount; i++) {
                const page = doc.loadPage(i);
                try {
                    const stext = page.toStructuredText("preserve-whitespace");
                    try {
                        const json = JSON.parse(stext.asJSON());
                        for (const block of json.blocks || []) {
                            if (block.type === "text") {
                                for (const line of block.lines || []) {
                                    fullText += `${line.text}\n`;
                                }
                            }
                        }
                    } finally {
                        stext.destroy();
                    }
                } finally {
                    page.destroy();
                }
            }

            return fullText;
        } finally {
            doc.destroy();
        }
    },

    /**
     * Extract structured text from a PDF file as JSON
     * @param {Uint8Array|ArrayBuffer} pdfData - The PDF file data
     * @param {string} [rootURI] - Root URI for the addon
     * @returns {Promise<Array>} - Array of page data with blocks
     */
    async extractStructuredText(pdfData, rootURI = "chrome://beaver/content/") {
        const mupdf = await this.init(rootURI);
        const doc = mupdf.Document.openDocument(pdfData, "application/pdf");

        try {
            const pageCount = doc.countPages();
            const pages = [];

            for (let i = 0; i < pageCount; i++) {
                const page = doc.loadPage(i);
                try {
                    const stext = page.toStructuredText("preserve-whitespace");
                    try {
                        const json = JSON.parse(stext.asJSON());
                        pages.push({
                            pageNumber: i + 1,
                            blocks: json.blocks || [],
                        });
                    } finally {
                        stext.destroy();
                    }
                } finally {
                    page.destroy();
                }
            }

            return pages;
        } finally {
            doc.destroy();
        }
    },

    /**
     * Check if a PDF document lacks a text layer (likely needs OCR).
     * Samples pages to find the percentage that look like scans (minimal text + images).
     *
     * Strategy:
     * - Start with initial sample (default 6 pages)
     * - If 80%+ appear to be scans, expand sample to 20 pages for confirmation
     * - Return true if 90%+ of final sample are scans
     *
     * @param {Uint8Array|ArrayBuffer} pdfData - The PDF file data
     * @param {Object} [options] - Configuration options
     * @param {number} [options.minTextPerPage=100] - Minimum text length expected on a page with a text layer
     * @param {number} [options.sampleLimit=6] - Initial number of pages to sample
     * @param {number} [options.expandSampleLimit=20] - Number of pages to expand the sample to if 80%+ of the initial sample are scans
     * @param {number} [options.scanThreshold=0.8] - Threshold to trigger expanded sampling
     * @param {number} [options.confirmationThreshold=0.9] - Final threshold to confirm document needs OCR
     * @param {string} [rootURI] - Root URI for the addon
     * @returns {Promise<boolean>} - True if document likely needs OCR, false otherwise
     */
    async hasNoTextLayer(pdfData, options = {}, rootURI = "chrome://beaver/content/") {
        const {
            minTextPerPage = 100,
            sampleLimit = 6,
            expandSampleLimit = 20,
            scanThreshold = 0.8,
            confirmationThreshold = 0.9,
        } = options;

        const mupdf = await this.init(rootURI);
        const doc = mupdf.Document.openDocument(pdfData, "application/pdf");

        try {
            const pageCount = doc.countPages();

            // Skip first page if document is long enough (often has publisher text)
            const startPage = pageCount > 3 ? 1 : 0;

            /**
             * Check if a page looks like a scan (minimal text + has images)
             */
            const isScanLikePage = (pageIdx) => {
                const page = doc.loadPage(pageIdx);
                try {
                    // Include images so we can detect scanned pages
                    const stext = page.toStructuredText("preserve-whitespace,preserve-images");
                    try {
                        const json = JSON.parse(stext.asJSON());
                        const blocks = json.blocks || [];

                        // Count text length and check for images
                        let textLength = 0;
                        let hasImages = false;

                        for (const block of blocks) {
                            if (block.type === "text") {
                                for (const line of block.lines || []) {
                                    // Strip whitespace/non-printable chars before counting
                                    // Handles cases where "text" is just newlines/spaces
                                    const cleanText = (line.text || "").replace(/\s+/g, "").trim();
                                    textLength += cleanText.length;
                                }
                            } else if (block.type === "image") {
                                hasImages = true;
                            }
                        }

                        // Page is scan-like if it has minimal text and contains images
                        return textLength < minTextPerPage && hasImages;
                    } finally {
                        stext.destroy();
                    }
                } finally {
                    page.destroy();
                }
            };

            // Initial sample
            const initialSampleSize = Math.min(pageCount - startPage, sampleLimit);
            let scanLikeCount = 0;

            for (let i = startPage; i < startPage + initialSampleSize; i++) {
                if (isScanLikePage(i)) {
                    scanLikeCount++;
                }
            }

            // Calculate percentage for initial sample
            let scanPercentage = initialSampleSize > 0 ? scanLikeCount / initialSampleSize : 0;
            let totalChecked = initialSampleSize;

            // If 80%+ appear to be scans, expand sample for confirmation
            if (scanPercentage >= scanThreshold && pageCount > initialSampleSize) {
                const expandedSampleSize = Math.min(pageCount - startPage, expandSampleLimit);

                if (expandedSampleSize > initialSampleSize) {
                    // Check additional pages beyond initial sample
                    for (let i = startPage + initialSampleSize; i < startPage + expandedSampleSize; i++) {
                        if (isScanLikePage(i)) {
                            scanLikeCount++;
                        }
                    }

                    totalChecked = expandedSampleSize;
                    scanPercentage = scanLikeCount / totalChecked;
                }
            }

            // Return true if 90%+ of sampled pages are scan-like
            return scanPercentage >= confirmationThreshold;
        } finally {
            doc.destroy();
        }
    },

    /**
     * Convert a PDF to structured document format.
     * Similar to the Python pdf_convert function.
     *
     * @param {Uint8Array|ArrayBuffer} pdfData - The PDF file data
     * @param {Object} [options] - Configuration options
     * @param {boolean} [options.checkTextLayer=true] - Whether to check for text layer before processing
     * @param {string} [rootURI] - Root URI for the addon
     * @returns {Promise<Object>} - Structured document with pages
     * @throws {Error} - If document is encrypted or has no text layer
     */
    async convertPdf(pdfData, options = {}, rootURI = "chrome://beaver/content/") {
        const { checkTextLayer = true } = options;

        const mupdf = await this.init(rootURI);
        const doc = mupdf.Document.openDocument(pdfData, "application/pdf");

        try {
            // Check for text layer if requested
            if (checkTextLayer) {
                const needsOCR = await this.hasNoTextLayer(pdfData, {}, rootURI);
                if (needsOCR) {
                    throw new Error("Document has no text layer");
                }
            }

            const pageCount = doc.countPages();
            const pages = [];

            for (let i = 0; i < pageCount; i++) {
                const pageData = this._convertPage(doc, i);
                pages.push(pageData);
            }

            return {
                pages,
                pageCount,
                version: "1.0",
            };
        } finally {
            doc.destroy();
        }
    },

    /**
     * Convert a single page to structured format.
     * @param {Object} doc - MuPDF document instance
     * @param {number} pageIdx - Page index (0-based)
     * @returns {Object} - Page data with content and metadata
     */
    _convertPage(doc, pageIdx) {
        const page = doc.loadPage(pageIdx);

        try {
            // Get page bounds
            const bounds = page.getBounds();
            const pageWidth = bounds[2] - bounds[0];
            const pageHeight = bounds[3] - bounds[1];

            // Extract structured text
            const stext = page.toStructuredText("preserve-whitespace");
            try {
                const json = JSON.parse(stext.asJSON());
                const blocks = json.blocks || [];

                // Build page content by iterating through text blocks
                let pageContent = "";
                const textBlocks = [];

                for (const block of blocks) {
                    if (block.type === "text") {
                        let blockText = "";
                        const blockLines = [];

                        for (const line of block.lines || []) {
                            const lineText = line.text || "";
                            blockText += lineText + " ";
                            blockLines.push({
                                text: lineText,
                                bbox: line.bbox,
                                font: line.font,
                            });
                        }

                        textBlocks.push({
                            type: "text",
                            bbox: block.bbox,
                            lines: blockLines,
                            text: blockText.trim(),
                        });

                        pageContent += blockText.trim() + "\n\n";
                    }
                }

                return {
                    idx: pageIdx,
                    content: pageContent.trim(),
                    blocks: textBlocks,
                    pageWidth,
                    pageHeight,
                };
            } finally {
                stext.destroy();
            }
        } finally {
            page.destroy();
        }
    },

    /**
     * Extract text from specific pages of a PDF
     * @param {Uint8Array|ArrayBuffer} pdfData - The PDF file data
     * @param {number[]} [pageIndices] - Array of page indices (0-based) to extract. If not provided, extracts all pages.
     * @param {string} [rootURI] - Root URI for the addon
     * @returns {Promise<Object[]>} - Array of page data objects
     */
    async extractPages(pdfData, pageIndices, rootURI = "chrome://beaver/content/") {
        const mupdf = await this.init(rootURI);
        const doc = mupdf.Document.openDocument(pdfData, "application/pdf");

        try {
            const pageCount = doc.countPages();
            const results = [];

            // If no pageIndices provided, extract all pages
            const indicesToExtract = pageIndices ?? Array.from({ length: pageCount }, (_, i) => i);

            for (const idx of indicesToExtract) {
                if (idx < 0 || idx >= pageCount) {
                    results.push({
                        idx,
                        error: `Page index ${idx} out of range (0-${pageCount - 1})`,
                    });
                    continue;
                }

                const pageData = this._convertPage(doc, idx);
                results.push(pageData);
            }

            return results;
        } finally {
            doc.destroy();
        }
    },

    /**
     * Get document metadata
     * @param {Uint8Array|ArrayBuffer} pdfData - The PDF file data
     * @param {string} [rootURI] - Root URI for the addon
     * @param {string[]} [keys] - Metadata keys to retrieve (see MuPDF docs)
     * @returns {Promise<Object>} - Document metadata and page count
     */
    async getMetadata(
        pdfData,
        rootURI = "chrome://beaver/content/",
        keys = [
            "format",
            "encryption",
            "info:Title",
            "info:Author",
            "info:Subject",
            "info:Keywords",
            "info:Creator",
            "info:Producer",
            "info:CreationDate",
            "info:ModDate",
        ]
    ) {
        const mupdf = await this.init(rootURI);
        const doc = mupdf.Document.openDocument(pdfData, "application/pdf");

        try {
            const metadata = {};

            for (const key of keys) {
                const value = doc.getMetadata(key);
                if (typeof value !== "undefined" && value !== "") {
                    metadata[key] = value;
                }
            }

            return {
                pageCount: doc.countPages(),
                metadata,
            };
        } finally {
            doc.destroy();
        }
    },

    /**
     * Get the label assigned to a specific page.
     * Useful when PDFs use custom numbering (e.g., first page labeled "220").
     * @param {Uint8Array|ArrayBuffer} pdfData - The PDF file data
     * @param {number} pageIndex - Zero-based page index
     * @param {string} [rootURI] - Root URI for the addon
     * @returns {Promise<{pageIndex: number, label: string}>}
     */
    async getPageLabel(pdfData, pageIndex = 0, rootURI = "chrome://beaver/content/") {
        const mupdf = await this.init(rootURI);
        const doc = mupdf.Document.openDocument(pdfData, "application/pdf");

        try {
            const pageCount = doc.countPages();
            if (pageIndex < 0 || pageIndex >= pageCount) {
                throw new Error(`Page index ${pageIndex} out of range (0-${pageCount - 1})`);
            }

            const page = doc.loadPage(pageIndex);
            try {
                const label = page.getLabel();
                return { pageIndex, label };
            } finally {
                page.destroy();
            }
        } finally {
            doc.destroy();
        }
    },

    /**
     * Render a page to an image.
     * @param {Uint8Array|ArrayBuffer} pdfData - The PDF file data
     * @param {number} pageIndex - Zero-based page index
     * @param {Object} [options] - Rendering options
     * @param {number} [options.scale=1.0] - Scale factor (1.0 = 72 DPI)
     * @param {number} [options.dpi] - Target DPI (alternative to scale, takes precedence)
     * @param {boolean} [options.alpha=false] - Transparent background
     * @param {boolean} [options.showExtras=true] - Render annotations and widgets
     * @param {"png"|"jpeg"} [options.format="png"] - Output format
     * @param {number} [options.jpegQuality=85] - JPEG quality (1-100)
     * @param {string} [rootURI] - Root URI for the addon
     * @returns {Promise<{data: Uint8Array, width: number, height: number, format: string, scale: number, dpi: number}>}
     */
    async renderPageToImage(pdfData, pageIndex = 0, options = {}, rootURI = "chrome://beaver/content/") {
        const {
            scale: scaleOpt = 1.0,
            dpi,
            alpha = false,
            showExtras = true,
            format = "png",
            jpegQuality = 85,
        } = options;

        // Calculate scale from DPI if provided (72 DPI = scale 1.0)
        const scale = dpi ? dpi / 72 : scaleOpt;
        const effectiveDpi = dpi || scaleOpt * 72;

        const mupdf = await this.init(rootURI);
        const doc = mupdf.Document.openDocument(pdfData, "application/pdf");

        try {
            const pageCount = doc.countPages();
            if (pageIndex < 0 || pageIndex >= pageCount) {
                throw new Error(`Page index ${pageIndex} out of range (0-${pageCount - 1})`);
            }

            const page = doc.loadPage(pageIndex);
            try {
                // Create scale matrix
                const matrix = mupdf.Matrix.scale(scale, scale);

                // Render to pixmap
                const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, alpha, showExtras);
                try {
                    const width = pixmap.getWidth();
                    const height = pixmap.getHeight();

                    // Convert to requested format
                    let data;
                    if (format === "jpeg") {
                        data = pixmap.asJPEG(jpegQuality);
                    } else {
                        data = pixmap.asPNG();
                    }

                    return {
                        pageIndex,
                        data,
                        width,
                        height,
                        format,
                        scale,
                        dpi: effectiveDpi,
                    };
                } finally {
                    pixmap.destroy();
                }
            } finally {
                page.destroy();
            }
        } finally {
            doc.destroy();
        }
    },

    /**
     * Render multiple pages to images.
     * @param {Uint8Array|ArrayBuffer} pdfData - The PDF file data
     * @param {number[]} [pageIndices] - Array of page indices. If not provided, renders all pages.
     * @param {Object} [options] - Rendering options (same as renderPageToImage)
     * @param {string} [rootURI] - Root URI for the addon
     * @returns {Promise<Array<{data: Uint8Array, width: number, height: number, format: string, scale: number, dpi: number}>>}
     */
    async renderPagesToImages(pdfData, pageIndices, options = {}, rootURI = "chrome://beaver/content/") {
        const mupdf = await this.init(rootURI);
        const doc = mupdf.Document.openDocument(pdfData, "application/pdf");

        try {
            const pageCount = doc.countPages();
            const indicesToRender = pageIndices ?? Array.from({ length: pageCount }, (_, i) => i);

            const {
                scale: scaleOpt = 1.0,
                dpi,
                alpha = false,
                showExtras = true,
                format = "png",
                jpegQuality = 85,
            } = options;

            const scale = dpi ? dpi / 72 : scaleOpt;
            const effectiveDpi = dpi || scaleOpt * 72;
            const matrix = mupdf.Matrix.scale(scale, scale);

            const results = [];

            for (const idx of indicesToRender) {
                if (idx < 0 || idx >= pageCount) {
                    results.push({
                        pageIndex: idx,
                        error: `Page index ${idx} out of range (0-${pageCount - 1})`,
                    });
                    continue;
                }

                const page = doc.loadPage(idx);
                try {
                    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, alpha, showExtras);
                    try {
                        const width = pixmap.getWidth();
                        const height = pixmap.getHeight();

                        let data;
                        if (format === "jpeg") {
                            data = pixmap.asJPEG(jpegQuality);
                        } else {
                            data = pixmap.asPNG();
                        }

                        results.push({
                            pageIndex: idx,
                            data,
                            width,
                            height,
                            format,
                            scale,
                            dpi: effectiveDpi,
                        });
                    } finally {
                        pixmap.destroy();
                    }
                } finally {
                    page.destroy();
                }
            }

            return results;
        } finally {
            doc.destroy();
        }
    },
};
