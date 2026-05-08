/**
 * Tests for `preflightCachedPdfMeta` — the pure cache preflight helper that
 * three PDF agent handlers share. Covers all four error codes plus the
 * `checkOcr` and `applyPageCountCap` predicates.
 */

import { describe, it, expect, vi } from 'vitest';

// utils.ts pulls in heavy dependencies (PDFExtractor, supabase, react/store,
// etc.) via transitive imports. Mock the ones that would otherwise fail to
// load in node — only `preflightCachedPdfMeta` itself is exercised, so all
// these deps are unused at runtime.
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
import type { AttachmentFileCacheRecord } from '../../../src/services/database';

function makeRecord(
    overrides: Partial<AttachmentFileCacheRecord> = {},
): AttachmentFileCacheRecord {
    return {
        item_id: 1,
        library_id: 1,
        zotero_key: 'ABCD1234',
        file_path: '/data/test.pdf',
        file_mtime_ms: 1700000000000,
        file_size_bytes: 100000,
        content_type: 'application/pdf',
        page_count: 10,
        page_labels: null,
        has_text_layer: true,
        needs_ocr: false,
        is_encrypted: false,
        is_invalid: false,
        extraction_version: '2',
        cached_at: '2025-01-01T00:00:00Z',
        ...overrides,
    };
}

describe('preflightCachedPdfMeta', () => {
    it('returns null when cachedMeta is null', () => {
        const result = preflightCachedPdfMeta(null, {
            checkOcr: true,
            applyPageCountCap: true,
            maxPageCount: 1000,
        });
        expect(result).toBeNull();
    });

    it('returns null when cachedMeta is healthy', () => {
        const result = preflightCachedPdfMeta(makeRecord(), {
            checkOcr: true,
            applyPageCountCap: true,
            maxPageCount: 1000,
        });
        expect(result).toBeNull();
    });

    it('returns "encrypted" for is_encrypted: true', () => {
        const result = preflightCachedPdfMeta(
            makeRecord({ is_encrypted: true, page_count: 5 }),
            { checkOcr: true, applyPageCountCap: true, maxPageCount: 1000 },
        );
        expect(result).toEqual({ code: 'encrypted', pageCount: 5 });
    });

    it('returns "invalid_pdf" for is_invalid: true', () => {
        const result = preflightCachedPdfMeta(
            makeRecord({ is_invalid: true, page_count: null }),
            { checkOcr: true, applyPageCountCap: true, maxPageCount: 1000 },
        );
        expect(result).toEqual({ code: 'invalid_pdf', pageCount: null });
    });

    it('returns "no_text_layer" when needs_ocr=true and checkOcr=true', () => {
        const result = preflightCachedPdfMeta(
            makeRecord({ needs_ocr: true, page_count: 7 }),
            { checkOcr: true, applyPageCountCap: true, maxPageCount: 1000 },
        );
        expect(result).toEqual({ code: 'no_text_layer', pageCount: 7 });
    });

    it('returns null for needs_ocr=true when checkOcr=false (image-render path)', () => {
        const result = preflightCachedPdfMeta(
            makeRecord({ needs_ocr: true, page_count: 7 }),
            { checkOcr: false, applyPageCountCap: false, maxPageCount: 1000 },
        );
        expect(result).toBeNull();
    });

    it('returns "too_many_pages" with pageCount + maxPageCount when over the cap', () => {
        const result = preflightCachedPdfMeta(
            makeRecord({ page_count: 1500 }),
            { checkOcr: true, applyPageCountCap: true, maxPageCount: 1000 },
        );
        expect(result).toEqual({
            code: 'too_many_pages',
            pageCount: 1500,
            maxPageCount: 1000,
        });
    });

    it('returns null when over cap but applyPageCountCap=false', () => {
        const result = preflightCachedPdfMeta(
            makeRecord({ page_count: 1500 }),
            { checkOcr: true, applyPageCountCap: false, maxPageCount: 1000 },
        );
        expect(result).toBeNull();
    });

    it('returns null when at the cap (strict greater-than)', () => {
        const result = preflightCachedPdfMeta(
            makeRecord({ page_count: 1000 }),
            { checkOcr: true, applyPageCountCap: true, maxPageCount: 1000 },
        );
        expect(result).toBeNull();
    });

    it('returns null when page_count is null even with applyPageCountCap=true', () => {
        const result = preflightCachedPdfMeta(
            makeRecord({ page_count: null }),
            { checkOcr: true, applyPageCountCap: true, maxPageCount: 1000 },
        );
        expect(result).toBeNull();
    });

    it('encrypted takes precedence over too_many_pages', () => {
        const result = preflightCachedPdfMeta(
            makeRecord({ is_encrypted: true, page_count: 1500 }),
            { checkOcr: true, applyPageCountCap: true, maxPageCount: 1000 },
        );
        expect(result?.code).toBe('encrypted');
    });

    it('invalid_pdf takes precedence over needs_ocr', () => {
        const result = preflightCachedPdfMeta(
            makeRecord({ is_invalid: true, needs_ocr: true }),
            { checkOcr: true, applyPageCountCap: true, maxPageCount: 1000 },
        );
        expect(result?.code).toBe('invalid_pdf');
    });

    it('needs_ocr takes precedence over too_many_pages', () => {
        const result = preflightCachedPdfMeta(
            makeRecord({ needs_ocr: true, page_count: 1500 }),
            { checkOcr: true, applyPageCountCap: true, maxPageCount: 1000 },
        );
        expect(result?.code).toBe('no_text_layer');
    });
});
