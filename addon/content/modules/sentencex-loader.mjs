/**
 * Lightweight loader for the sentencex-wasm sentence segmenter packaged
 * inside the Beaver XPI.
 *
 * Mirrors `addon/content/modules/mupdf-loader.mjs`: the WASM binary is
 * vendored at
 *   chrome://beaver/content/lib/sentencex/sentencex_wasm_bg.wasm
 * and the wasm-bindgen JS glue at
 *   chrome://beaver/content/lib/sentencex/sentencex_wasm.js
 *
 * Why a wrapper at all? wasm-bindgen's default `init(url)` path tries to
 * `fetch()` the .wasm relative to `import.meta.url`, which does not resolve
 * cleanly under `chrome://`. We pre-load the bytes through Zotero-friendly
 * helpers and then call `initSync({ module: bytes })`, which compiles and
 * instantiates from a `BufferSource` in-process. Same trick mupdf-loader
 * uses.
 *
 * Usage from a chrome script:
 *   const { SentencexLoader } = ChromeUtils.importESModule(
 *     "chrome://beaver/content/modules/sentencex-loader.mjs"
 *   );
 *   const { get_sentence_boundaries } = await SentencexLoader.init(
 *     "chrome://beaver/content/"
 *   );
 *   const boundaries = get_sentence_boundaries("en", "Hello world. Bye.");
 */
export var SentencexLoader = {
    _mod: null,
    _initPromise: null,

    /**
     * Initialize the WASM module. Idempotent: subsequent calls return the
     * same cached module instance.
     *
     * @param {string} rootURI - chrome:// base URI of the addon content,
     *                           e.g. "chrome://beaver/content/".
     * @returns {Promise<{
     *   segment: (lang: string, text: string) => string[],
     *   get_sentence_boundaries: (lang: string, text: string) => Array<{
     *     text: string,
     *     start_index: number,
     *     end_index: number,
     *     boundary_symbol: string | null,
     *     is_paragraph_break: boolean,
     *   }>,
     * }>}
     */
    async init(rootURI) {
        if (this._mod) return this._mod;
        if (this._initPromise) return this._initPromise;
        this._initPromise = this._doInit(rootURI);
        return this._initPromise;
    },

    /**
     * Drop the cached module so GC can reclaim WASM memory.
     * Awaits any in-flight init first to avoid races.
     */
    async dispose() {
        if (this._initPromise) {
            try {
                await this._initPromise;
            } catch (_e) {
                // Ignore initialization errors during disposal
            }
        }
        this._mod = null;
        this._initPromise = null;
    },

    async _doInit(rootURI) {
        const base = rootURI.endsWith("/") ? rootURI : `${rootURI}/`;
        const jsURL = `${base}lib/sentencex/sentencex_wasm.js`;
        const wasmURL = `${base}lib/sentencex/sentencex_wasm_bg.wasm`;

        // 1. Pre-load the .wasm bytes via Zotero-compatible helpers.
        //    chrome:// URLs don't always work with standard fetch/XHR in
        //    extension contexts; the three-tier helper handles each case.
        const wasmBinary = await this._loadWasmBinary(wasmURL);

        // 2. Import the wasm-bindgen JS shim as an ES module via Zotero's
        //    chrome ESM loader. The shim exports `default` (async init),
        //    `initSync`, and the `segment` / `get_sentence_boundaries`
        //    functions. We use `initSync` so we don't have to thread the
        //    chrome:// fetch quirks through wasm-bindgen.
        const { ChromeUtils } = globalThis;
        if (!ChromeUtils || !ChromeUtils.importESModule) {
            throw new Error(
                "Sentencex: ChromeUtils.importESModule not available",
            );
        }
        const mod = await ChromeUtils.importESModule(jsURL);

        // 3. Synchronously instantiate the WASM module from pre-loaded bytes.
        //    `initSync` accepts a BufferSource (or `{ module: BufferSource }`)
        //    and runs `new WebAssembly.Module` + `new WebAssembly.Instance`
        //    in-process.
        mod.initSync({ module: wasmBinary });

        this._mod = {
            segment: mod.segment,
            get_sentence_boundaries: mod.get_sentence_boundaries,
        };
        return this._mod;
    },

    /**
     * Load WASM binary using Zotero-compatible APIs.
     *
     * Mirrors `mupdf-loader.mjs._loadWasmBinary` exactly: try XHR first,
     * fall back to NetUtil with a binary input stream, then plain fetch.
     * Each path validates the WebAssembly magic number before returning so
     * a half-fetched response doesn't crash the wasm-bindgen instantiator.
     *
     * Kept inline rather than shared with mupdf-loader to keep the loader
     * self-contained. If we ever add a third WASM module, promote this to
     * a shared `addon/content/modules/wasm-binary.mjs` helper.
     *
     * @param {string} wasmURL - chrome:// URL to the WASM file
     * @returns {Promise<ArrayBuffer>} - The WASM binary
     */
    async _loadWasmBinary(wasmURL) {
        const { Zotero, ChromeUtils, Components, XMLHttpRequest, fetch } =
            globalThis;

        const isWasm = (buffer) => {
            const view = new Uint8Array(buffer);
            return (
                view[0] === 0x00 &&
                view[1] === 0x61 &&
                view[2] === 0x73 &&
                view[3] === 0x6d
            );
        };

        // Method 1: XMLHttpRequest with arraybuffer responseType.
        try {
            const result = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open("GET", wasmURL, true);
                xhr.responseType = "arraybuffer";
                xhr.onload = () => {
                    if (xhr.status === 200 || xhr.status === 0) {
                        resolve(xhr.response);
                    } else {
                        reject(
                            new Error(`XHR failed with status ${xhr.status}`),
                        );
                    }
                };
                xhr.onerror = () => reject(new Error("XHR network error"));
                xhr.send();
            });
            if (isWasm(result)) return result;
            throw new Error("Invalid WASM magic number from XHR");
        } catch (e) {
            Zotero?.debug?.(`Sentencex: XHR method failed: ${e}`);
        }

        // Method 2: NetUtil + binary input stream for proper byte handling.
        try {
            const { NetUtil } = ChromeUtils.importESModule(
                "resource://gre/modules/NetUtil.sys.mjs",
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
                            const binaryStream = Components.classes[
                                "@mozilla.org/binaryinputstream;1"
                            ].createInstance(
                                Components.interfaces.nsIBinaryInputStream,
                            );
                            binaryStream.setInputStream(inputStream);
                            const bytes = binaryStream.readByteArray(
                                binaryStream.available(),
                            );
                            binaryStream.close();
                            resolve(new Uint8Array(bytes).buffer);
                        } catch (e) {
                            reject(e);
                        }
                    },
                );
            });
            if (isWasm(result)) return result;
            throw new Error("Invalid WASM magic number from NetUtil");
        } catch (e) {
            Zotero?.debug?.(`Sentencex: NetUtil method failed: ${e}`);
        }

        // Method 3: plain fetch.
        try {
            const response = await fetch(wasmURL);
            const result = await response.arrayBuffer();
            if (isWasm(result)) return result;
            throw new Error("Invalid WASM magic number from fetch");
        } catch (e) {
            Zotero?.debug?.(`Sentencex: fetch method failed: ${e}`);
        }

        throw new Error(
            `Sentencex: Failed to load WASM binary from ${wasmURL}`,
        );
    },
};
