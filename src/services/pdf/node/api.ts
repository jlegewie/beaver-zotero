/**
 * Node-side BeaverExtract API.
 *
 * Thin wrappers around the worker ops in `../worker/ops.ts`. Each
 * function pre-initializes the runtime via `ensureExtractionRuntime`
 * (MuPDF + sentencex) and returns the `result` field of the op reply.
 *
 * Imports ops directly from `../worker/ops` — never from
 * `../index` (the barrel), which would pull `MuPDFWorkerClient` into the
 * Node graph and try to spawn a Web Worker.
 *
 * Concurrency: every op call is funneled through the worker `enqueue`
 * FIFO. The shared WASM heap state (`_wasm_string`, `_wasm_matrix`,
 * `createBuffer` allocations, `_wasm_drop_document`) is not safe across
 * concurrent ops, and Node callers can absolutely race them via
 * `Promise.all` (the `info` command does exactly that). The worker
 * dispatcher uses the same queue, so this matches the worker contract.
 */
import { ensureExtractionRuntime } from "./bootstrap";
import {
    opAnalyzeLayout,
    opAnalyzeOCRNeeds,
    opExtract,
    opExtractRawPageDetailed,
    opGetMetadata,
    opGetPageCount,
    opRenderPages,
} from "../worker/ops";
import { enqueue } from "../worker/opQueue";
import type {
    ExtractionResult,
    ExtractionSettings,
    LayoutAnalysisResult,
    OCRDetectionOptions,
    OCRDetectionResult,
    PageImageOptions,
    PageImageResult,
    PDFMetadata,
    RawPageDataDetailed,
} from "../types";
import type { ParagraphDetectionSettings } from "../ParagraphDetector";
import type { SentenceSplitterConfig } from "../sentenceTypes";

export type PdfBytes = Uint8Array | ArrayBuffer;

export interface PageRange {
    startIndex: number;
    endIndex?: number;
    maxPages?: number;
}

export interface ExtractInput {
    pdfData: PdfBytes;
    mode?: "markdown" | "structured";
    markdown?: { engine?: "block" | "paragraph" };
    structured?: { splitterConfig?: SentenceSplitterConfig };
    settings?: ExtractionSettings;
    paragraphSettings?: ParagraphDetectionSettings;
    pageIndices?: number[];
    pageRange?: PageRange;
    analysisWindow?: number;
}

export interface AnalyzeLayoutInput {
    pdfData: PdfBytes;
    settings?: ExtractionSettings;
    pageIndices?: number[];
    pageRange?: PageRange;
    analysisWindow?: number;
}

export interface RenderPagesInput {
    pdfData: PdfBytes;
    pageIndices?: number[];
    pageRange?: PageRange;
    options?: PageImageOptions;
}

export interface RenderPagesResult {
    pageCount: number;
    pageLabels: Record<number, string>;
    pages: PageImageResult[];
}

export async function getPageCount(
    pdfData: PdfBytes,
): Promise<{ count: number }> {
    await ensureExtractionRuntime();
    const reply = await enqueue(() => opGetPageCount({ pdfData }));
    return reply.result;
}

export async function getMetadata(pdfData: PdfBytes): Promise<PDFMetadata> {
    await ensureExtractionRuntime();
    const reply = await enqueue(() => opGetMetadata({ pdfData }));
    return reply.result;
}

export async function extractPdf(input: ExtractInput): Promise<ExtractionResult> {
    await ensureExtractionRuntime();
    const reply = await enqueue(() => opExtract(input));
    return reply.result;
}

export async function analyzeLayout(
    input: AnalyzeLayoutInput,
): Promise<LayoutAnalysisResult> {
    await ensureExtractionRuntime();
    const reply = await enqueue(() => opAnalyzeLayout(input));
    return reply.result;
}

export async function renderPages(
    input: RenderPagesInput,
): Promise<RenderPagesResult> {
    await ensureExtractionRuntime();
    const reply = await enqueue(() => opRenderPages(input));
    return reply.result;
}

export async function extractRawPageDetailed(
    pdfData: PdfBytes,
    pageIndex: number,
    includeImages = false,
): Promise<RawPageDataDetailed> {
    await ensureExtractionRuntime();
    const reply = await enqueue(() =>
        opExtractRawPageDetailed({ pdfData, pageIndex, includeImages }),
    );
    return reply.result;
}

export async function analyzeOCRNeeds(
    pdfData: PdfBytes,
    options?: OCRDetectionOptions,
): Promise<OCRDetectionResult> {
    await ensureExtractionRuntime();
    const reply = await enqueue(() => opAnalyzeOCRNeeds({ pdfData, options }));
    return reply.result;
}
