import { getMuPDFWorkerClient } from "./MuPDFWorkerClient";
import { logger } from "../../utils/logger";

/**
 * Idempotently warm the MuPDF worker. Safe to call from any path; cheap
 * after the first call (worker's __init op is cached via _libmupdf /
 * _initPromise in wasmInit.ts). Fire-and-forget (never blocks the caller).
 */
export function prewarmMuPDFWorker(): void {
    getMuPDFWorkerClient()
        .ping()
        .catch((e) => logger("MuPDF pre-warm failed: " + e, 2));
}
