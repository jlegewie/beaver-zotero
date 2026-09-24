import { describe, expect, it } from 'vitest';
import { toBackendDocumentPayload } from '../../../src/services/documentExtraction/backendDocumentPayload';

function domDocument(contentKind: 'epub' | 'snapshot') {
    return {
        content_kind: contentKind,
        schemaVersion: '2',
        sectionCount: 1,
        sections: [{ index: 0, rawHref: 'a.xhtml', items: [{ id: 'p1', text: 'Body.' }] }],
        citationIndex: { p1: { id: 'p1', kind: 'item', sectionIndex: 0, itemId: 'p1' } },
        diagnostics: { extractedTextChars: 5, sourceTextChars: 5, textCoverage: 1 },
    } as any;
}

describe('toBackendDocumentPayload', () => {
    it.each(['epub', 'snapshot'] as const)('drops the citation index from %s documents', (contentKind) => {
        const document = domDocument(contentKind);

        const payload = toBackendDocumentPayload(document) as any;

        expect(payload).not.toHaveProperty('citationIndex');
        expect(payload.sections).toBe(document.sections);
        expect(payload.content_kind).toBe(contentKind);
        // The cached source document is not modified.
        expect(document).toHaveProperty('citationIndex');
    });

    it('passes PDF, markdown and text documents through unchanged', () => {
        const structured = {
            content_kind: 'pdf', mode: 'structured', schemaVersion: '4',
            document: { pageCount: 1, bboxOrigin: 'top-left', bboxPrecision: 1, pages: [] },
        } as any;
        const markdown = { content_kind: 'pdf', mode: 'markdown', schemaVersion: '4', document: { pageCount: 1, pages: [] } } as any;
        const text = { content_kind: 'text', mode: 'text', schemaVersion: '1', document: { lineCount: 0, lines: [] } } as any;

        expect(toBackendDocumentPayload(structured)).toBe(structured);
        expect(toBackendDocumentPayload(markdown)).toBe(markdown);
        expect(toBackendDocumentPayload(text)).toBe(text);
    });
});
