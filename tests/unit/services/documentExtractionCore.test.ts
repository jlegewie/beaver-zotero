import { describe, expect, it } from 'vitest';
import { buildExtractedDocumentCacheMetadata } from '../../../src/services/documentExtractionCore';
import type { BeaverExtractResult } from '../../../src/beaver-extract/schema/schema';

describe('buildExtractedDocumentCacheMetadata', () => {
    it('builds dense page geometry from sparse extracted pages', () => {
        const result: BeaverExtractResult = {
            mode: 'structured',
            schemaVersion: '4',
            document: {
                pageCount: 5,
                pageLabels: { '0': 'i', '4': '5' },
                bboxOrigin: 'top-left',
                bboxPrecision: 1,
                pages: [
                    { index: 0, width: 100, height: 200, viewBox: [0, 0, 100, 200], rotation: 0, items: [] },
                    { index: 2, width: 200, height: 100, viewBox: [10, 20, 210, 120], rotation: 90, items: [] },
                    { index: 4, label: '5', width: 300, height: 400, viewBox: [0, 0, 300, 400], rotation: 180, items: [] },
                ],
                citationIndex: {},
            },
        };

        expect(buildExtractedDocumentCacheMetadata(result)).toEqual({
            pageCount: 5,
            pageLabels: { '0': 'i', '4': '5' },
            pages: [
                { viewBox: [0, 0, 100, 200], width: 100, height: 200, rotation: 0 },
                null,
                { viewBox: [10, 20, 210, 120], width: 200, height: 100, rotation: 90 },
                null,
                { viewBox: [0, 0, 300, 400], width: 300, height: 400, rotation: 180 },
            ],
        });
    });
});
