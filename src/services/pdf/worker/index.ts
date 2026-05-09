/**
 * MuPDF WASM module worker entry point.
 *
 * IMPORTANT: do NOT import from `../index` (the barrel). It re-exports
 * `MuPDFWorkerClient` (and the `PDFExtractor` facade that wraps it), which
 * is the *main-thread* worker proxy: it calls `new Worker(...)` against
 * URLs supplied by `getConfig()` and would try to spawn a worker from
 * inside this worker. Worker code imports analyzers and types directly:
 *   import { StyleAnalyzer } from "../StyleAnalyzer";
 *   import type { RawPageData, ExtractionResult } from "../types";
 *
 * Built as a separate worker bundle by the host's build system.
 *
 * Configuration: the main-thread client posts a `configure` message as the
 * first frame after spawning this worker (see `MuPDFWorkerClient.ensureWorker`).
 * Op messages received before configure throw via `getWorkerUrls()`.
 */

import {
    clearAllCachedDocs,
    getCacheStats,
    sweepExpiredEntries,
} from "./docCache";
import { enqueue } from "./opQueue";
import { ensureApi } from "./wasmInit";
import { isWorkerConfigured, setWorkerUrls, type WorkerUrls } from "./config";
import { setPDFLogger } from "../logging";
import { postLog } from "./errors";

// Route analyzer-module logs through the existing `postLog` channel so the
// main-thread `MuPDFWorkerClient` forwards them to the host-configured
// `PDFConfig.log` sink. Installed eagerly at module load — the main-thread
// onmessage handler is the only thing in this file that depends on the
// worker `configure` frame; analyzer logs work as soon as ops start running.
setPDFLogger((msg, level) => {
    postLog(level === 1 ? "error" : level === 2 ? "warn" : "info", msg);
});
import {
    opAnalyzeLayout,
    opAnalyzeOCRNeeds,
    opExtract,
    opExtractRawPageDetailed,
    opExtractSentenceBBoxesDebug,
    opGetMetadata,
    opGetPageCount,
    opRenderPages,
    opSearch,
    type OpReply,
} from "./ops";
import { workerSelf } from "./workerScope";

// ---------------------------------------------------------------------------
// Dispatcher — returns { result, transfer? }. The onmessage success branch
// pulls `transfer` out and forwards it to postMessage so per-op transfer
// lists are declared at the op site (not centrally).
// ---------------------------------------------------------------------------
async function dispatch(op: string, args: Record<string, unknown> | undefined): Promise<OpReply> {
    const a = args || {};
    // Sweep expired idle docs at the top of every queued turn (defense in
    // depth — the cache's TTL timer also enqueues a sweep, this just makes
    // sure no expired doc is ever reused even if a real op landed first).
    sweepExpiredEntries();
    switch (op) {
        case "__init":
            await ensureApi();
            return { result: {} };
        case "__cacheStats":
            return { result: getCacheStats() };
        case "__cacheClear": {
            const resetCounters = a.resetCounters !== false;
            clearAllCachedDocs(resetCounters);
            return { result: getCacheStats() };
        }
        case "getPageCount":
            return await opGetPageCount(a as Parameters<typeof opGetPageCount>[0]);
        case "getMetadata":
            return await opGetMetadata(a as Parameters<typeof opGetMetadata>[0]);
        case "extractRawPageDetailed":
            return await opExtractRawPageDetailed(a as Parameters<typeof opExtractRawPageDetailed>[0]);
        case "renderPages":
            return await opRenderPages(a as Parameters<typeof opRenderPages>[0]);
        // orchestration ops
        case "extract":
            return await opExtract(a as Parameters<typeof opExtract>[0]);
        case "analyzeOCRNeeds":
            return await opAnalyzeOCRNeeds(a as Parameters<typeof opAnalyzeOCRNeeds>[0]);
        case "search":
            return await opSearch(a as Parameters<typeof opSearch>[0]);
        case "extractSentenceBBoxesDebug":
            return await opExtractSentenceBBoxesDebug(a as Parameters<typeof opExtractSentenceBBoxesDebug>[0]);
        case "analyzeLayout":
            return await opAnalyzeLayout(a as Parameters<typeof opAnalyzeLayout>[0]);
        default:
            throw new Error(`Unknown op: ${op}`);
    }
}

interface IncomingOpMessage {
    id?: number;
    op?: string;
    args?: Record<string, unknown>;
}

interface IncomingConfigureMessage {
    kind: "configure";
    urls: WorkerUrls;
}

type IncomingMessage = IncomingOpMessage | IncomingConfigureMessage;

interface ExtractionErrorLike {
    name?: string;
    code?: string;
    message?: string;
    payload?: unknown;
}

workerSelf.onmessage = (event: MessageEvent) => {
    const data = event.data as IncomingMessage | null;
    if (!data || typeof data !== "object") return;

    // Configure frame — first message posted by MuPDFWorkerClient.ensureWorker
    // immediately after spawn. No reply.
    if ((data as IncomingConfigureMessage).kind === "configure") {
        const cfg = data as IncomingConfigureMessage;
        if (cfg.urls && typeof cfg.urls === "object") {
            setWorkerUrls(cfg.urls);
        }
        return;
    }

    const { id, op, args } = data as IncomingOpMessage;
    if (typeof id !== "number" || typeof op !== "string") {
        return;
    }

    // Fail-fast: every op (including the doc-cache RPCs `__cacheStats` /
    // `__cacheClear` which never touch WASM URLs) requires a prior
    // configure frame. Without this guard those two would silently run
    // pre-config, weakening the configure-before-op contract.
    if (!isWorkerConfigured()) {
        workerSelf.postMessage({
            id,
            ok: false,
            error: {
                name: "Error",
                message:
                    "MuPDF worker received op before configure message",
            },
        });
        return;
    }

    enqueue(async () => {
        try {
            const { result, transfer } = await dispatch(op, args);
            workerSelf.postMessage({ id, ok: true, result }, transfer || []);
        } catch (e: unknown) {
            let error;
            const err = e as ExtractionErrorLike;
            if (err && typeof err === "object" && err.name === "ExtractionError") {
                error = {
                    name: "ExtractionError",
                    code: err.code,
                    message: err.message,
                    payload: err.payload,
                };
            } else {
                const message = e instanceof Error ? e.message : String(e);
                error = { name: "Error", message };
            }
            workerSelf.postMessage({ id, ok: false, error });
        }
    });
};
