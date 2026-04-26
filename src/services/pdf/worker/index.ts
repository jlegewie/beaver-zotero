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
// FIFO queue — serializes ops so concurrent requests can't race on shared
// WASM heap state (`_wasm_string`, `_wasm_matrix`, `createBuffer`
// allocations). Defense-in-depth.
//
// Limitation: a slow op (e.g. extractRawPages on a 1000-page doc) blocks
// quick ops behind it. Worker pooling (PR #5) is the answer.
// ---------------------------------------------------------------------------
let _queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = _queue.then(work, work);
    _queue = next.catch(() => {
        // chain survives rejections
    });
    return next;
}

// ---------------------------------------------------------------------------
// Dispatcher — returns { result, transfer? }. The onmessage success branch
// pulls `transfer` out and forwards it to postMessage so per-op transfer
// lists are declared at the op site (not centrally).
// ---------------------------------------------------------------------------
async function dispatch(op: string, args: Record<string, unknown> | undefined): Promise<OpReply> {
    const a = args || {};
    switch (op) {
        case "__init":
            await ensureApi();
            return { result: {} };
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
