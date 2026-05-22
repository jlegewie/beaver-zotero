/**
 * Tests for `preflightCachedPdfMeta`, the pure document-cache preflight helper
 * shared by PDF agent handlers.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: { toString: () => 'searchableLibraryIdsAtom' },
}));

import { preflightCachedPdfMeta } from '../../../src/services/agentDataProvider/utils';
import type { DocumentPreflightMetadata } from '../../../src/services/documentCache';

function makeMeta(
    overrides: Partial<DocumentPreflightMetadata> = {},
): DocumentPreflightMetadata {
    return {
        pageCount: 10,
        pageLabels: null,
        errorCode: null,
        contentType: 'application/pdf',
        ...overrides,
    };
}

describe('preflightCachedPdfMeta', () => {
    it('returns null when cachedMeta is null', () => {
        expect(preflightCachedPdfMeta(null, {
            checkOcr: true,
            applyPageCountCap: true,
            maxPageCount: 1000,
        })).toBeNull();
    });

    it('returns null when errorCode is null and page count is within limits', () => {
        const result = preflightCachedPdfMeta(makeMeta(), {
            checkOcr: true,
            applyPageCountCap: true,
            maxPageCount: 1000,
        });
        expect(result).toBeNull();
    });

    it('returns encrypted for encrypted metadata', () => {
        const result = preflightCachedPdfMeta(
            makeMeta({ errorCode: 'encrypted', pageCount: 5 }),
            { checkOcr: true, applyPageCountCap: true, maxPageCount: 1000 },
        );
        expect(result).toEqual({ code: 'encrypted', pageCount: 5 });
    });

    it('returns invalid_pdf for invalid metadata', () => {
        const result = preflightCachedPdfMeta(
            makeMeta({ errorCode: 'invalid_pdf', pageCount: null }),
            { checkOcr: true, applyPageCountCap: true, maxPageCount: 1000 },
        );
        expect(result).toEqual({ code: 'invalid_pdf', pageCount: null });
    });

    it('returns no_text_layer when OCR checking is enabled', () => {
        const result = preflightCachedPdfMeta(
            makeMeta({ errorCode: 'no_text_layer', pageCount: 7 }),
            { checkOcr: true, applyPageCountCap: true, maxPageCount: 1000 },
        );
        expect(result).toEqual({ code: 'no_text_layer', pageCount: 7 });
    });

    it('ignores no_text_layer when OCR checking is disabled', () => {
        const result = preflightCachedPdfMeta(
            makeMeta({ errorCode: 'no_text_layer', pageCount: 7 }),
            { checkOcr: false, applyPageCountCap: false, maxPageCount: 1000 },
        );
        expect(result).toBeNull();
    });

    it('returns too_many_pages when over the cap', () => {
        const result = preflightCachedPdfMeta(
            makeMeta({ pageCount: 1500 }),
            { checkOcr: true, applyPageCountCap: true, maxPageCount: 1000 },
        );
        expect(result).toEqual({
            code: 'too_many_pages',
            pageCount: 1500,
            maxPageCount: 1000,
        });
    });

    it('does not apply the page-count cap when disabled', () => {
        const result = preflightCachedPdfMeta(
            makeMeta({ pageCount: 1500 }),
            { checkOcr: true, applyPageCountCap: false, maxPageCount: 1000 },
        );
        expect(result).toBeNull();
    });

    it('does not apply the page-count cap when pageCount is unknown', () => {
        const result = preflightCachedPdfMeta(
            makeMeta({ pageCount: null }),
            { checkOcr: true, applyPageCountCap: true, maxPageCount: 1000 },
        );
        expect(result).toBeNull();
    });
});
