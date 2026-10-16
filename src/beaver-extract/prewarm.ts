import { getMuPDFWorkerClient } from "./MuPDFWorkerClient";
import { getConfig } from "./config";

/**
 * Start the hot MuPDF worker and warm it up (`MuPDFWorkerClient.prewarm`)
 * so the first document request of an agent run does not pay for a cold
 * worker. Safe to call from any path; cheap once the worker is warm.
 * Fire-and-forget (never blocks the caller).
 */
export function prewarmMuPDFWorker(): void {
    getMuPDFWorkerClient()
        .prewarm()
        .catch((e) => getConfig().log("MuPDF pre-warm failed: " + e, 2));
}
