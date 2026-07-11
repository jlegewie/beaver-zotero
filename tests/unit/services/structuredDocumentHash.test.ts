import { describe, expect, it } from 'vitest';
import {
    canonicalSerializeStructuredDocument,
    computeStructuredDocumentHash,
} from '../../../src/services/documentExtraction/structuredDocumentHash';

function pdf(text = 'Stable text', left = 1.04) {
    return {
        schemaVersion: '4',
        createdAt: new Date().toISOString(),
        mode: 'structured',
        diagnostics: { timings: { total: Math.random() }, engine: 'structured' },
        debug: { pages: { random: Math.random() } },
        document: {
            pageCount: 1,
            bboxOrigin: 'top-left',
            bboxPrecision: 1,
            pages: [{
                index: 0,
                width: 100.04,
                height: 200.04,
                viewBox: [0, 0, 100.04, 200.04],
                rotation: 0,
                items: [{
                    id: 'p1', kind: 'text', pageIndex: 0, order: 0,
                    bbox: [left, 2, 3, 4], text,
                    sentences: [{ id: 's1', order: 0, text, bboxes: [[left, 2, 3, 4]] }],
                }],
            }],
            citationIndex: { s1: { id: 's1', kind: 'sentence', pageIndex: 0, itemId: 'p1', sentenceId: 's1' } },
        },
    } as any;
}

describe('structured document hashing', () => {
    it('ignores run metadata and sub-quantization PDF geometry jitter', async () => {
        const first = pdf('Stable text', 1.04);
        const second = pdf('Stable text', 1.049);
        expect(canonicalSerializeStructuredDocument('pdf', first))
            .toBe(canonicalSerializeStructuredDocument('pdf', second));
        await expect(computeStructuredDocumentHash('pdf', first))
            .resolves.toBe(await computeStructuredDocumentHash('pdf', second));
    });

    it('changes for real text, id, or item-kind changes', async () => {
        const base = await computeStructuredDocumentHash('pdf', pdf());
        expect(await computeStructuredDocumentHash('pdf', pdf('Changed text'))).not.toBe(base);
        const changedId = pdf();
        changedId.document.pages[0].items[0].id = 'p2';
        expect(await computeStructuredDocumentHash('pdf', changedId)).not.toBe(base);
        const changedKind = pdf();
        changedKind.document.pages[0].items[0].kind = 'section_header';
        expect(await computeStructuredDocumentHash('pdf', changedKind)).not.toBe(base);
    });

    it.each(['epub', 'snapshot'] as const)('is deterministic for %s payloads', async (kind) => {
        const payload = {
            content_kind: kind,
            schemaVersion: kind === 'epub' ? '2' : '1',
            sectionCount: 1,
            sections: [{ index: 0, rawHref: 'index.html', items: [{ id: 's1', text: 'Hello' }] }],
            citationIndex: { s1: { id: 's1', sectionIndex: 0 } },
            diagnostics: { extractedTextChars: 5, timings: { total: 1 } },
        } as any;
        const first = await computeStructuredDocumentHash(kind, payload);
        payload.diagnostics.timings.total = 999;
        expect(await computeStructuredDocumentHash(kind, payload)).toBe(first);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
    });
});

