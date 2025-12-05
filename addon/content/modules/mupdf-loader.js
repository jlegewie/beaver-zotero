var EXPORTED_SYMBOLS = ["MuPDFLoader"];

/**
 * Lightweight loader for MuPDF WASM packaged in the add-on.
 * Usage from Zotero JS Playground (async mode):
 * const { MuPDFLoader } = ChromeUtils.import("chrome://beaver/content/modules/mupdf-loader.js");
 * const mod = await MuPDFLoader.init("chrome://beaver/content/");
 */
var MuPDFLoader = {
    _mupdf: null,
    _initPromise: null,

    async init(rootURI) {
        if (this._mupdf) {
            return this._mupdf;
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
        const jsURL = `${base}lib/mupdf-wasm.js`;

        // Zotero.debug(`MuPDF: loading from ${wasmURL}`);

        const { fetch } = globalThis;
        const wasmResponse = await fetch(wasmURL);
        const wasmBinary = await wasmResponse.arrayBuffer();

        const jsResponse = await fetch(jsURL);
        let jsText = await jsResponse.text();

        // Replace import.meta.url so the script parses in non-module context
        jsText = jsText.replace(/import\.meta\.url/g, JSON.stringify(jsURL));
        // Replace ESM export so it works in this Function wrapper
        jsText = jsText.replace(
            /export\s+default\s+([A-Za-z0-9_$]+)\s*;/,
            "Module.default = $1;"
        );

        const Module = {
            wasmBinary,
            locateFile: (path) => {
                if (path && path.endsWith(".wasm")) {
                    return wasmURL;
                }
                return path;
            },
        };

        const moduleFunc = new Function("Module", `${jsText}\nreturn Module;`);

        this._mupdf = await new Promise((resolve, reject) => {
            Module.onRuntimeInitialized = () => resolve(Module);
            Module.onAbort = (err) => reject(err || new Error("MuPDF abort"));
            try {
                moduleFunc(Module);
            } catch (err) {
                reject(err);
            }
        });

        // Zotero.debug("MuPDF: WASM runtime initialized");
        return this._mupdf;
    },

    async extractText(pdfData) {
        const mupdf = await this.init();
        const doc = mupdf.openDocument(pdfData, "application/pdf");
        const pageCount = doc.countPages();

        let fullText = "";
        for (let i = 0; i < pageCount; i++) {
            const page = doc.loadPage(i);
            const stext = page.toStructuredText("preserve-whitespace");
            const json = JSON.parse(stext.asJSON());

            for (const block of json.blocks || []) {
                if (block.type === "text") {
                    for (const line of block.lines || []) {
                        fullText += `${line.text}\n`;
                    }
                }
            }

            page.destroy();
        }

        doc.destroy();
        return fullText;
    },
};

