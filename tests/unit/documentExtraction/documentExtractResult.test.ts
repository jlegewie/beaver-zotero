import { describe, expect, it } from 'vitest';

import { ID_PREFIXES } from '../../../src/beaver-extract/schema/schema';
import type { PdfDocumentExtractResult } from '../../../src/services/documentExtraction/shared/documentExtractResult';

describe('DocumentExtractResult envelope', () => {
    it('registers the line locator prefix', () => {
        expect(ID_PREFIXES.line).toBe('l');
    });

    it('narrows PDF extract results by content_kind', () => {
        const result = {
            content_kind: 'pdf',
            schemaVersion: '4',
            mode: 'markdown',
            document: {
                pageCount: 0,
                pages: [],
            },
        } satisfies PdfDocumentExtractResult;

        if (result.content_kind === 'pdf') {
            expect(result.mode).toBe('markdown');
        }
    });
});
