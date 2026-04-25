/**
 * MuPDF WASM module worker (PR #1 — getPageCount only).
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

// ---------------------------------------------------------------------------
// Minimal Document wrapper — only what `countPages` needs.
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

    let _wasm_string = [0, 0];
    const STRING = (s) => {
        if (_wasm_string[0]) {
            Free(_wasm_string[0]);
            _wasm_string[0] = 0;
        }
        return (_wasm_string[0] = allocateUTF8(s));
    };

    const createBuffer = (data) => {
        if (data instanceof ArrayBuffer) {
            data = new Uint8Array(data);
        }
        const data_len = data.byteLength;
        const data_ptr = Malloc(data_len);
        libmupdf.HEAPU8.set(data, data_ptr);
        return libmupdf._wasm_new_buffer_from_data(data_ptr, data_len);
    };

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

        destroy() {
            if (this.pointer) {
                libmupdf._wasm_drop_document(this.pointer);
                this.pointer = 0;
            }
        }
    }

    return { Document };
}

// ---------------------------------------------------------------------------
// Op: getPageCount — mirrors MuPDFService.open() + getPageCount().
// ---------------------------------------------------------------------------
async function opGetPageCount({ pdfData }) {
    const libmupdf = await ensureInit();
    const { Document } = makeDocumentApi(libmupdf);

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

    try {
        const count = doc.countPages();
        return { count };
    } finally {
        doc.destroy();
    }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
async function dispatch(op, args) {
    switch (op) {
        case "__init":
            await ensureInit();
            return {};
        case "getPageCount":
            return await opGetPageCount(args || {});
        default:
            throw new Error(`Unknown op: ${op}`);
    }
}

self.onmessage = async (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;

    const { id, op, args } = data;
    if (typeof id !== "number" || typeof op !== "string") {
        return;
    }

    try {
        const result = await dispatch(op, args);
        self.postMessage({ id, ok: true, result });
    } catch (e) {
        let error;
        if (e && typeof e === "object" && e.name === "ExtractionError") {
            error = { name: "ExtractionError", code: e.code, message: e.message };
        } else {
            const message = e instanceof Error ? e.message : String(e);
            error = { name: "Error", message };
        }
        self.postMessage({ id, ok: false, error });
    }
};
