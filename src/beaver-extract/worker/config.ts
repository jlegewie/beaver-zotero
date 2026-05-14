/**
 * Worker-side URL configuration.
 *
 * The worker bundle has no access to the main-thread `getConfig()` from
 * `../config.ts` — it runs in a separate realm. Instead, the main-thread
 * `MuPDFWorkerClient` posts a `{ kind: "configure", urls: {...} }` message
 * as the first frame after spawning the worker. The dispatcher in
 * `./index.ts` forwards that to `setWorkerUrls()` here.
 *
 * Op messages received before configure throw via `getWorkerUrls()`, which
 * surface as a structured failure reply on the wire.
 */

export interface WorkerUrls {
    mupdfWasmFactoryUrl: string;
    mupdfWasmBinaryUrl: string;
    sentencexWasmFactoryUrl: string;
    sentencexWasmBinaryUrl: string;
}

let _urls: WorkerUrls | null = null;

export function setWorkerUrls(urls: WorkerUrls): void {
    _urls = urls;
}

export function getWorkerUrls(): WorkerUrls {
    if (!_urls) {
        throw new Error(
            "MuPDF worker not configured: expected a configure message before any op.",
        );
    }
    return _urls;
}

export function isWorkerConfigured(): boolean {
    return _urls !== null;
}
