/**
 * Error codes mirroring `ExtractionErrorCode` in `src/services/pdf/types.ts`.
 *
 * The worker is bundled but kept narrow about what it imports from `src/`;
 * the canonical enum is owned by types.ts (which it imports). However, since
 * the worker's error envelope passes the *string* code over postMessage, we
 * also re-export plain string constants for convenience.
 */
import { ExtractionErrorCode } from "../types";
import { getWorkerSelf } from "./workerScope";
import { pdfLog, type PDFLogLevel } from "../logging";

export const ERROR_CODES = ExtractionErrorCode;

export interface WorkerErrorEnvelope {
    name: "ExtractionError";
    code: string;
    message: string;
    payload?: unknown;
}

/**
 * Throwable that mirrors `ExtractionError`'s shape across the worker
 * boundary. Subclasses `Error` (instead of being a plain object) so that
 * any `instanceof Error` guard upstream still catches it and so dev-tools
 * captures a stack trace on worker-side throws.
 *
 * The dispatcher in `index.ts` serializes via duck-typing on `e.name === "ExtractionError"`
 * (not `instanceof`), keeping the wire shape identical: `{ name, code, message, payload }`.
 */
export class WorkerExtractionError extends Error implements WorkerErrorEnvelope {
    readonly name = "ExtractionError" as const;
    constructor(
        readonly code: string,
        message: string,
        readonly payload?: unknown,
    ) {
        super(message);
    }
}

export function workerError(
    code: string,
    message: string,
    payload?: unknown,
): WorkerExtractionError {
    return new WorkerExtractionError(code, message, payload);
}

export type WorkerLogLevel = "warn" | "info" | "error";

const LEVEL_TO_PDF: Record<WorkerLogLevel, PDFLogLevel> = {
    error: 1,
    warn: 2,
    info: 3,
};

/**
 * Out-of-band log message to the main thread. Best-effort; never throws.
 *
 * In Worker context: posts `{ kind: "log", level, msg }` to the main
 * thread; `MuPDFWorkerClient.onWorkerMessage` branches on `kind === "log"`
 * before the id-keyed reply path.
 *
 * Outside Worker context (Node CLI): routes through `pdfLog()` so analyzer
 * log lines reach the host-installed logger instead of being dropped.
 */
export function postLog(level: WorkerLogLevel, msg: string): void {
    const ws = getWorkerSelf();
    if (ws) {
        try {
            ws.postMessage({ kind: "log", level, msg });
        } catch (_) {
            // best-effort
        }
        return;
    }
    pdfLog(msg, LEVEL_TO_PDF[level]);
}
