import { describe, expect, it } from 'vitest';
import { toBackendDocumentPayload } from '../../../src/services/documentExtraction/backendDocumentPayload';

function structuredPdf() {
    return {
        content_kind: 'pdf' as const,
        schemaVersion: '4',
        mode: 'structured' as const,
        document: {
            pageCount: 2,
            pageLabels: { '0': 'i', '1': 'ii' },
            bboxOrigin: 'top-left' as const,
            bboxPrecision: 1,
            pages: [
                {
                    index: 0, label: 'i', width: 612, height: 792, viewBox: [0, 0, 612, 792], rotation: 0,
                    items: [
                        { id: 'margin1', kind: 'margin', pageIndex: 0, order: 0, bbox: [0, 0, 5, 5], text: 'C' },
                        {
                            id: 'p1', kind: 'text', pageIndex: 0, order: 1, bbox: [10, 10, 100, 20], text: 'Body.',
                            sentences: [{ id: 's1', order: 0, text: 'Body.', bboxes: [[10, 10, 100, 20]] }],
                        },
                        { id: 'margin2', kind: 'margin', pageIndex: 0, order: 2, bbox: [0, 780, 5, 790], text: '1' },
                    ],
                },
                {
                    index: 1, label: 'ii', width: 612, height: 792, viewBox: [0, 0, 612, 792], rotation: 0,
                    items: [
                        { id: 'heading1', kind: 'section_header', pageIndex: 1, order: 0, bbox: [10, 10, 100, 20], text: 'Methods', level: 1 },
                    ],
                },
            ],
            citationIndex: {
                margin1: { id: 'margin1', kind: 'item', pageIndex: 0, pageLabel: 'i', itemId: 'margin1' },
                p1: { id: 'p1', kind: 'item', pageIndex: 0, pageLabel: 'i', itemId: 'p1' },
                s1: { id: 's1', kind: 'sentence', pageIndex: 0, pageLabel: 'i', itemId: 'p1', sentenceId: 's1' },
            },
        },
    } as any;
}

describe('toBackendDocumentPayload', () => {
    it('drops the citation index and margin items from structured PDFs', () => {
        const payload = toBackendDocumentPayload(structuredPdf()) as any;

        expect(payload.document).not.toHaveProperty('citationIndex');
        expect(payload.document.pages[0].items.map((item: any) => item.id)).toEqual(['p1']);
        expect(payload.document.pages[1].items.map((item: any) => item.id)).toEqual(['heading1']);
        expect(payload.content_kind).toBe('pdf');
        expect(payload.document.pageLabels).toEqual({ '0': 'i', '1': 'ii' });
        expect(payload.document.bboxPrecision).toBe(1);
    });

    it('keeps margin items when asked', () => {
        const payload = toBackendDocumentPayload(structuredPdf(), { includeMargins: true }) as any;

        expect(payload.document).not.toHaveProperty('citationIndex');
        expect(payload.document.pages[0].items.map((item: any) => item.id))
            .toEqual(['margin1', 'p1', 'margin2']);
    });

    it('leaves the source document intact for local consumers and hashing', () => {
        const source = structuredPdf();
        const before = JSON.stringify(source);

        toBackendDocumentPayload(source);

        expect(JSON.stringify(source)).toBe(before);
    });

    it('drops the citation index from EPUB and snapshot documents', () => {
        for (const contentKind of ['epub', 'snapshot'] as const) {
            const document = {
                content_kind: contentKind,
                schemaVersion: '2',
                sectionCount: 1,
                sections: [{ index: 0, rawHref: 'a.xhtml', items: [{ id: 'p1', text: 'Body.' }] }],
                citationIndex: { p1: { id: 'p1', kind: 'item', sectionIndex: 0, itemId: 'p1' } },
                diagnostics: { extractedTextChars: 5, sourceTextChars: 5, textCoverage: 1 },
            } as any;

            const payload = toBackendDocumentPayload(document) as any;

            expect(payload).not.toHaveProperty('citationIndex');
            expect(payload.sections).toBe(document.sections);
            expect(payload.content_kind).toBe(contentKind);
            expect(document).toHaveProperty('citationIndex');
        }
    });

    it('passes markdown and text documents through unchanged', () => {
        const markdown = { content_kind: 'pdf', mode: 'markdown', schemaVersion: '4', document: { pageCount: 1, pages: [] } } as any;
        const text = { content_kind: 'text', mode: 'text', schemaVersion: '1', document: { lineCount: 0, lines: [] } } as any;

        expect(toBackendDocumentPayload(markdown)).toBe(markdown);
        expect(toBackendDocumentPayload(text)).toBe(text);
    });
});
