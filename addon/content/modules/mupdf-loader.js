var EXPORTED_SYMBOLS = ["MuPDFLoader"];

/**
 * Lightweight loader for MuPDF WASM packaged in the add-on.
 * Works directly with the WASM module to avoid top-level await issues in Zotero.
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

    async _doInit(rootURI) {
        const base = rootURI.endsWith("/") ? rootURI : `${rootURI}/`;
        const wasmURL = `${base}lib/mupdf-wasm.wasm`;
        const wasmLoaderURL = `${base}lib/mupdf-wasm.mjs`;

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

            countPages() {
                return libmupdf._wasm_count_pages(this.pointer);
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

        // Page class wrapper
        class Page {
            constructor(pointer) {
                this.pointer = pointer;
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

        return {
            Document,
            Page,
            StructuredText,
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
};
