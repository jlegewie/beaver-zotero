/**
 * Tests for page label resolution helpers.
 *
 * Covers the pure `resolvePageValue` exhaustively (numeric + string inputs,
 * label-aware + strict modes, error paths), plus light coverage of
 * `ensurePageLabelsForResolution` (the cache + eager-load path with mocked
 * PDFExtractor + IOUtils).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    resolvePageValue,
    InvalidPageValueError,
    ensurePageLabelsForResolution,
} from '../../../src/services/agentDataProvider/pageLabelResolution';
import type { AttachmentFileCacheRecord } from '../../../src/services/database';

// Mock the logger to keep test output clean
vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

// Cast IOUtils for type-safe mock access (stub from tests/setup.ts)
const mockIOUtils = (globalThis as any).IOUtils as {
    read: ReturnType<typeof vi.fn>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCachedMeta(
    overrides: Partial<AttachmentFileCacheRecord> = {}
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
        extraction_version: '1',
        cached_at: '2025-01-01T00:00:00Z',
        ...overrides,
    };
}

/** Minimal mock PDFExtractor — only `getPageCountAndLabels` is exercised here. */
function makeMockExtractor(result: { count: number; labels: Record<number, string> } | Error) {
    return {
        getPageCountAndLabels: vi.fn().mockImplementation(async () => {
            if (result instanceof Error) throw result;
            return result;
        }),
    } as any;
}

// ---------------------------------------------------------------------------
// resolvePageValue — numeric input
// ---------------------------------------------------------------------------

describe('resolvePageValue (numeric input)', () => {
    describe('preferPageLabels=false (strict numeric mode)', () => {
        it('returns the input unchanged when labels are null', () => {
            expect(resolvePageValue(5, null, false)).toBe(5);
            expect(resolvePageValue(1, null, false)).toBe(1);
            expect(resolvePageValue(999, null, false)).toBe(999);
        });

        it('ignores labels even when they match (strict mode)', () => {
            // prefer_page_labels=false means the number is always a physical index
            const labels = { 0: 'i', 1: 'ii', 2: 'iii', 3: 'iv', 4: '1', 5: '2' };
            expect(resolvePageValue(1, labels, false)).toBe(1); // NOT 5
            expect(resolvePageValue(2, labels, false)).toBe(2); // NOT 6
        });
    });

    describe('preferPageLabels=true (label-aware mode)', () => {
        it('falls through to input when labels are null', () => {
            expect(resolvePageValue(5, null, true)).toBe(5);
        });

        it('is a no-op when labels are sequential and match 1-based indices', () => {
            const labels = { 0: '1', 1: '2', 2: '3', 3: '4', 4: '5' };
            expect(resolvePageValue(1, labels, true)).toBe(1);
            expect(resolvePageValue(3, labels, true)).toBe(3);
            expect(resolvePageValue(5, labels, true)).toBe(5);
        });

        it('resolves label "1" to the correct 1-based index with front-matter offset', () => {
            const labels = {
                0: 'i', 1: 'ii', 2: 'iii', 3: 'iv',
                4: '1', 5: '2', 6: '3',
            };
            expect(resolvePageValue(1, labels, true)).toBe(5); // label "1" → index 5
            expect(resolvePageValue(2, labels, true)).toBe(6);
            expect(resolvePageValue(3, labels, true)).toBe(7);
        });

        it('falls through to numeric index when the value does not match any label', () => {
            // Roman labels — numeric "4" doesn't match "iv", falls through
            const labels = { 0: 'i', 1: 'ii', 2: 'iii', 3: 'iv' };
            expect(resolvePageValue(4, labels, true)).toBe(4);
        });

        it('resolves the first matching label when duplicates exist', () => {
            const labels = { 0: '1', 1: '1', 2: '2' };
            expect(resolvePageValue(1, labels, true)).toBe(1);
        });

        it('handles non-contiguous label keys correctly', () => {
            const labels = { 0: 'cover', 5: '1', 6: '2' };
            expect(resolvePageValue(1, labels, true)).toBe(6); // index 5 → 1-based 6
            expect(resolvePageValue(2, labels, true)).toBe(7);
        });
    });
});

// ---------------------------------------------------------------------------
// resolvePageValue — string input
// ---------------------------------------------------------------------------

describe('resolvePageValue (string input)', () => {
    describe('preferPageLabels=true (label-aware mode)', () => {
        it('resolves a label string to its physical index', () => {
            const labels = { 0: 'i', 1: 'ii', 2: 'iii', 3: 'iv', 4: '1' };
            expect(resolvePageValue('iv', labels, true)).toBe(4);
            expect(resolvePageValue('i', labels, true)).toBe(1);
            expect(resolvePageValue('1', labels, true)).toBe(5);
        });

        it('resolves non-numeric labels like "A-3" or "S12"', () => {
            const labels = { 0: '1', 1: '2', 2: 'A-1', 3: 'A-2', 4: 'S12' };
            expect(resolvePageValue('A-1', labels, true)).toBe(3);
            expect(resolvePageValue('A-2', labels, true)).toBe(4);
            expect(resolvePageValue('S12', labels, true)).toBe(5);
        });

        it('falls back to numeric parse when label not found but string parses as int', () => {
            // "38" misses label lookup (labels are roman), falls through to numeric 38
            const labels = { 0: 'i', 1: 'ii', 2: 'iii' };
            expect(resolvePageValue('38', labels, true)).toBe(38);
        });

        it('throws InvalidPageValueError when label missing and not numeric', () => {
            const labels = { 0: 'i', 1: 'ii', 2: 'iii' };
            expect(() => resolvePageValue('nonexistent', labels, true))
                .toThrow(InvalidPageValueError);
        });

        it('error payload includes a sample of known labels', () => {
            const labels = { 0: 'i', 1: 'ii', 2: 'iii', 3: 'iv' };
            try {
                resolvePageValue('fig-2', labels, true);
                expect.fail('expected throw');
            } catch (error) {
                expect(error).toBeInstanceOf(InvalidPageValueError);
                const err = error as InvalidPageValueError;
                expect(err.knownLabels).toEqual(['i', 'ii', 'iii', 'iv']);
                expect(err.message).toContain('fig-2');
                expect(err.message).toContain('i, ii, iii, iv');
            }
        });

        it('error payload caps sample at 10 labels', () => {
            const labels: Record<number, string> = {};
            for (let i = 0; i < 20; i++) labels[i] = `label-${i}`;
            try {
                resolvePageValue('bogus', labels, true);
                expect.fail('expected throw');
            } catch (error) {
                const err = error as InvalidPageValueError;
                expect(err.knownLabels?.length).toBe(10);
                expect(err.message).toContain('…'); // truncation marker
            }
        });

        it('error payload has no knownLabels when labels is null', () => {
            try {
                resolvePageValue('iv', null, true);
                expect.fail('expected throw');
            } catch (error) {
                const err = error as InvalidPageValueError;
                expect(err.knownLabels).toBeUndefined();
                expect(err.message).toContain('no page labels are available');
            }
        });

        it('handles whitespace in numeric fallback', () => {
            expect(resolvePageValue('  38  ', null, true)).toBe(38);
        });
    });

    describe('preferPageLabels=false (strict numeric mode)', () => {
        it('parses a numeric string as a physical index', () => {
            expect(resolvePageValue('38', null, false)).toBe(38);
            expect(resolvePageValue('1', null, false)).toBe(1);
        });

        it('parses a numeric string even when labels exist (ignores labels)', () => {
            const labels = { 0: 'i', 1: 'ii', 2: 'iii', 3: 'iv', 4: '1' };
            // "1" would match labels[4] in label-aware mode, but strict mode
            // treats it purely as numeric → physical index 1.
            expect(resolvePageValue('1', labels, false)).toBe(1);
        });

        it('throws InvalidPageValueError on non-parseable string', () => {
            expect(() => resolvePageValue('iv', null, false))
                .toThrow(InvalidPageValueError);
            expect(() => resolvePageValue('A-3', null, false))
                .toThrow(InvalidPageValueError);
        });

        it('error message mentions prefer_page_labels gating', () => {
            try {
                resolvePageValue('iv', null, false);
                expect.fail('expected throw');
            } catch (error) {
                expect((error as Error).message).toMatch(/read_note/);
            }
        });

        it('rejects zero and negative as invalid positive integers', () => {
            expect(() => resolvePageValue('0', null, false))
                .toThrow(InvalidPageValueError);
            expect(() => resolvePageValue('-5', null, false))
                .toThrow(InvalidPageValueError);
        });

        it('rejects decimals', () => {
            expect(() => resolvePageValue('3.14', null, false))
                .toThrow(InvalidPageValueError);
        });

        it('handles leading/trailing whitespace', () => {
            expect(resolvePageValue('  38  ', null, false)).toBe(38);
        });
    });
});

// ---------------------------------------------------------------------------
// ensurePageLabelsForResolution
// ---------------------------------------------------------------------------

describe('ensurePageLabelsForResolution', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns labels from cache when cachedMeta has populated page_labels', async () => {
        const cachedMeta = makeCachedMeta({
            page_labels: { 0: 'i', 1: 'ii', 2: '1' },
            page_count: 3,
        });
        const extractor = makeMockExtractor({ count: 999, labels: { 0: 'wrong' } });

        const result = await ensurePageLabelsForResolution('/data/test.pdf', cachedMeta, extractor);

        expect(result.labels).toEqual({ 0: 'i', 1: 'ii', 2: '1' });
        expect(result.pageCount).toBe(3);
        expect(result.pdfData).toBeNull();
        // Should NOT call the extractor when cache has labels
        expect(extractor.getPageCountAndLabels).not.toHaveBeenCalled();
        expect(mockIOUtils.read).not.toHaveBeenCalled();
    });

    it('normalises empty labels object from cache to null', async () => {
        // page_labels: {} means "already checked, no custom labels" —
        // resolver should see null so it falls through to numeric.
        const cachedMeta = makeCachedMeta({
            page_labels: {},
            page_count: 5,
        });
        const extractor = makeMockExtractor({ count: 999, labels: { 0: 'wrong' } });

        const result = await ensurePageLabelsForResolution('/data/test.pdf', cachedMeta, extractor);

        expect(result.labels).toBeNull();
        expect(result.pageCount).toBe(5);
        expect(result.pdfData).toBeNull();
        expect(extractor.getPageCountAndLabels).not.toHaveBeenCalled();
    });

    it('does an eager load when cachedMeta is null', async () => {
        const pdfBytes = new Uint8Array([1, 2, 3]);
        mockIOUtils.read.mockResolvedValueOnce(pdfBytes);
        const extractor = makeMockExtractor({
            count: 42,
            labels: { 0: 'i', 1: 'ii', 2: '1' },
        });

        const result = await ensurePageLabelsForResolution('/data/test.pdf', null, extractor);

        expect(result.labels).toEqual({ 0: 'i', 1: 'ii', 2: '1' });
        expect(result.pageCount).toBe(42);
        expect(result.pdfData).toBe(pdfBytes);
        expect(mockIOUtils.read).toHaveBeenCalledWith('/data/test.pdf');
        expect(extractor.getPageCountAndLabels).toHaveBeenCalledWith(pdfBytes);
    });

    it('does an eager load when cachedMeta has null page_labels (never checked)', async () => {
        const cachedMeta = makeCachedMeta({ page_labels: null, page_count: null });
        const pdfBytes = new Uint8Array([1, 2, 3]);
        mockIOUtils.read.mockResolvedValueOnce(pdfBytes);
        const extractor = makeMockExtractor({
            count: 10,
            labels: { 0: '1' },
        });

        const result = await ensurePageLabelsForResolution('/data/test.pdf', cachedMeta, extractor);

        expect(result.labels).toEqual({ 0: '1' });
        expect(result.pageCount).toBe(10);
        expect(result.pdfData).toBe(pdfBytes);
        expect(extractor.getPageCountAndLabels).toHaveBeenCalledOnce();
    });

    it('normalises empty labels from eager load to null', async () => {
        mockIOUtils.read.mockResolvedValueOnce(new Uint8Array([1]));
        const extractor = makeMockExtractor({ count: 5, labels: {} });

        const result = await ensurePageLabelsForResolution('/data/test.pdf', null, extractor);

        expect(result.labels).toBeNull();
        expect(result.pageCount).toBe(5);
        expect(result.pdfData).toBeInstanceOf(Uint8Array);
    });

    it('returns null labels gracefully when eager load fails', async () => {
        mockIOUtils.read.mockRejectedValueOnce(new Error('disk error'));
        const extractor = makeMockExtractor(new Error('should not reach'));

        const result = await ensurePageLabelsForResolution('/data/test.pdf', null, extractor);

        expect(result.labels).toBeNull();
        expect(result.pageCount).toBeNull();
        expect(result.pdfData).toBeNull();
    });

    it('returns null labels gracefully when extractor fails', async () => {
        mockIOUtils.read.mockResolvedValueOnce(new Uint8Array([1]));
        const extractor = makeMockExtractor(new Error('malformed PDF'));

        const result = await ensurePageLabelsForResolution('/data/test.pdf', null, extractor);

        expect(result.labels).toBeNull();
        expect(result.pageCount).toBeNull();
        expect(result.pdfData).toBeNull();
    });
});
