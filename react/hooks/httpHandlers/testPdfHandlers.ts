/**
 * Dev-only HTTP handlers for the `/beaver/test/pdf-*` endpoints.
 *
 * Extracted from `useHttpEndpoints.ts` to keep that file focused on
 * registration. Handler exports are wired to paths in
 * `useHttpEndpoints.ts` → `registerEndpoints()`.
 */

import {
    buildColumnOverlayFromDebugPage,
    buildItemOverlayFromDebugPage,
    buildLineOverlayFromDebugPage,
    buildSentenceOverlayFromDebugPage,
    buildMarginsOverlayFromAnalysis,
} from '../../utils/extractionOverlay';
import type { OverlayResult } from '../../utils/extractionOverlay';
import { drawBBoxOverlayPNG } from '../../utils/canvasOverlay';
import type {
    BoundingBox,
} from '../../../src/beaver-extract';
import { projectAnalyzeLayout } from '../../../src/beaver-extract/debug/analyzeLayoutProjection';
import { projectTracePage } from '../../../src/beaver-extract/debug/traceProjection';
import { UNRESOLVED_LIBRARY_ID } from '../../../src/utils/libraryIdentity';


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
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
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
 * Helper that wraps a BeaverExtractor call and serializes ExtractionError
 * (including the `details` payload) into the structured wire shape used by
 * live parity tests.
 */
async function runPdfExtractorCall<T>(
    request: any,
    fn: (pdfData: Uint8Array) => Promise<T>,
    onSuccess: (result: T) => any,
): Promise<any> {
    const { ExtractionError } = await import('../../../src/beaver-extract');
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
    const { BeaverExtractor, ExtractionError } = await import(
        '../../../src/beaver-extract'
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
        if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
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
        const count = await new BeaverExtractor().getPageCount(pdfData);
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
 * Dev-only PDF metadata endpoint. Routes through `BeaverExtractor`, which
 * delegates to the MuPDF worker. Returns page count, page labels, and
 * cheap info-dict fields (title, author, format, etc.).
 *
 * @deprecated Prefer `npm run beaver-extract -- info <pdf>`.
 */
export async function handleTestPdfPageLabelsHttpRequest(request: any) {
    const { BeaverExtractor, ExtractionError } = await import(
        '../../../src/beaver-extract'
    );

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    try {
        const metadata = await new BeaverExtractor().getMetadata(pdfData);
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
 * `BeaverExtractor.renderPages` and discards the metadata — the legacy
 * `{ ok, pages }` response shape is preserved for live-test parity.
 * Image bytes are base64-encoded for JSON transport; live tests decode
 * for parity.
 *
 * @deprecated Prefer `npm run beaver-extract -- render <pdf> --pages 0 --out <dir>`.
 *   The CLI writes PNGs to disk and avoids the base64 round-trip.
 */
export async function handleTestPdfRenderPagesHttpRequest(request: any) {
    const { BeaverExtractor, ExtractionError } = await import(
        '../../../src/beaver-extract'
    );

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const pageIndices: number[] | undefined = Array.isArray(request?.page_indices)
        ? request.page_indices
        : undefined;
    const options = request?.options || {};

    try {
        const result = await new BeaverExtractor().renderPages(
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
 * `BeaverExtractor.renderPages`. Returns metadata alongside rendered pages
 * so live tests can verify the fused-op shape end-to-end.
 *
 * @deprecated Prefer `npm run beaver-extract -- render <pdf> --pages <list> --out <dir> --json`.
 */
export async function handleTestPdfRenderPagesWithMetaHttpRequest(request: any) {
    const { BeaverExtractor, ExtractionError } = await import(
        '../../../src/beaver-extract'
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
        const result = await new BeaverExtractor().renderPages(pdfData, {
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
    const { ExtractionError } = await import('../../../src/beaver-extract');
    const { getMuPDFWorkerClient } = await import(
        '../../../src/beaver-extract/MuPDFWorkerClient'
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
    const { BeaverExtractor } = await import('../../../src/beaver-extract');
    const settings = { ...(request?.settings || {}) };
    const pageIndices: number[] | undefined = Array.isArray(settings.pages) && settings.pages.length > 0
        ? settings.pages
        : undefined;
    delete settings.pages;
    return runPdfExtractorCall(
        request,
        (pdfData) => new BeaverExtractor().extract(pdfData, { settings, pageIndices }),
        (result) => ({ ok: true, result }),
    );
}

/**
 * Dev-only paragraph-engine extract endpoint.
 *
 * Routes through `BeaverExtractor.extract` with `markdown: { engine: "paragraph" }`,
 * exercising the line + paragraph detection path. `settings.pages` is
 * translated into the worker-side `pageIndices` arg for parity with the
 * existing extract endpoints. Engine attribution is on `result.metadata.engine`
 * — no separate wrapper-level field, so consumers have one source of truth.
 *
 * @deprecated Prefer `npm run beaver-extract -- extract <pdf> --mode markdown --pages <list> --json`.
 */
export async function handleTestPdfExtractParagraphHttpRequest(request: any) {
    const { BeaverExtractor } = await import('../../../src/beaver-extract');
    const settings = { ...(request?.settings || {}) };
    const pageIndices: number[] | undefined = Array.isArray(settings.pages) && settings.pages.length > 0
        ? settings.pages
        : undefined;
    delete settings.pages;
    return runPdfExtractorCall(
        request,
        (pdfData) => new BeaverExtractor().extract(pdfData, {
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
    const { BeaverExtractor } = await import('../../../src/beaver-extract');
    return runPdfExtractorCall(
        request,
        (pdfData) => new BeaverExtractor().analyzeOCRNeeds(pdfData),
        (result) => ({ ok: true, hasTextLayer: !result.needsOCR }),
    );
}

/** Dev-only `analyzeOCRNeeds` parity endpoint. */
export async function handleTestPdfAnalyzeOcrHttpRequest(request: any) {
    const { BeaverExtractor } = await import('../../../src/beaver-extract');
    const options = request?.options || {};
    return runPdfExtractorCall(
        request,
        (pdfData) => new BeaverExtractor().analyzeOCRNeeds(pdfData, options),
        (result) => ({ ok: true, result }),
    );
}

/** Dev-only scored-search parity endpoint. */
export async function handleTestPdfSearchScoredHttpRequest(request: any) {
    const { BeaverExtractor } = await import('../../../src/beaver-extract');
    const query = String(request?.query ?? '');
    const options = request?.options || {};
    return runPdfExtractorCall(
        request,
        (pdfData) => new BeaverExtractor().search(pdfData, query, options),
        (result) => ({ ok: true, result }),
    );
}

/**
 * Dev-only sentence-bboxes parity endpoint.
 *
 * Routes through the full-document structured trace op and projects the
 * requested page from its debug payload. This keeps sentence bboxes aligned
 * with production structured extraction.
 *
 * @deprecated Prefer `npm run beaver-extract -- trace <pdf> --page <n> --json`.
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
 * Response: `{ ok: true, result: { pageIndex, width, height, items, sentences } }` or the
 * structured `ExtractionError` envelope on failure.
 */
export async function handleTestPdfSentenceBBoxesHttpRequest(request: any) {
    const { getMuPDFWorkerClient } = await import('../../../src/beaver-extract');
    const pageIndex = Number(request?.page_index ?? request?.page);
    const options = request?.options || {};
    return runPdfExtractorCall(
        request,
        (pdfData) =>
            getMuPDFWorkerClient().structuredExtractWithDebug(pdfData, {
                capturePages: [pageIndex],
                debugMode: 'full',
                structured: {
                    splitterConfig: options.splitter ?? (
                        options.language
                            ? { type: 'sentencex', language: options.language }
                            : undefined
                    ),
                },
                paragraphSettings: options.paragraphSettings,
                analysisWindow: options.analysisWindow,
            }),
        (extraction) => {
            const page = extraction.debug.pages?.[String(pageIndex)];
            if (!page) throw new Error(`page ${pageIndex} missing from trace`);
            return {
                ok: true,
                result: {
                    pageIndex: page.pageIndex,
                    width: page.width,
                    height: page.height,
                    items: page.items ?? [],
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
 *     level: "columns" | "lines" | "items" | "sentences" | "margins",
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
 *   - `sentences`, `columns`, `lines`, `items`, `paragraphs` route through
 *     the full-document structured trace op and project the requested page
 *     into rects via the pure debug-page overlay builders.
 *   - `margins` routes through `BeaverExtractor.analyzeLayout` (which runs
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
        BeaverExtractor,
        ExtractionError,
        ExtractionErrorCode,
    } = await import('../../../src/beaver-extract');

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
        level !== 'items' &&
        level !== 'sentences' &&
        level !== 'margins'
    ) {
        return {
            ok: false,
            error: {
                name: 'Error',
                message:
                    'level must be one of: columns | lines | items | sentences | margins',
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
            const out = await new BeaverExtractor().analyzeLayout(pdfData, {
                pageIndices: [pageIndex],
                analysisWindow,
                settings,
            });
            overlay = buildMarginsOverlayFromAnalysis(out, pageIndex);
        } else {
            // sentences / columns / lines / items: one worker
            // round-trip via the production structured-mode extract.
            // Same op production uses — what we paint here matches
            // what `extract({ mode: "structured" })` produces for
            // the same page byte-for-byte.
            const traceOut = await client.structuredExtractWithDebug(pdfData, {
                capturePages: [pageIndex],
                debugMode: 'full',
                structured: {
                    splitterConfig: language
                        ? { type: 'sentencex', language }
                        : undefined,
                },
                analysisWindow,
            });
            const page = traceOut.debug.pages?.[String(pageIndex)];
            if (!page) throw new Error(`page ${pageIndex} missing from trace`);
            switch (level) {
                case 'sentences':
                    overlay = buildSentenceOverlayFromDebugPage(page);
                    break;
                case 'columns':
                    overlay = buildColumnOverlayFromDebugPage(page);
                    break;
                case 'lines':
                    overlay = buildLineOverlayFromDebugPage(page);
                    break;
                case 'items':
                    overlay = buildItemOverlayFromDebugPage(page);
                    break;
                default:
                    throw new Error(`Unhandled overlay level: ${level}`);
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
 *                                        // detectPageSequences, graphicsLayerMode. Ignored:
 *                                        // checkTextLayer, minTextPerPage (those gate the
 *                                        // document at extract() entry, before any single-page
 *                                        // trace runs — silently ignored here, not an error).
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
 *                                        //   items, sentences, etc. in full detail.
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
 *     paragraphs: [{ id, type, columnIdx, lineIds, text, bbox, role }], // legacy key for items
 *     sentences: [{ idx, text, parentId, bboxes, degraded }],
 *     sentence_stats }
 *
 * Triage mode echoes `mode: "triage"` on the response (replacing the legacy
 * `mode: "summary"` shape).
 */
export async function handleTestPdfExtractTraceHttpRequest(request: any) {
    const { ExtractionError, getMuPDFWorkerClient } = await import('../../../src/beaver-extract');

    const loaded = await loadPdfBytesForTestEndpoint(request);
    if (!loaded.ok) return loaded;
    const { pdfData } = loaded;

    const pageIndex = Number(request?.page_index ?? request?.page);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        return {
            ok: false,
            error: { name: 'Error', message: 'page_index (non-negative integer) is required' },
        };
    }

    const mode = request?.mode === 'full' ? 'full' : 'triage';
    const opts = (request?.options ?? {}) as {
        splitter?: { type: 'sentencex'; language?: string } | { type: 'simple' };
        language?: string;
        analysisWindow?: number;
        paragraphSettings?: unknown;
    };
    const splitterConfig = opts.splitter ?? {
        type: 'sentencex' as const,
        language: typeof opts.language === 'string' ? opts.language : undefined,
    };
    const settings = request?.settings && typeof request.settings === 'object'
        ? request.settings
        : undefined;

    try {
        const out = await getMuPDFWorkerClient().structuredExtractWithDebug(
            pdfData,
            {
                capturePages: [pageIndex],
                debugMode: mode,
                structured: { splitterConfig },
                analysisWindow: opts.analysisWindow != null ? Number(opts.analysisWindow) : undefined,
                paragraphSettings: opts.paragraphSettings as never,
                settings: settings as never,
            },
        );
        return {
            ok: true,
            ...projectTracePage(out.result, out.debug, pageIndex, mode),
        };
    } catch (e) {
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
 * Dev-only document-wide style + margin analysis endpoint.
 *
 * Routes through `BeaverExtractor.analyzeLayout` which runs the EXACT
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
    const { BeaverExtractor, ExtractionError, ExtractionErrorCode } = await import(
        '../../../src/beaver-extract'
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
        const result = await new BeaverExtractor().analyzeLayout(pdfData, {
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
