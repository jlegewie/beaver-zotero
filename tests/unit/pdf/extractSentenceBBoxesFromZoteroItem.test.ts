/**
 * Unit tests for `extractSentenceBBoxesFromZoteroItem` — the thin
 * Zotero-aware wrapper around `PDFExtractor.extractSentenceBBoxes`.
 *
 * The wrapper has a single responsibility: when the caller didn't pass
 * a `language` or `languageFallback`, look up the item's `language`
 * field and forward it as `languageFallback` (NOT as `language`, since
 * the new design lets PDF-text language detection run first).
 *
 * These tests verify *forwarding behavior* only — not the actual
 * detection. Detection is exercised via the trace endpoint.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Module Mocks (must be before imports)
// =============================================================================

// `getItemLanguage` is the only Zotero-dependency the wrapper has. Mock it
// before importing the wrapper module so the lazy `await import(...)` inside
// the wrapper picks up our mock.
const getItemLanguageMock = vi.fn();
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getItemLanguage: getItemLanguageMock,
}));

// MuPDF worker client must not actually connect — it doesn't matter what
// it returns since we replace `PDFExtractor.extractSentenceBBoxes` below.
vi.mock('../../../src/services/pdf/MuPDFWorkerClient', () => ({
    getMuPDFWorkerClient: () => ({
        getPageCount: vi.fn(),
        extractRawPages: vi.fn(),
        extractRawPageDetailed: vi.fn(),
    }),
    MuPDFWorkerClient: class {},
    disposeMuPDFWorker: vi.fn(),
}));

import {
    extractSentenceBBoxesFromZoteroItem,
    PDFExtractor,
} from '../../../src/services/pdf';

// =============================================================================
// Helpers
// =============================================================================

function makeItem(libraryID = 1, key = 'AAAAAA'): Zotero.Item {
    return {
        libraryID,
        key,
        getFilePathAsync: vi.fn().mockResolvedValue('/fake/path.pdf'),
    } as unknown as Zotero.Item;
}

// Empty result that satisfies `PageSentenceBBoxResult`.
const EMPTY_RESULT = {
    paragraphs: [],
    sentences: [],
    degradedParagraphs: 0,
    unmappedParagraphs: 0,
    degradationNotes: [],
};

// =============================================================================
// Tests
// =============================================================================

describe('extractSentenceBBoxesFromZoteroItem: option forwarding', () => {
    let extractSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).IOUtils.read = vi
            .fn()
            .mockResolvedValue(new Uint8Array());
        // Replace the implementation, not just observe — the real one
        // would try to talk to the MuPDF worker.
        extractSpy = vi
            .spyOn(PDFExtractor.prototype, 'extractSentenceBBoxes')
            .mockResolvedValue(EMPTY_RESULT as never);
    });

    afterEach(() => {
        extractSpy.mockRestore();
    });

    it('returns null when the item has no file path', async () => {
        const item = makeItem();
        (item.getFilePathAsync as ReturnType<typeof vi.fn>).mockResolvedValue(
            null,
        );

        const result = await extractSentenceBBoxesFromZoteroItem(item, 0);

        expect(result).toBeNull();
        expect(extractSpy).not.toHaveBeenCalled();
    });

    it('Case A: no caller language; Zotero language → languageFallback (NOT language)', async () => {
        getItemLanguageMock.mockResolvedValue('de');
        const item = makeItem(7, 'KEY-A');

        await extractSentenceBBoxesFromZoteroItem(item, 0);

        expect(getItemLanguageMock).toHaveBeenCalledWith(7, 'KEY-A');
        expect(extractSpy).toHaveBeenCalledTimes(1);
        const opts = extractSpy.mock.calls[0][2] as Record<string, unknown>;
        expect(opts).toMatchObject({ languageFallback: 'de' });
        expect(opts.language).toBeUndefined();
    });

    it('Case B: caller-provided language; getItemLanguage is NOT called', async () => {
        const item = makeItem();

        await extractSentenceBBoxesFromZoteroItem(item, 0, { language: 'fr' });

        expect(getItemLanguageMock).not.toHaveBeenCalled();
        const opts = extractSpy.mock.calls[0][2] as Record<string, unknown>;
        expect(opts.language).toBe('fr');
        expect(opts.languageFallback).toBeUndefined();
    });

    it('Case C: caller-supplied languageFallback wins over Zotero metadata', async () => {
        getItemLanguageMock.mockResolvedValue('de'); // Should not be consulted
        const item = makeItem();

        await extractSentenceBBoxesFromZoteroItem(item, 0, {
            languageFallback: 'es',
        });

        expect(getItemLanguageMock).not.toHaveBeenCalled();
        const opts = extractSpy.mock.calls[0][2] as Record<string, unknown>;
        expect(opts.languageFallback).toBe('es');
        expect(opts.language).toBeUndefined();
    });

    it('Case D: detectLanguage:false is forwarded unchanged', async () => {
        const item = makeItem();

        await extractSentenceBBoxesFromZoteroItem(item, 0, {
            detectLanguage: false,
            languageFallback: 'en',
        });

        const opts = extractSpy.mock.calls[0][2] as Record<string, unknown>;
        expect(opts.detectLanguage).toBe(false);
        expect(opts.languageFallback).toBe('en');
    });

    it('does not throw when getItemLanguage rejects (best-effort lookup)', async () => {
        getItemLanguageMock.mockRejectedValue(new Error('not loaded'));
        const item = makeItem();

        await expect(
            extractSentenceBBoxesFromZoteroItem(item, 0),
        ).resolves.toBeDefined();

        const opts = extractSpy.mock.calls[0][2] as Record<string, unknown>;
        expect(opts.language).toBeUndefined();
        expect(opts.languageFallback).toBeUndefined();
    });

    it('skips passing languageFallback when getItemLanguage returns null', async () => {
        getItemLanguageMock.mockResolvedValue(null);
        const item = makeItem();

        await extractSentenceBBoxesFromZoteroItem(item, 0);

        expect(getItemLanguageMock).toHaveBeenCalled();
        const opts = extractSpy.mock.calls[0][2] as Record<string, unknown>;
        expect(opts.languageFallback).toBeUndefined();
    });
});
