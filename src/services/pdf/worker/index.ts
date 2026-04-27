/**
 * MuPDF WASM module worker (bundled successor to
 * addon/content/modules/mupdf-worker.mjs — see git history pre-PR#3).
 *
 * IMPORTANT: do NOT import from `../index` (the barrel). It re-exports
 * MuPDFService, MuPDFWorkerClient, the getPref-using PDFExtractor, and
 * the logger — none of which are worker-safe. Worker code imports
 * analyzers and types directly:
 *   import { StyleAnalyzer } from "../StyleAnalyzer";
 *   import type { RawPageData, ExtractionResult } from "../types";
 *
 * Built by the second esbuild entry in zotero-plugin.config.ts. Output
 * lands at `chrome://beaver/content/scripts/mupdf-worker.js`.
 */

import {
    clearAllCachedDocs,
    getCacheStats,
    sweepExpiredEntries,
} from "./docCache";
import { enqueue } from "./opQueue";
import { ensureApi } from "./wasmInit";
import {
    opAnalyzeOCRNeeds,
    opExtract,
    opExtractByLines,
    opExtractRawPageDetailed,
    opExtractRawPages,
    opExtractSentenceBBoxes,
    opExtractWithMeta,
    opGetPageCount,
    opGetPageCountAndLabels,
    opHasTextLayer,
    opRenderPageToImage,
    opRenderPagesToImages,
    opRenderPagesToImagesWithMeta,
    opSearch,
    opSearchPages,
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
        case "getPageCountAndLabels":
            return await opGetPageCountAndLabels(a as Parameters<typeof opGetPageCountAndLabels>[0]);
        case "extractRawPages":
            return await opExtractRawPages(a as Parameters<typeof opExtractRawPages>[0]);
        case "extractRawPageDetailed":
            return await opExtractRawPageDetailed(a as Parameters<typeof opExtractRawPageDetailed>[0]);
        case "renderPagesToImages":
            return await opRenderPagesToImages(a as Parameters<typeof opRenderPagesToImages>[0]);
        case "renderPagesToImagesWithMeta":
            return await opRenderPagesToImagesWithMeta(a as Parameters<typeof opRenderPagesToImagesWithMeta>[0]);
        case "renderPageToImage":
            return await opRenderPageToImage(a as Parameters<typeof opRenderPageToImage>[0]);
        case "searchPages":
            return await opSearchPages(a as Parameters<typeof opSearchPages>[0]);
        // orchestration ops
        case "extract":
            return await opExtract(a as Parameters<typeof opExtract>[0]);
        case "extractWithMeta":
            return await opExtractWithMeta(a as Parameters<typeof opExtractWithMeta>[0]);
        case "extractByLines":
            return await opExtractByLines(a as Parameters<typeof opExtractByLines>[0]);
        case "analyzeOCRNeeds":
            return await opAnalyzeOCRNeeds(a as Parameters<typeof opAnalyzeOCRNeeds>[0]);
        case "hasTextLayer":
            return await opHasTextLayer(a as Parameters<typeof opHasTextLayer>[0]);
        case "search":
            return await opSearch(a as Parameters<typeof opSearch>[0]);
        case "extractSentenceBBoxes":
            return await opExtractSentenceBBoxes(a as Parameters<typeof opExtractSentenceBBoxes>[0]);
        default:
            throw new Error(`Unknown op: ${op}`);
    }
}

interface IncomingMessage {
    id?: number;
    op?: string;
    args?: Record<string, unknown>;
}

interface ExtractionErrorLike {
    name?: string;
    code?: string;
    message?: string;
    payload?: unknown;
}

workerSelf.onmessage = (event: MessageEvent) => {
    const data = event.data as IncomingMessage | null;
    if (!data || typeof data !== "object") return;

    const { id, op, args } = data;
    if (typeof id !== "number" || typeof op !== "string") {
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
