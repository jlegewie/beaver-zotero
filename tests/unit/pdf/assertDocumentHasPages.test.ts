/**
 * Unit tests for `assertDocumentHasPages` — the worker-side guard that
 * classifies a document which opened successfully but resolves to zero
 * pages (an empty or structurally corrupt PDF). Without it the extraction
 * ops fail with a raw, unclassified internal error.
 */
import { describe, it, expect } from 'vitest';
import { assertDocumentHasPages } from '../../../src/beaver-extract/worker/docHelpers';
import { ExtractionErrorCode } from '../../../src/beaver-extract/types';

describe('assertDocumentHasPages', () => {
    it('does not throw for a positive integer page count', () => {
        expect(() => assertDocumentHasPages(1)).not.toThrow();
        expect(() => assertDocumentHasPages(42)).not.toThrow();
    });

    it.each([0, -1, 1.5, NaN, Infinity])(
        'throws a classified EMPTY_DOCUMENT error for %p',
        (pageCount) => {
            let thrown: any;
            try {
                assertDocumentHasPages(pageCount);
            } catch (e) {
                thrown = e;
            }
            expect(thrown).toBeDefined();
            expect(thrown.name).toBe('ExtractionError');
            expect(thrown.code).toBe(ExtractionErrorCode.EMPTY_DOCUMENT);
            // `{ pageCount: 0 }` payload lets MuPDFWorkerClient rehydrate
            // `ExtractionError.pageCount`, surfaced as response `total_pages`.
            expect(thrown.payload).toEqual({ pageCount: 0 });
        },
    );
});
