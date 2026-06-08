import { describe, expect, it } from 'vitest';
import { readableToExtractKind } from '../../../src/services/documentExtraction/shared/contentKinds';
import type {
    DocumentExtractResult,
    PdfDocumentExtractResult,
    TextDocumentExtractResult,
} from '../../../src/services/documentExtraction/shared/documentExtractResult';

describe('document extract result envelope', () => {
    it('supports the PDF arm with content_kind pdf', () => {
        const pdf: PdfDocumentExtractResult = {
            content_kind: 'pdf',
            schemaVersion: '4',
            mode: 'markdown',
            document: {
                pageCount: 1,
                pages: [{
                    index: 0,
                    width: 100,
                    height: 200,
                    viewBox: [0, 0, 100, 200],
                    rotation: 0,
                    markdown: 'Hello',
                }],
            },
        };
        const union: DocumentExtractResult = pdf;
        expect(union.content_kind).toBe('pdf');
    });

    it('keeps the round-trip union scoped to pdf and text', () => {
        const text: TextDocumentExtractResult = {
            content_kind: 'text',
            schemaVersion: '1',
            mode: 'text',
            document: {
                lineCount: 1,
                sourceContentType: 'text/plain',
                lines: [{ id: 'l1', line: 1, text: 'Hello' }],
            },
        };
        const union: DocumentExtractResult = text;
        expect(union.content_kind).toBe('text');
    });

    it('does not convert images into extract content kinds', () => {
        expect(readableToExtractKind('image')).toBeUndefined();
        expect(readableToExtractKind(null)).toBeUndefined();
        expect(readableToExtractKind('pdf')).toBe('pdf');
    });
});
