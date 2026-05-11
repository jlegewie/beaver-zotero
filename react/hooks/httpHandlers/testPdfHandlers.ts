/**
 * Dev-only HTTP handlers for the `/beaver/test/pdf-*` endpoints.
 *
 * Extracted from `useHttpEndpoints.ts` to keep that file focused on
 * registration. Handler exports are wired to paths in
 * `useHttpEndpoints.ts` → `registerEndpoints()`.
 */

import {
    buildColumnOverlayFromPage,
    buildLineOverlayFromPage,
    buildParagraphOverlayFromPage,
    buildSentenceOverlayFromPage,
    buildMarginsOverlayFromAnalysis,
} from '../../utils/extractionOverlay';
import type { OverlayResult } from '../../utils/extractionOverlay';
import { drawBBoxOverlayPNG } from '../../utils/canvasOverlay';
import type {
    PageSentenceBBoxResult,
    SentenceBBoxTrace,
} from '../../../src/services/pdf';
import { projectAnalyzeLayout } from '../../../src/services/pdf/debug/analyzeLayoutProjection';


// =============================================================================
// Shared helpers
// =============================================================================

/**
 * Resolve a request body to PDF bytes — accepts either an attachment ref
 * `{ library_id, zotero_key }` or raw `{ raw_bytes_base64 }`.
 *
 * Returns a discriminated result so callers can return a structured
 * `{ ok: false, error: { name, message } }` response without throwing.
 */
async function loadPdfBytesForTestEndpoint(
    request: any,
): Promise<
    | { ok: true; pdfData: Uint8Array }
    | { ok: false; error: { name: string; message: string } }
> {
    if (typeof request?.raw_bytes_base64 === 'string') {
        try {
            const binary = atob(request.raw_bytes_base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return { ok: true, pdfData: bytes };
        } catch (e) {
            return {
                ok: false,
                error: {
                    name: 'Error',
                    message: `Invalid raw_bytes_base64: ${e instanceof Error ? e.message : String(e)}`,
                },
            };
        }
    }
    const { library_id, zotero_key } = request || {};
    if (library_id == null || zotero_key == null) {
        return {
            ok: false,
            error: {
                name: 'Error',
                message: 'Provide library_id + zotero_key, or raw_bytes_base64',
            },
        };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
        library_id,
        zotero_key,
    );
    if (!item || !item.isAttachment() || !item.isPDFAttachment()) {
        return {
            ok: false,
            error: { name: 'Error', message: 'Item is not a PDF attachment' },
        };
    }
    const filePath = await item.getFilePathAsync();
    if (!filePath) {
        return {
            ok: false,
            error: { name: 'Error', message: 'PDF file not available locally' },
        };
    }
    const pdfData = await IOUtils.read(filePath);
    return { ok: true, pdfData };
}

function uint8ToBase64ForTest(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        const chunk = bytes.subarray(i, i + CHUNK);
        binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    return btoa(binary);
}

/**
 * Helper that wraps a PDFExtractor call and serializes ExtractionError
 * (including the `details` payload) into the structured wire shape used by
 * live parity tests.
 */
async function runPdfExtractorCall<T>(
    request: any,
    fn: (pdfData: Uint8Array) => Promise<T>,
    onSuccess: (result: T) => any,
): Promise<any> {
    const { ExtractionError } = await import('../../../src/services/pdf');
    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    try {
        const result = await fn(loaded.pdfData);
        return onSuccess(result);
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                    // ExtractionError stores OCR data on `e.details`
                    // (types.ts:599); the wire field is named `ocrAnalysis`
                    // for self-documenting JSON. Live tests assert the
                    // wire shape; the rehydrated client-side instance
                    // carries the same data on `error.details`.
                    payload: {
                        ocrAnalysis: e.details,
                        pageLabels: e.pageLabels,
                        pageCount: e.pageCount,
                    },
                },
            };
        }
        throw e;
    }
}


// =============================================================================
// Handlers
// =============================================================================


/**
 * Dev-only PDF page-count endpoint.
 *
 * Bypasses `createEndpoint`'s thrown-error → HTTP 500 path so live tests can
 * see structured `{ ok: false, error: { code } }` responses for parity checks
 * (encrypted vs invalid PDFs).
 *
 * Request body:
 *   { library_id, zotero_key }     // read attachment bytes
 *   { raw_bytes_base64 }            // bypass attachment-type check
 *
 * @deprecated Prefer `npm run beaver-extract -- info <pdf>`. The CLI runs
 *   the same extraction code in Node and avoids the Zotero round-trip.
 *   This endpoint is kept for live tests that exercise Zotero attachment
 *   resolution.
 */
export async function handleTestPdfPageCountHttpRequest(request: any) {
    const { PDFExtractor, ExtractionError } = await import(
        '../../../src/services/pdf'
    );

    let pdfData: Uint8Array;
    if (typeof request?.raw_bytes_base64 === 'string') {
        try {
            const binary = atob(request.raw_bytes_base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            pdfData = bytes;
        } catch (e) {
            return {
                ok: false,
                error: {
                    name: 'Error',
                    message: `Invalid raw_bytes_base64: ${e instanceof Error ? e.message : String(e)}`,
                },
            };
        }
    } else {
        const { library_id, zotero_key } = request || {};
        if (library_id == null || zotero_key == null) {
            return {
                ok: false,
                error: {
                    name: 'Error',
                    message: 'Provide library_id + zotero_key, or raw_bytes_base64',
                },
            };
        }
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
            library_id,
            zotero_key,
        );
        if (!item || !item.isAttachment() || !item.isPDFAttachment()) {
            return {
                ok: false,
                error: { name: 'Error', message: 'Item is not a PDF attachment' },
            };
        }
        const filePath = await item.getFilePathAsync();
        if (!filePath) {
            return {
                ok: false,
                error: { name: 'Error', message: 'PDF file not available locally' },
            };
        }
        pdfData = await IOUtils.read(filePath);
    }

    try {
        const count = await new PDFExtractor().getPageCount(pdfData);
        return { ok: true, count };
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                },
            };
        }
        throw e;
    }
}

/**
 * Dev-only PDF metadata endpoint. Routes through `PDFExtractor`, which
 * delegates to the MuPDF worker. Returns page count, page labels, and
 * cheap info-dict fields (title, author, format, etc.).
 *
 * @deprecated Prefer `npm run beaver-extract -- info <pdf>`.
 */
export async function handleTestPdfPageLabelsHttpRequest(request: any) {
    const { PDFExtractor, ExtractionError } = await import(
        '../../../src/services/pdf'
    );

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    try {
        const metadata = await new PDFExtractor().getMetadata(pdfData);
        return { ok: true, ...metadata };
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                },
            };
        }
        throw e;
    }
}

/**
 * Dev-only PDF render endpoint. Routes through
 * `PDFExtractor.renderPages` and discards the metadata — the legacy
 * `{ ok, pages }` response shape is preserved for live-test parity.
 * Image bytes are base64-encoded for JSON transport; live tests decode
 * for parity.
 *
 * @deprecated Prefer `npm run beaver-extract -- render <pdf> --pages 0 --out <dir>`.
 *   The CLI writes PNGs to disk and avoids the base64 round-trip.
 */
export async function handleTestPdfRenderPagesHttpRequest(request: any) {
    const { PDFExtractor, ExtractionError } = await import(
        '../../../src/services/pdf'
    );

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const pageIndices: number[] | undefined = Array.isArray(request?.page_indices)
        ? request.page_indices
        : undefined;
    const options = request?.options || {};

    try {
        const result = await new PDFExtractor().renderPages(
            pdfData,
            { pageIndices, options },
        );
        const pages = result.pages.map((r) => ({
            pageIndex: r.pageIndex,
            format: r.format,
            width: r.width,
            height: r.height,
            scale: r.scale,
            dpi: r.dpi,
            data_base64: uint8ToBase64ForTest(r.data),
            data_byte_length: r.data.byteLength,
        }));
        return { ok: true, pages };
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                },
            };
        }
        throw e;
    }
}

/**
 * Dev-only fused render-pages endpoint exercising
 * `PDFExtractor.renderPages`. Returns metadata alongside rendered pages
 * so live tests can verify the fused-op shape end-to-end.
 *
 * @deprecated Prefer `npm run beaver-extract -- render <pdf> --pages <list> --out <dir> --json`.
 */
export async function handleTestPdfRenderPagesWithMetaHttpRequest(request: any) {
    const { PDFExtractor, ExtractionError } = await import(
        '../../../src/services/pdf'
    );

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const pageIndices: number[] | undefined = Array.isArray(request?.page_indices)
        ? request.page_indices
        : undefined;
    const pageRange = request?.page_range && typeof request.page_range === 'object'
        ? request.page_range
        : undefined;
    const options = request?.options || {};

    try {
        const result = await new PDFExtractor().renderPages(pdfData, {
            pageIndices,
            pageRange,
            options,
        });
        const pages = result.pages.map((r) => ({
            pageIndex: r.pageIndex,
            format: r.format,
            width: r.width,
            height: r.height,
            scale: r.scale,
            dpi: r.dpi,
            data_base64: uint8ToBase64ForTest(r.data),
            data_byte_length: r.data.byteLength,
        }));
        return {
            ok: true,
            pageCount: result.pageCount,
            pageLabels: result.pageLabels,
            pages,
        };
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                    pageCount: e.pageCount,
                },
            };
        }
        throw e;
    }
}

/**
 * Dev-only PDF detailed-extract endpoint — primitive level.
 *
 * Calls `getMuPDFWorkerClient().extractRawPageDetailed` directly (the worker
 * validates `pageIndex` and emits PAGE_OUT_OF_RANGE). Bypasses
 * `extract({ mode: "structured" })` so the test exercises the raw
 * detailed page, not the sentence mapper.
 *
 * @deprecated Prefer `npm run beaver-extract -- raw-detailed <pdf> --page <n> --json`.
 */
export async function handleTestPdfExtractRawDetailedHttpRequest(request: any) {
    const { ExtractionError } = await import('../../../src/services/pdf');
    const { getMuPDFWorkerClient } = await import(
        '../../../src/services/pdf/MuPDFWorkerClient'
    );

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const pageIndex: unknown = request?.page_index;
    if (typeof pageIndex !== 'number') {
        return {
            ok: false,
            error: { name: 'Error', message: 'page_index (number) is required' },
        };
    }
    const includeImages = request?.include_images === true;

    try {
        const result = await getMuPDFWorkerClient().extractRawPageDetailed(
            pdfData,
            pageIndex,
            { includeImages },
        );
        return { ok: true, result };
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                },
            };
        }
        throw e;
    }
}

/**
 * Dev-only `extract` parity endpoint. Translates the legacy
 * `settings.pages` array into the worker-side `pageIndices` arg so existing
 * live-test bodies (which still pass `{ settings: { pages: [...] } }`) keep
 * working.
 *
 * @deprecated Prefer `npm run beaver-extract -- extract <pdf> --pages <list> --json`.
 *   The CLI defaults to `--mode structured`, matching production extraction.
 */
export async function handleTestPdfExtractHttpRequest(request: any) {
    const { PDFExtractor } = await import('../../../src/services/pdf');
    const settings = { ...(request?.settings || {}) };
    const pageIndices: number[] | undefined = Array.isArray(settings.pages) && settings.pages.length > 0
        ? settings.pages
        : undefined;
    delete settings.pages;
    return runPdfExtractorCall(
        request,
        (pdfData) => new PDFExtractor().extract(pdfData, { settings, pageIndices }),
        (result) => ({ ok: true, result }),
    );
}

/**
 * Dev-only paragraph-engine extract endpoint.
 *
 * Routes through `PDFExtractor.extract` with `markdown: { engine: "paragraph" }`,
 * exercising the line + paragraph detection path. `settings.pages` is
 * translated into the worker-side `pageIndices` arg for parity with the
 * existing extract endpoints. Engine attribution is on `result.metadata.engine`
 * — no separate wrapper-level field, so consumers have one source of truth.
 *
 * @deprecated Prefer `npm run beaver-extract -- extract <pdf> --mode markdown --pages <list> --json`.
 */
export async function handleTestPdfExtractParagraphHttpRequest(request: any) {
    const { PDFExtractor } = await import('../../../src/services/pdf');
    const settings = { ...(request?.settings || {}) };
    const pageIndices: number[] | undefined = Array.isArray(settings.pages) && settings.pages.length > 0
        ? settings.pages
        : undefined;
    delete settings.pages;
    return runPdfExtractorCall(
        request,
        (pdfData) => new PDFExtractor().extract(pdfData, {
            markdown: { engine: 'paragraph' },
            settings,
            pageIndices,
        }),
        (result) => ({ ok: true, result }),
    );
}

/**
 * Dev-only `hasTextLayer` parity endpoint.
 *
 * `hasTextLayer` is a boolean projection of `analyzeOCRNeeds` (identical
 * cost — same sampled-page analysis), so we run `analyzeOCRNeeds` and
 * return `!needsOCR` rather than maintaining a redundant facade method.
 */
export async function handleTestPdfHasTextLayerHttpRequest(request: any) {
    const { PDFExtractor } = await import('../../../src/services/pdf');
    return runPdfExtractorCall(
        request,
        (pdfData) => new PDFExtractor().analyzeOCRNeeds(pdfData),
        (result) => ({ ok: true, hasTextLayer: !result.needsOCR }),
    );
}

/** Dev-only `analyzeOCRNeeds` parity endpoint. */
export async function handleTestPdfAnalyzeOcrHttpRequest(request: any) {
    const { PDFExtractor } = await import('../../../src/services/pdf');
    const options = request?.options || {};
    return runPdfExtractorCall(
        request,
        (pdfData) => new PDFExtractor().analyzeOCRNeeds(pdfData, options),
        (result) => ({ ok: true, result }),
    );
}

/** Dev-only scored-search parity endpoint. */
export async function handleTestPdfSearchScoredHttpRequest(request: any) {
    const { PDFExtractor } = await import('../../../src/services/pdf');
    const query = String(request?.query ?? '');
    const options = request?.options || {};
    return runPdfExtractorCall(
        request,
        (pdfData) => new PDFExtractor().search(pdfData, query, options),
        (result) => ({ ok: true, result }),
    );
}

/**
 * Dev-only sentence-bboxes parity endpoint.
 *
 * Routes through `PDFExtractor.extract({ mode: "structured", pageIndices:
 * [n] })` → MuPDF worker op (single round-trip; analysis-window load, font
 * bridging, filtered paragraph detection, splitter resolution, and
 * sentence mapping all run worker-side). The wire response is shaped as
 * `PageSentenceBBoxResult` — read fields off `pages[0]`.
 *
 * @deprecated Prefer `npm run beaver-extract -- extract <pdf> --pages <n> --json`.
 *   Sentence bboxes live on `result.pages[0].sentences`.
 *
 * Request body:
 *   { library_id, zotero_key | raw_bytes_base64,
 *     page_index: number,
 *     options?: {
 *       splitter?: SentenceSplitterConfig,   // serializable config:
 *                                            //   { type: "sentencex", language?: string }
 *                                            //   | { type: "simple" }
 *                                            // Default: sentencex with `options.language`.
 *       language?: string,                   // seeds sentencex when `splitter` is omitted.
 *                                            // Ignored when an explicit `splitter` is given.
 *       paragraphSettings?: ParagraphDetectionSettings,
 *       analysisWindow?: number,
 *     } }
 *
 * Response: `{ ok: true, result: PageSentenceBBoxResult }` or the
 * structured `ExtractionError` envelope on failure.
 */
export async function handleTestPdfSentenceBBoxesHttpRequest(request: any) {
    const { PDFExtractor } = await import('../../../src/services/pdf');
    const pageIndex = Number(request?.page_index);
    const options = request?.options || {};
    return runPdfExtractorCall(
        request,
        (pdfData) =>
            new PDFExtractor().extract(pdfData, {
                mode: 'structured',
                pageIndices: [pageIndex],
                paragraphSettings: options.paragraphSettings,
                analysisWindow: options.analysisWindow,
                structured: {
                    splitter: options.splitter,
                    language: options.language,
                },
            }),
        (extraction) => {
            const page = extraction.pages[0];
            if (!page) {
                return {
                    ok: false,
                    error: {
                        name: 'Error',
                        message: `page_index ${pageIndex} not extracted`,
                    },
                };
            }
            // Reshape into PageSentenceBBoxResult so callers can
            // consume the same shape the producer returns.
            return {
                ok: true,
                result: {
                    pageIndex: page.index,
                    width: page.width,
                    height: page.height,
                    paragraphs: page.paragraphs ?? [],
                    sentences: page.sentences ?? [],
                    degradation: page.degradation,
                },
            };
        },
    );
}

/**
 * Dev-only render-with-overlay endpoint.
 *
 * Renders one page via MuPDF and paints column/line/paragraph/sentence
 * bboxes on top, returning a base64 PNG. Lets headless agents iterate on
 * extraction code: edit → wait for plugin reload → POST → inspect image.
 *
 * @deprecated Prefer `npm run beaver-extract -- overlay <pdf> --page <n> --level <level> --out <png>`.
 *   The CLI writes the PNG directly to disk (no base64 round-trip) and
 *   composites via sharp instead of OffscreenCanvas. The shared
 *   `debug/overlayBuilders.ts` rect builders are byte-identical between
 *   the two surfaces.
 *
 * Request body:
 *   { library_id, zotero_key | raw_bytes_base64,
 *     page_index: number,
 *     level: "columns" | "lines" | "paragraphs" | "sentences" | "margins",
 *     dpi?: number,                       // default 144
 *     language?: string,                  // sentences only; falls back to item lang
 *     analysis_page_window?: number,      // ±N pages around page_index for
 *                                         // cross-page repeat / page-number
 *                                         // detection and document-wide
 *                                         // style profiling. 0 (default) =
 *                                         // target page only, no neighbors.
 *                                         // Pass Infinity for the whole
 *                                         // document.
 *     settings?: ExtractionSettings }     // margins level only — forwarded
 *                                         // to `analyzeLayout` so the
 *                                         // overlay can be drawn against
 *                                         // the same custom margins /
 *                                         // marginZone / repeatThreshold
 *                                         // used for the matching extract
 *                                         // call.
 *
 * Level dispatch notes:
 *   - `sentences`, `columns`, `lines`, `paragraphs` route through
 *     `PDFExtractor.extract({ mode: "structured", pageIndices: [n] })`
 *     and project the resulting `ProcessedPage` into rects via the pure
 *     `build{Sentence,Column,Line,Paragraph}OverlayFromPage` builders in
 *     `extractionOverlay.ts`. This is the same worker op production
 *     uses, so what the overlay paints is byte-identical to what an
 *     extraction call for the same page produces.
 *   - `margins` routes through `PDFExtractor.analyzeLayout` (which runs
 *     the same shared analysis prefix structured extract runs) and
 *     surfaces `marginAnalysis` / `marginRemoval` for the requested
 *     page. Accepts an optional `settings` field so the overlay can be
 *     drawn against the same custom margins / repeatThreshold
 *     used for the matching extract call.
 *
 * Response: `{ ok: true, image_base64, width, height, page_width,
 *   page_height, group_count, stats, rects }`. `rects` carries the
 *   underlying bbox data so callers can also debug numerically.
 */
export async function handleTestPdfRenderOverlayHttpRequest(request: any) {
    const {
        getMuPDFWorkerClient,
        PDFExtractor,
        ExtractionError,
        ExtractionErrorCode,
    } = await import('../../../src/services/pdf');

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const pageIndex = Number(request?.page_index);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        return {
            ok: false,
            error: { name: 'Error', message: 'page_index (non-negative integer) is required' },
        };
    }
    const level = String(request?.level ?? '');
    if (
        level !== 'columns' &&
        level !== 'lines' &&
        level !== 'paragraphs' &&
        level !== 'sentences' &&
        level !== 'margins'
    ) {
        return {
            ok: false,
            error: {
                name: 'Error',
                message:
                    'level must be one of: columns | lines | paragraphs | sentences | margins',
            },
        };
    }
    const dpi = typeof request?.dpi === 'number' && request.dpi > 0 ? request.dpi : 144;

    const client = getMuPDFWorkerClient();

    // Best-effort item-language lookup feeds sentencex; the worker falls
    // back to the regex splitter on init failure, so language resolution
    // never throws.
    let language: string | undefined =
        typeof request?.language === 'string' ? request.language : undefined;
    if (!language && request?.library_id != null && request?.zotero_key != null) {
        try {
            const { getItemLanguage } = await import('../../../src/utils/zoteroUtils');
            const raw = await getItemLanguage(request.library_id, request.zotero_key);
            if (raw) language = raw;
        } catch {
            // Best effort.
        }
    }
    const analysisWindow =
        request?.analysis_page_window != null
            ? Number(request.analysis_page_window)
            : undefined;

    let overlay: OverlayResult;
    try {
        if (level === 'margins') {
            // Margins level routes through the production-parity
            // `analyzeLayout` op — same shared analysis prefix
            // structured extract uses (page count, page labels,
            // optional OCR check, JSON walk over the analysis
            // window, `buildPageAnalysisContext`). What the overlay
            // paints matches what `extract({ mode: "structured" })`
            // would see for the same `page_index` /
            // `analysis_window` / `settings`.
            //
            // Forward `request.settings` so debugging an
            // extraction call with custom margins / marginZone /
            // repeatThreshold sees the overlay drawn against those
            // same values (the builder reads `result.metadata.settings`
            // for zone rects and per-line classification).
            const settings =
                request?.settings && typeof request.settings === 'object'
                    ? request.settings
                    : undefined;
            const out = await new PDFExtractor().analyzeLayout(pdfData, {
                pageIndices: [pageIndex],
                analysisWindow,
                settings,
            });
            overlay = buildMarginsOverlayFromAnalysis(out, pageIndex);
        } else {
            // sentences / columns / lines / paragraphs: one worker
            // round-trip via the production structured-mode extract.
            // Same op production uses — what we paint here matches
            // what `extract({ mode: "structured" })` produces for
            // the same page byte-for-byte.
            const result = await new PDFExtractor().extract(pdfData, {
                mode: 'structured',
                pageIndices: [pageIndex],
                structured: { language },
                analysisWindow,
            });
            const page = result.pages[0];
            if (!page) {
                return {
                    ok: false,
                    error: {
                        name: 'Error',
                        message: `page_index ${pageIndex} not extracted`,
                    },
                };
            }
            switch (level) {
                case 'sentences':
                    overlay = buildSentenceOverlayFromPage(page);
                    break;
                case 'columns':
                    overlay = buildColumnOverlayFromPage(page);
                    break;
                case 'lines':
                    overlay = buildLineOverlayFromPage(page);
                    break;
                default: // 'paragraphs'
                    overlay = buildParagraphOverlayFromPage(page);
                    break;
            }
        }
    } catch (e) {
        if (e instanceof RangeError) {
            return {
                ok: false,
                error: { name: 'Error', message: e.message },
            };
        }
        if (e instanceof ExtractionError) {
            // Wire-compat: pre-migration the analysis-window resolver
            // threw RangeError for invalid pageIndex (mapped to
            // `name:'Error'`). The worker path now produces
            // ExtractionError(PAGE_OUT_OF_RANGE) for the same case —
            // surface the legacy wire shape.
            if (e.code === ExtractionErrorCode.PAGE_OUT_OF_RANGE) {
                return {
                    ok: false,
                    error: { name: 'Error', message: e.message },
                };
            }
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                },
            };
        }
        throw e;
    }

    const renderOut = await client.renderPages(pdfData, {
        pageIndices: [pageIndex],
        options: { dpi, format: 'png' },
    });
    const rendered = renderOut.pages[0];

    const overlayed = await drawBBoxOverlayPNG(
        rendered.data,
        rendered.width,
        rendered.height,
        overlay.pageWidth,
        overlay.pageHeight,
        overlay.rects,
    );

    return {
        ok: true,
        level: overlay.level,
        page_index: overlay.pageIndex,
        page_width: overlay.pageWidth,
        page_height: overlay.pageHeight,
        image_width: rendered.width,
        image_height: rendered.height,
        dpi: rendered.dpi,
        group_count: overlay.groupCount,
        stats: overlay.stats,
        // Echo the bbox data so a caller debugging numerically doesn't
        // need a second request.
        rects: overlay.rects,
        image_base64: uint8ToBase64ForTest(overlayed),
        image_byte_length: overlayed.byteLength,
    };
}

/**
 * Dev-only extract-trace endpoint — trace variant of structured extraction.
 *
 * Same request body as `pdf-sentence-bboxes` plus top-level `settings`
 * and `mode`. An agent can swap the URL between the two endpoints
 * without restructuring the body.
 *
 * Request body:
 *   { library_id, zotero_key | raw_bytes_base64,
 *     page_index: number,
 *     settings?: ExtractionSettings,     // top-level (matches analyze-layout / render-overlay).
 *                                        // Honored: margins, marginZone, repeatThreshold,
 *                                        // detectPageSequences. Ignored: checkTextLayer,
 *                                        // minTextPerPage (those gate the document at extract()
 *                                        // entry, before any single-page trace runs — silently
 *                                        // ignored here, not an error).
 *     options?: {
 *       splitter?: SentenceSplitterConfig,   // serializable config:
 *                                            //   { type: "sentencex", language? } | { type: "simple" }
 *                                            // Default: sentencex with `options.language`.
 *       language?: string,                   // seeds sentencex when `splitter` is omitted.
 *                                            // Falls back to the Zotero item's language when
 *                                            // both are absent. Ignored when an explicit
 *                                            // `splitter` is given.
 *       analysisWindow?: number,             // ±N pages around page_index for cross-page
 *                                            // smart removal. 0 (default) = target page only.
 *                                            // Pass Infinity for the whole document.
 *       paragraphSettings?: ParagraphDetectionSettings,
 *     },
 *     include_chars?: boolean,           // include per-char quads on raw_lines
 *     mode?: "full" | "triage" }         // "full" (default) returns raw_lines, columns,
 *                                        //   paragraphs, sentences, etc. in full detail.
 *                                        // "triage" omits text bodies / chars / topStyles
 *                                        //   and keeps only triage facts (counts, candidates,
 *                                        //   finalKept=false lines, lines_dropped_by_columns,
 *                                        //   degradation.notes). Typical 10–50× smaller payload.
 *
 * Response shape (selected fields):
 *   { ok: true, page_index, page_width, page_height,
 *     raw_lines: [{ id, text, bbox, font, marginPosition, marginFilter,
 *                   role, finalParagraphId, chars? }],
 *     smart_removal: { analysisRange, candidates },
 *     style_profile: { primaryBodyStyle, bodyStyles, topStyles },
 *     columns: [{ idx, rect, lineIds }],
 *     lines_dropped_by_columns: [...],
 *     paragraphs: [{ id, type, columnIdx, lineIds, text, bbox, role }],
 *     sentences: [{ idx, text, paragraphId, bboxes, degraded }],
 *     sentence_stats }
 *
 * Triage mode echoes `mode: "triage"` on the response (replacing the legacy
 * `mode: "summary"` shape).
 */
export async function handleTestPdfExtractTraceHttpRequest(request: any) {
    const {
        MarginFilter,
        StyleAnalyzer,
        DEFAULT_MARGINS,
        DEFAULT_MARGIN_ZONE,
        ExtractionError,
        getMuPDFWorkerClient,
    } = await import('../../../src/services/pdf');

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const pageIndex = Number(request?.page_index);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        return {
            ok: false,
            error: { name: 'Error', message: 'page_index (non-negative integer) is required' },
        };
    }
    const includeChars = request?.include_chars === true;
    const triage = request?.mode === 'triage';

    // ------------------------------------------------------------------
    // Resolve splitter, analysis window, paragraph settings, and the
    // honored ExtractionSettings fields. Then run the worker trace op
    // for the production pipeline + intermediates in one round-trip.
    // ------------------------------------------------------------------
    const opts = (request?.options ?? {}) as {
        splitter?: { type: 'sentencex'; language?: string } | { type: 'simple' };
        language?: string;
        analysisWindow?: number;
        paragraphSettings?: unknown;
    };

    // Resolve a splitter config. Explicit `options.splitter` wins. Otherwise
    // build a sentencex config seeded by `options.language`, falling back to
    // the Zotero item's language when both are absent.
    let splitterConfig:
        | { type: 'sentencex'; language?: string }
        | { type: 'simple' }
        | undefined = opts.splitter;
    if (!splitterConfig) {
        let language: string | undefined =
            typeof opts.language === 'string' ? opts.language : undefined;
        if (!language && request?.library_id != null && request?.zotero_key != null) {
            try {
                const { getItemLanguage } = await import('../../../src/utils/zoteroUtils');
                const raw = await getItemLanguage(request.library_id, request.zotero_key);
                if (raw) language = raw;
            } catch {
                // Best effort.
            }
        }
        splitterConfig = { type: 'sentencex', language };
    }

    const analysisWindow =
        opts.analysisWindow != null ? Number(opts.analysisWindow) : undefined;

    // ExtractionSettings — only the four layout-related fields are forwarded.
    // checkTextLayer / minTextPerPage gate the document at extract() entry
    // and don't apply to a single-page trace; silently ignored.
    const settings =
        request?.settings && typeof request.settings === 'object'
            ? (request.settings as {
                  margins?: unknown;
                  marginZone?: unknown;
                  repeatThreshold?: number;
                  detectPageSequences?: boolean;
              })
            : undefined;
    const customMargins = (settings?.margins ?? undefined) as
        | typeof DEFAULT_MARGINS
        | undefined;
    const customMarginZone = (settings?.marginZone ?? undefined) as
        | typeof DEFAULT_MARGIN_ZONE
        | undefined;
    const marginsToUse = customMargins ?? DEFAULT_MARGINS;
    const marginZoneToUse = customMarginZone ?? DEFAULT_MARGIN_ZONE;

    let result: PageSentenceBBoxResult;
    let trace: SentenceBBoxTrace;
    try {
        const out = await getMuPDFWorkerClient().extractSentenceBBoxesDebug(
            pdfData,
            pageIndex,
            {
                splitterConfig,
                analysisWindow,
                paragraphSettings: opts.paragraphSettings as never,
                margins: customMargins,
                marginZone: customMarginZone,
                repeatThreshold: settings?.repeatThreshold,
                detectPageSequences: settings?.detectPageSequences,
            },
        );
        result = out.result;
        trace = out.trace;
    } catch (e) {
        if (e instanceof RangeError) {
            return {
                ok: false,
                error: {
                    name: 'Error',
                    message: e.message,
                },
            };
        }
        if (e instanceof ExtractionError) {
            // Wire-compat: pre-migration the analysis-window resolver threw
            // RangeError for invalid pageIndex (mapped to `name:'Error'`).
            // The worker path now produces ExtractionError(PAGE_OUT_OF_RANGE)
            // for the same case — surface the legacy wire shape so existing
            // live tests / HTTP clients keep working.
            const { ExtractionErrorCode } = await import(
                '../../../src/services/pdf'
            );
            if (e.code === ExtractionErrorCode.PAGE_OUT_OF_RANGE) {
                return {
                    ok: false,
                    error: { name: 'Error', message: e.message },
                };
            }
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                },
            };
        }
        throw e;
    }

    // Read the target page from `pagesForFilter` (the substituted detailed
    // page) — bbox object identity in `trace.filteredResult.lineResult` /
    // `paragraphResult` is matched against this page, not against
    // `rawDoc.pages`. Reading from the wrong source breaks every
    // cross-stage link below.
    const targetPage = trace.pagesForFilter.find(
        (p) => p.pageIndex === pageIndex,
    );
    if (!targetPage) {
        return {
            ok: false,
            error: { name: 'Error', message: `page_index ${pageIndex} out of range` },
        };
    }

    // ------------------------------------------------------------------
    // Stage 1: smart-removal analysis (cross-page) — read from trace.
    // ------------------------------------------------------------------
    const smartRemoval = trace.marginRemoval;
    const reasonByText = new Map<string, 'page_number' | 'repeat'>();
    for (const c of smartRemoval.candidates) {
        reasonByText.set(c.text, c.reason);
    }
    const targetPageRemovals =
        smartRemoval.removalsByPage.get(pageIndex) ?? new Set<string>();
    // Body styles drive the simple-margin spare — keeping `keptBySimple`
    // honest with the production pipeline (`MarginFilter
    // .filterPageWithSmartRemoval` now spares body-styled lines from the
    // simple-margin drop). Sourced from the trace's filtered result so the
    // trace shares the production-side style profile.
    const traceBodyStyles = trace.filteredResult.styleProfile.bodyStyles;

    // ------------------------------------------------------------------
    // Stage 2: enumerate raw lines on the target page with stable IDs and
    // margin-filter classification. This is the spine that everything
    // else hangs off — paragraphs reference these IDs.
    // ------------------------------------------------------------------
    type RawLineEntry = {
        id: string;
        text: string;
        bbox: { x: number; y: number; w: number; h: number };
        font: { name: string; family: string; size: number; weight: string; style: string };
        marginPosition: 'top' | 'bottom' | 'left' | 'right' | null;
        marginFilter: {
            keptBySimple: boolean;
            inSmartZone: boolean;
            smartRemoval: 'page_number' | 'repeat' | null;
            finalKept: boolean;
        };
        role: 'heading' | 'body' | 'caption' | 'footnote';
        finalParagraphId: string | null;
        chars?: Array<{ c: string; bbox: { x: number; y: number; w: number; h: number } }>;
    };

    const rawLineEntries: RawLineEntry[] = [];
    // Map raw RawBBox object → entry index, for cross-stage linking via
    // bbox object identity. The line detector preserves the same RawBBox
    // reference (see ColumnDetector.extractFilteredBlocks → DetectedSpan
    // construction), so this is safe within a single pipeline run.
    const bboxToEntryIdx = new Map<object, number>();

    let rawIdx = 0;
    for (const block of targetPage.blocks) {
        if (block.type !== 'text' || !block.lines) continue;
        for (const line of block.lines) {
            const id = `RL${rawIdx++}`;
            const trimmed = (line.text || '').trim();
            const normalized = trimmed.toLowerCase();
            const marginPosition = MarginFilter.getMarginPosition(
                line.bbox,
                targetPage.width,
                targetPage.height,
                marginsToUse,
            );
            const inSmartZone =
                MarginFilter.getMarginPosition(
                    line.bbox,
                    targetPage.width,
                    targetPage.height,
                    marginZoneToUse,
                ) !== null;
            const keptBySimple =
                MarginFilter.isInsideContentArea(
                    line,
                    targetPage.width,
                    targetPage.height,
                    marginsToUse,
                )
                || StyleAnalyzer.looksLikeBodyContent(line, traceBodyStyles);
            const smartReason = inSmartZone
                ? targetPageRemovals.has(normalized)
                    ? reasonByText.get(normalized) ?? 'repeat'
                    : null
                : null;
            const finalKept = keptBySimple && smartReason === null;

            const entry: RawLineEntry = {
                id,
                text: line.text,
                bbox: { x: line.bbox.x, y: line.bbox.y, w: line.bbox.w, h: line.bbox.h },
                font: {
                    name: line.font.name,
                    family: line.font.family,
                    size: line.font.size,
                    weight: line.font.weight,
                    style: line.font.style,
                },
                marginPosition,
                marginFilter: {
                    keptBySimple,
                    inSmartZone,
                    smartRemoval: smartReason,
                    finalKept,
                },
                role: 'body', // filled in once style profile exists
                finalParagraphId: null,
            };
            bboxToEntryIdx.set(line.bbox, rawLineEntries.length);
            rawLineEntries.push(entry);
        }
    }

    // ------------------------------------------------------------------
    // Stages 3-6: style profile + filter + columns + lines + paragraphs
    // — read from `trace.filteredResult`, which the helper computed by
    // running the production filtered-paragraph pipeline on
    // `pagesForFilter` (detailed target page substituted in).
    // ------------------------------------------------------------------
    const styleProfile = trace.filteredResult.styleProfile;
    const columnResult = trace.filteredResult.columnResult;
    const lineResult = trace.filteredResult.lineResult;
    const paragraphResult = trace.filteredResult.paragraphResult;

    // Per-line role classification using the (window-wide) style profile.
    {
        let i = 0;
        for (const block of targetPage.blocks) {
            if (block.type !== 'text' || !block.lines) continue;
            for (const line of block.lines) {
                rawLineEntries[i].role = StyleAnalyzer.classifyRole(line, styleProfile);
                i++;
            }
        }
    }

    // Map columnIndex → array of raw line IDs that contributed.
    const columnLineIds: string[][] = columnResult.columns.map(() => []);
    const linesUsed = new Set<number>();
    for (const colResult of lineResult.columnResults) {
        const colIdx = colResult.columnIndex;
        for (const pageLine of colResult.lines) {
            for (const span of pageLine.spans) {
                const idx = bboxToEntryIdx.get(span.bbox);
                if (idx !== undefined) {
                    if (!columnLineIds[colIdx].includes(rawLineEntries[idx].id)) {
                        columnLineIds[colIdx].push(rawLineEntries[idx].id);
                    }
                    linesUsed.add(idx);
                }
            }
        }
    }
    // Lines that survived margin filtering (simple + smart) but weren't
    // claimed by any column — useful when an agent wonders "why didn't
    // this body line make it into a paragraph?"
    const linesDroppedByColumns: string[] = [];
    rawLineEntries.forEach((e, i) => {
        if (e.marginFilter.finalKept && !linesUsed.has(i)) {
            linesDroppedByColumns.push(e.id);
        }
    });

    const paragraphsOut = paragraphResult.items.map((item, i) => {
        const lineIds: string[] = [];
        const constituentLines = paragraphResult.itemLines?.[i] ?? [];
        for (const pageLine of constituentLines) {
            for (const span of pageLine.spans) {
                const idx = bboxToEntryIdx.get(span.bbox);
                if (idx !== undefined) {
                    if (!lineIds.includes(rawLineEntries[idx].id)) {
                        lineIds.push(rawLineEntries[idx].id);
                    }
                    rawLineEntries[idx].finalParagraphId = item.id;
                }
            }
        }
        return {
            id: item.id,
            type: item.type,
            columnIdx: item.columnIndex,
            lineIds,
            text: item.text,
            bbox: {
                l: item.bbox.l,
                t: item.bbox.t,
                r: item.bbox.r,
                b: item.bbox.b,
                width: item.bbox.width,
                height: item.bbox.height,
            },
        };
    });

    // ------------------------------------------------------------------
    // Stage 7: sentences (paragraph-scoped). Already produced by the
    // helper — `trace.sentenceResult` is the same reference as `result`.
    // ------------------------------------------------------------------
    const sentenceResult = result;
    const detailed = trace.detailed;

    // Mark which paragraphs degraded so we can flag fallback sentences.
    const degradedItemIndices = new Set(
        (sentenceResult.degradation?.notes ?? []).map((n) => n.itemIndex),
    );
    const sentencesOut: Array<{
        idx: number;
        text: string;
        paragraphId: string | null;
        paragraphIndex: number;
        sentenceIndex: number;
        joinWithNext?: boolean;
        bboxes: Array<{ x: number; y: number; w: number; h: number }>;
        degraded: boolean;
    }> = [];
    let flatSentenceIdx = 0;
    sentenceResult.paragraphs.forEach((pws, paragraphArrayIdx) => {
        const isDegradedItem = degradedItemIndices.has(paragraphArrayIdx);
        for (const sentence of pws.sentences) {
            const isFallback =
                isDegradedItem &&
                pws.sentences.length === 1 &&
                pws.sentences[0].text === pws.item.text;
            const entry: typeof sentencesOut[number] = {
                idx: flatSentenceIdx++,
                text: sentence.text,
                paragraphId: pws.item.id ?? null,
                paragraphIndex: sentence.paragraphIndex,
                sentenceIndex: sentence.sentenceIndex,
                bboxes: sentence.bboxes.map((b) => ({
                    x: b.x,
                    y: b.y,
                    w: b.w,
                    h: b.h,
                })),
                degraded: isFallback,
            };
            // Only emit when truthy. Omitted ≡ false.
            if (sentence.joinWithNext) {
                entry.joinWithNext = true;
            }
            sentencesOut.push(entry);
        }
    });

    // ------------------------------------------------------------------
    // Optionally include per-character quads on raw_lines.
    // Bridge by 3-decimal-rounded bbox key
    // ------------------------------------------------------------------
    if (includeChars) {
        const detailedByBboxKey = new Map<string, typeof detailed.blocks[0]['lines'] extends (infer L)[] | undefined ? L : never>();
        const keyOf = (b: { x: number; y: number; w: number; h: number }) =>
            `${b.x.toFixed(3)}|${b.y.toFixed(3)}|${b.w.toFixed(3)}|${b.h.toFixed(3)}`;
        for (const block of detailed.blocks) {
            if (block.type !== 'text' || !block.lines) continue;
            for (const line of block.lines) {
                detailedByBboxKey.set(keyOf(line.bbox), line);
            }
        }
        for (const entry of rawLineEntries) {
            const detailedLine = detailedByBboxKey.get(keyOf(entry.bbox));
            if (detailedLine && detailedLine.chars) {
                entry.chars = detailedLine.chars.map((ch) => ({
                    c: ch.c,
                    bbox: { x: ch.bbox.x, y: ch.bbox.y, w: ch.bbox.w, h: ch.bbox.h },
                }));
            }
        }
    }

    // ------------------------------------------------------------------
    // Build the response.
    // ------------------------------------------------------------------
    const candidatesOut = smartRemoval.candidates.map((c) => ({
        text: c.text,
        originalText: c.originalText,
        reason: c.reason,
        position: c.position,
        pageIndices: c.pageIndices,
    }));

    if (triage) {
        // Triage view
        const finalDropped = rawLineEntries
            .filter((e) => !e.marginFilter.finalKept)
            .map((e) => ({
                id: e.id,
                bbox: e.bbox,
                marginPosition: e.marginPosition,
                marginFilter: e.marginFilter,
                role: e.role,
                textPreview: e.text.slice(0, 80),
            }));
        return {
            ok: true,
            mode: 'triage',
            page_index: pageIndex,
            page_width: targetPage.width,
            page_height: targetPage.height,
            page_label: targetPage.label,
            counts: {
                rawLines: rawLineEntries.length,
                rawLinesFinalKept: rawLineEntries.filter((e) => e.marginFilter.finalKept)
                    .length,
                rawLinesDroppedBySimple: rawLineEntries.filter(
                    (e) => !e.marginFilter.keptBySimple,
                ).length,
                rawLinesDroppedBySmart: rawLineEntries.filter(
                    (e) => e.marginFilter.smartRemoval !== null,
                ).length,
                columns: columnResult.columns.length,
                paragraphs: paragraphsOut.length,
                headers: paragraphsOut.filter((p) => p.type === 'header').length,
                sentences: sentencesOut.length,
            },
            smart_removal: {
                analysisRange: [
                    trace.analysisPageIndices[0],
                    trace.analysisPageIndices[trace.analysisPageIndices.length - 1],
                ],
                analysisPagesScanned: trace.analysisPageIndices.length,
                candidates: candidatesOut,
            },
            primaryBodyStyle: styleProfile.primaryBodyStyle,
            column_detection: {
                isBroken: columnResult.isBroken,
                columnCount: columnResult.columnCount,
            },
            raw_lines_final_dropped: finalDropped,
            lines_dropped_by_columns: linesDroppedByColumns,
            sentence_stats: {
                sentences: sentenceResult.sentences.length,
                paragraphs: sentenceResult.paragraphs.length,
                degradation: {
                    count: sentenceResult.degradation?.count ?? 0,
                    notes: sentenceResult.degradation?.notes ?? [],
                },
            },
        };
    }

    // Top styles for the snapshot — Maps don't survive JSON, so flatten.
    const topStyles = Array.from(styleProfile.styleCounts.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
        .map((entry) => ({
            count: entry.count,
            style: entry.style,
            isBody: styleProfile.bodyStyles.some(
                (s) =>
                    s.size === entry.style.size &&
                    s.font === entry.style.font &&
                    s.bold === entry.style.bold &&
                    s.italic === entry.style.italic,
            ),
        }));

    return {
        ok: true,
        page_index: pageIndex,
        page_width: targetPage.width,
        page_height: targetPage.height,
        page_label: targetPage.label,
        raw_lines: rawLineEntries,
        smart_removal: {
            analysisRange: [
                trace.analysisPageIndices[0],
                trace.analysisPageIndices[trace.analysisPageIndices.length - 1],
            ],
            analysisPagesScanned: trace.analysisPageIndices.length,
            candidates: candidatesOut,
        },
        style_profile: {
            primaryBodyStyle: styleProfile.primaryBodyStyle,
            bodyStyles: styleProfile.bodyStyles,
            topStyles,
        },
        columns: columnResult.columns.map((rect, i) => ({
            idx: i,
            rect,
            lineIds: columnLineIds[i],
        })),
        column_detection: {
            isBroken: columnResult.isBroken,
            columnCount: columnResult.columnCount,
        },
        lines_dropped_by_columns: linesDroppedByColumns,
        paragraphs: paragraphsOut,
        sentences: sentencesOut,
        sentence_stats: {
            sentences: sentenceResult.sentences.length,
            paragraphs: sentenceResult.paragraphs.length,
            degradation: {
                count: sentenceResult.degradation?.count ?? 0,
                notes: sentenceResult.degradation?.notes ?? [],
            },
        },
    };
}

/**
 * Dev-only document-wide style + margin analysis endpoint.
 *
 * Routes through `PDFExtractor.analyzeLayout` which runs the EXACT
 * shared analysis prefix `extract({ mode: "structured" })` runs (page
 * count, page labels, optional OCR check, JSON walk over the analysis
 * window, `buildPageAnalysisContext`). Output is byte-identical to the
 * analysis context production extract uses for the same `settings` /
 * `page_indices` / `analysis_window`.
 *
 * @deprecated Prefer `npm run beaver-extract -- analyze-layout <pdf> --pages <list> --json`.
 *   Wire shape comes from the shared `debug/analyzeLayoutProjection.ts`,
 *   so this endpoint and the CLI emit the exact same JSON.
 *
 * Use this to inspect prod-side margin candidates, removal decisions,
 * and font/style profile without paying for per-page extraction. Same
 * input contract as `extract`'s wire format — `page_range` uses
 * `start_index` / `end_index` / `max_pages`. For triage parity with the
 * old smart-removal-summary endpoint, pass
 * `settings.checkTextLayer: false` plus the desired
 * `settings.repeatThreshold` / `settings.detectPageSequences` and read
 * `result.analysis.marginRemoval`.
 *
 * Request body:
 *   { library_id, zotero_key | raw_bytes_base64,
 *     page_indices?: number[],                      // OR
 *     page_range?: { start_index, end_index?, max_pages? },
 *     analysis_window?: number,                     // ±N pages around each
 *                                                   // target. 0 (default) =
 *                                                   // target pages only,
 *                                                   // no neighbors. Pass
 *                                                   // Infinity for the whole
 *                                                   // document. Mirrors
 *                                                   // `extract`'s argument.
 *     settings?: ExtractionSettings }               // margins, marginZone, etc.
 *
 * Response — Map/Set fields are flattened to plain JSON:
 *   { ok: true,
 *     page_count: number,
 *     analysis_page_indices: number[],
 *     pages: RawPageData[],
 *     page_labels?: { [pageIndex]: string },
 *     analysis: {
 *       style_profile: { primaryBodyStyle, bodyStyles, styleCounts },
 *       margin_analysis: { elements, counts },
 *       margin_removal: { candidates, removalsByPage, textsToRemove }
 *     },
 *     metadata: { extractedAt, version, settings, timings } }
 */
export async function handleTestPdfAnalyzeLayoutHttpRequest(request: any) {
    const { PDFExtractor, ExtractionError, ExtractionErrorCode } = await import(
        '../../../src/services/pdf'
    );

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const pageIndices: number[] | undefined = Array.isArray(request?.page_indices)
        ? (request.page_indices as unknown[]).map((n) => Number(n))
        : undefined;

    let pageRange:
        | { startIndex: number; endIndex?: number; maxPages?: number }
        | undefined;
    if (request?.page_range && typeof request.page_range === 'object') {
        const r = request.page_range;
        // Pass `Number(...)` straight through — `resolvePageRangeOrThrow` is
        // strict and rejects NaN / negative / out-of-range with a structured
        // ExtractionError. Coercing to 0 here would silently re-route an
        // agent's typo to page 0.
        pageRange = {
            startIndex: Number(r.start_index ?? r.startIndex),
        };
        if (r.end_index != null || r.endIndex != null) {
            pageRange.endIndex = Number(r.end_index ?? r.endIndex);
        }
        if (r.max_pages != null || r.maxPages != null) {
            pageRange.maxPages = Number(r.max_pages ?? r.maxPages);
        }
    }

    const analysisWindow =
        request?.analysis_window != null
            ? Number(request.analysis_window)
            : undefined;
    const settings =
        request?.settings && typeof request.settings === 'object'
            ? request.settings
            : undefined;

    try {
        const result = await new PDFExtractor().analyzeLayout(pdfData, {
            settings,
            pageIndices,
            pageRange,
            analysisWindow,
        });

        // Flatten Map/Set fields — `JSON.stringify` would otherwise serialize
        // them as `{}`. The CLI `analyze-layout` command consumes the same
        // projection so wire shape stays in lockstep across both surfaces.
        return { ok: true, ...projectAnalyzeLayout(result) };
    } catch (e: any) {
        if (e instanceof ExtractionError) {
            if (e.code === ExtractionErrorCode.PAGE_OUT_OF_RANGE) {
                return { ok: false, error: { name: 'Error', message: e.message } };
            }
            // Same payload shape `runPdfExtractorCall` writes (lines
            // 130-134). The rehydrated client-side `ExtractionError` carries
            // OCR data on `e.details` (types.ts), which the wire layer
            // surfaces as `ocrAnalysis` for self-documenting JSON.
            return {
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: e.code,
                    message: e.message,
                    payload: {
                        ocrAnalysis: e.details,
                        pageLabels: e.pageLabels,
                        pageCount: e.pageCount,
                    },
                },
            };
        }
        return {
            ok: false,
            error: {
                name: e?.name ?? 'Error',
                message: e?.message ?? String(e),
            },
        };
    }
}
