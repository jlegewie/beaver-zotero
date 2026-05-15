/**
 * WASM bootstrap helpers shared by `wasmInit.ts` (MuPDF) and
 * `sentencexInit.ts` (sentencex). Extracted to avoid duplicating the XHR
 * loader across each WASM module the worker hosts.
 *
 * Workers don't have ChromeUtils/NetUtil and `fetch('chrome://...')` is
 * unreliable in worker scope, so XHR is the only reliable path for a
 * WASM binary served from a chrome:// URL.
 */

/**
 * Load a `.wasm` binary from a chrome:// URL via XHR. Validates the
 * 4-byte WASM magic number on the response so a misconfigured asset
 * (HTML 404 page, broken pipe, etc.) fails loud at init time instead
 * of as a confusing instantiation error inside the WASM factory.
 */
export function loadWasmBinaryXHR(url: string): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.responseType = "arraybuffer";
        xhr.onload = () => {
            if (xhr.status === 200 || xhr.status === 0) {
                const buf = xhr.response as ArrayBuffer;
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
