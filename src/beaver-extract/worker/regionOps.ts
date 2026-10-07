/**
 * Region detection op: candidates per page (pictures, tables, display
 * equations, decorations) with features and, when a trained model is
 * available, class probabilities. Used by `beaver-extract regions` for
 * debugging and training export; structured extraction runs the detector
 * itself (`worker/ops.ts`).
 *
 * Each target page is walked once with the graphics-summary tee (the same
 * detailed walk structured extraction uses). Document context — on how many
 * pages each image recurs — comes from the target pages plus up to
 * `contextPages` further pages (graphics summary only).
 */
import type { RawPageDataDetailed } from "@beaver/agent-core/extract/types";

import { isFatalWasmError, isHeapExhaustionError } from "../wasmFatal";
import { buildRegionDocContext } from "../regions/docContext";
import { REGION_FEATURES, REGION_FEATURE_VERSION } from "../regions/features";
import { detectRegions, type DetectedRegion } from "../regions/RegionDetector";
import { REGION_MODEL } from "../regions/weights";
import { acquireDoc, releaseDoc } from "./docCache";
import { extractRawPageDetailedFromDoc, resolveTruePageCount } from "./docHelpers";
import { ERROR_CODES, workerError } from "./errors";
import type { GraphicsSummary } from "./graphicsSummary";
import type { OpReply } from "./ops";
import { ensureApi } from "./wasmInit";

export interface RegionPageResult {
    pageIndex: number;
    width: number;
    height: number;
    scanned: boolean;
    bodySize: number;
    /** Detailed text walk including the graphics tee. */
    walkMs: number;
    /** Region detector alone. */
    detectMs: number;
    graphics: { records: number; overflow: boolean };
    candidates: DetectedRegion[];
    /** With `includeLines`: [x0, y0, x1, y1, chars, flags] per text line. */
    lines?: number[][];
    error?: string;
}

export interface RegionDetectionResult {
    pageCount: number;
    featureVersion: number;
    features: readonly string[];
    /** Provenance of the classifier, or null when candidates are unclassified. */
    model: string | null;
    pages: RegionPageResult[];
}

export const DEFAULT_REGION_CONTEXT_PAGES = 12;

export type RegionDetectionMeta = Pick<RegionDetectionResult, "featureVersion" | "features" | "model">;

/** Feature schema and classifier provenance that a detection run reports. */
export function regionDetectionMeta(classify = true): RegionDetectionMeta {
    return {
        featureVersion: REGION_FEATURE_VERSION,
        features: REGION_FEATURES,
        model: classify && REGION_MODEL ? REGION_MODEL.trainedOn : null,
    };
}

/**
 * A WASM trap or heap exhaustion leaves the runtime unusable: the op must fail
 * so the document is released as failed. Other page errors are reported per
 * page (detection mode) and leave the document usable.
 */
function abortsDocument(e: unknown): boolean {
    return isFatalWasmError(e) || isHeapExhaustionError(e);
}

export async function opDetectRegions(args: {
    pdfData: Uint8Array | ArrayBuffer;
    pageIndices: number[];
    contextPages?: number;
    classify?: boolean;
    /** Also return each page's text lines with routing flags (see `RegionDetection.lines`). */
    includeLines?: boolean;
}): Promise<OpReply<RegionDetectionResult>> {
    const api = await ensureApi();
    if (!api.supportsGraphicsSummary) {
        throw workerError(ERROR_CODES.WASM_ERROR, "This MuPDF build has no graphics summary support");
    }
    const model = args.classify === false ? null : REGION_MODEL;
    const doc = await acquireDoc(args.pdfData);
    let docFailed = false;
    try {
        const pageCount = resolveTruePageCount(doc);
        for (const i of args.pageIndices) {
            if (!Number.isInteger(i) || i < 0 || i >= pageCount) {
                throw workerError(ERROR_CODES.PAGE_OUT_OF_RANGE, `Page index ${i} out of range (0..${pageCount - 1})`);
            }
        }

        const walked = new Map<number, { page: RawPageDataDetailed; graphics: GraphicsSummary; ms: number }>();
        const errors = new Map<number, string>();
        for (const i of args.pageIndices) {
            const start = performance.now();
            try {
                let graphics: GraphicsSummary | null = null;
                const page = extractRawPageDetailedFromDoc(doc, i, false, api.Font, undefined, {
                    onGraphics: (g) => {
                        graphics = g;
                    },
                    fontSpans: true,
                });
                if (!graphics) throw new Error("graphics summary missing");
                walked.set(i, { page, graphics, ms: performance.now() - start });
            } catch (e) {
                if (abortsDocument(e)) throw e;
                errors.set(i, e instanceof Error ? e.message : String(e));
            }
        }

        const summaries = [...walked.values()].map((w) => w.graphics);
        const extra = Math.max(0, args.contextPages ?? DEFAULT_REGION_CONTEXT_PAGES);
        for (let i = 0, added = 0; i < pageCount && added < extra; i++) {
            if (walked.has(i) || errors.has(i)) continue;
            try {
                const page = doc.loadPage(i);
                try {
                    summaries.push(page.getGraphicsSummary());
                } finally {
                    page.destroy();
                }
            } catch (e) {
                // A broken context page only weakens the context.
                if (abortsDocument(e)) throw e;
            }
            added++;
        }
        const docContext = buildRegionDocContext(summaries);

        const pages = args.pageIndices.map((i): RegionPageResult => {
            const w = walked.get(i);
            if (!w) {
                return {
                    pageIndex: i, width: 0, height: 0, scanned: false, bodySize: 0, walkMs: 0, detectMs: 0,
                    graphics: { records: 0, overflow: false }, candidates: [], error: errors.get(i),
                };
            }
            const detection = detectRegions(w.page, w.graphics, {
                pageIndex: i,
                doc: docContext,
                model,
                includeLines: args.includeLines,
            });
            return {
                pageIndex: i,
                width: w.page.width,
                height: w.page.height,
                scanned: detection.scanned,
                bodySize: detection.bodySize,
                walkMs: w.ms,
                detectMs: detection.ms,
                graphics: { records: w.graphics.count, overflow: w.graphics.overflow },
                candidates: detection.candidates,
                ...(detection.lines ? { lines: detection.lines } : {}),
            };
        });
        return {
            result: {
                pageCount,
                ...regionDetectionMeta(model !== null),
                pages,
            },
        };
    } catch (e) {
        docFailed = true;
        throw e;
    } finally {
        releaseDoc(doc, docFailed);
    }
}
