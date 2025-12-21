/**
 * Thin MuPDF helper that:
 * - Loads the bundled WASM via chrome://beaver/content/modules/mupdf-loader.js
 * - Caches the module per Zotero session to avoid repeated inits
 * - Exposes small helpers for common tasks (e.g., extract text from a Zotero item)
 */
let mupdfPromise: Promise<any> | null = null;

type MuPDFModule = {
    extractText: (pdfData: Uint8Array | ArrayBuffer, rootURI?: string) => Promise<string>;
};

/**
 * Returns the cached MuPDF module instance, initializing it if needed.
 */
export async function getMuPDF(): Promise<MuPDFModule> {
    if (mupdfPromise) {
        return mupdfPromise;
    }

    mupdfPromise = (async () => {
        const win = Zotero.getMainWindow();
        const { MuPDFLoader } = await win.ChromeUtils.importESModule(
            "chrome://beaver/content/modules/mupdf-loader.js"
        );
        return MuPDFLoader.init("chrome://beaver/content/");
    })();

    return mupdfPromise;
}

/**
 * Clear the cached MuPDF module reference.
 * Call this during plugin shutdown to let GC collect the WASM instance.
 * 
 * NOTE: Before calling this, ensure all MuPDF objects (Documents, Pages, StructuredText)
 * created via getMuPDF() have been properly destroyed using their .destroy() methods.
 * This ensures WASM memory is released before the module reference is cleared.
 */
export async function disposeMuPDF(): Promise<void> {
    mupdfPromise = null;
    
    try {
        const win = Zotero.getMainWindow();
        const { MuPDFLoader } = await win.ChromeUtils.importESModule(
            "chrome://beaver/content/modules/mupdf-loader.js"
        );
        await MuPDFLoader.dispose();
    } catch (e) {
        // Silently fail if loader is already gone or not loaded
    }
}

/**
 * Extract text from a Zotero attachment item using MuPDF.
 * @param item Zotero attachment item
 * @returns Full text or null if the file path is missing
 */
export async function extractPdfTextFromItem(item: Zotero.Item): Promise<string | null> {
    const path = await item.getFilePathAsync();
    if (!path) {
        return null;
    }

    const pdfData = await IOUtils.read(path); // Uint8Array
    const mupdf = await getMuPDF();
    return mupdf.extractText(pdfData);
}

