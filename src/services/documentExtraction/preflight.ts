import type { DocumentPreflightMetadata } from '../documentCache';

/**
 * Reasons a PDF request can short-circuit from cached metadata alone.
 */
export type PreflightErrorCode = 'encrypted' | 'invalid_pdf' | 'no_text_layer' | 'too_many_pages';

export interface PreflightFailure {
    code: PreflightErrorCode;
    pageCount: number | null;
    /** Populated only when code === 'too_many_pages'. */
    maxPageCount?: number;
}

export interface PreflightOptions {
    /** If false, skip the OCR check. Image rendering does not need a text layer. */
    checkOcr: boolean;
    /** If true and `page_count` is known, apply the page-count cap. */
    applyPageCountCap: boolean;
    /** From `getPref('maxPageCount')`. Required when `applyPageCountCap` is true. */
    maxPageCount: number;
}

/**
 * Check cached PDF metadata for terminal errors or page-count rejection.
 */
export function preflightCachedPdfMeta(
    cachedMeta: DocumentPreflightMetadata | null,
    opts: PreflightOptions,
): PreflightFailure | null {
    if (!cachedMeta) return null;

    const pageCount = cachedMeta.pageCount ?? null;
    if (cachedMeta.errorCode) {
        if (cachedMeta.errorCode === 'no_text_layer') {
            if (opts.checkOcr) {
                return { code: 'no_text_layer', pageCount };
            }
        } else {
            return { code: cachedMeta.errorCode, pageCount };
        }
    }

    if (opts.applyPageCountCap && pageCount != null && pageCount > opts.maxPageCount) {
        return {
            code: 'too_many_pages',
            pageCount,
            maxPageCount: opts.maxPageCount,
        };
    }
    return null;
}
