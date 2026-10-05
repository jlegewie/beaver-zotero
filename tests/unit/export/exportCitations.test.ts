import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/libraryIdentity', () => ({ resolveLibraryRef: vi.fn(() => 1) }));
vi.mock('../../../src/utils/zoteroItemHelpers', () => ({ getBestPDFAttachmentAsync: vi.fn(async () => ({ id: 50 })) }));

import { formatExportCitations } from '../../../src/services/export/exportCitations';
import { parseExportSource } from '@beaver/agent-export/parse/parseExportDoc';
import type { CitationSnapshot } from '@beaver/agent-export/types';

function item(id: number, key: string, kind: 'regular' | 'note' = 'regular') {
    return {
        id, key, parentItemID: null,
        isAttachment: () => false, isAnnotation: () => false, isNote: () => kind === 'note',
        getNoteTitle: () => 'My note', loadAllData: vi.fn(async () => {}),
    };
}

const LIBRARY: Record<string, any> = { AAAAAAAA: item(1, 'AAAAAAAA'), NNNNNNNN: item(2, 'NNNNNNNN', 'note') };

function snapshot(partial: Partial<CitationSnapshot> = {}): CitationSnapshot {
    return { citationsByKey: {}, externalReferences: {}, externalItemMapping: {}, pageLabelsByAttachmentId: {}, ...partial };
}

describe('formatExportCitations', () => {
    const service = {
        resolveStyle: vi.fn(() => ({ style: { class: 'in-text' }, locale: 'en-US' })),
        formatCitationSequence: vi.fn((request: any) => ({
            styleId: 'http://www.zotero.org/styles/apa',
            locale: 'en-US',
            styleClass: 'in-text' as const,
            hasBibliography: true,
            clusters: request.clusters.map((cluster: any) => cluster.items.length
                ? { html: `(${cluster.items.map((i: any) => `${i.id}${i.locator ? `:${i.locator}` : ''}`).join('; ')} &#38; co)`, rtf: 'rtf' }
                : null),
            itemData: { 1: { id: 1, title: 'Lib' }, 'beaver-external-W1': { id: 'beaver-external-W1' } },
            bibliography: null,
        })),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        (Zotero as any).Items = {
            getByLibraryAndKeyAsync: vi.fn(async (_lib: number, key: string) => LIBRARY[key] ?? false),
            getAsync: vi.fn(),
        };
        (Zotero as any).URI = { getItemURI: vi.fn((i: any) => `http://zotero.org/users/1/items/${i.key}`) };
        (Zotero as any).Integration = {
            DocumentData: class { style: any; prefs: any; sessionID: any; serialize() { return JSON.stringify({ style: this.style, prefs: this.prefs }); } },
        };
        (Zotero.Utilities as any).randomString = vi.fn(() => 'SESSION');
        (Zotero as any).Styles = { initialized: vi.fn(() => false), init: vi.fn(async () => {}) };
    });

    it('resolves library items, external references and files, and keeps what cannot be formatted as text', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown:
            'A <citation id="u-AAAAAAAA" loc="page3"/> <citation external_id="W1"/> <citation id="ext-FILE0001" loc="page2"/>. '
            + 'B <citation id="u-MISSING1"/>. C <citation id="u-NNNNNNNN"/>.' }] });
        const result = await formatExportCitations(doc, snapshot({
            externalReferences: { W1: { source: 'openalex', title: 'Ext', library_items: [] } },
            pageLabelsByAttachmentId: { 50: { 2: 'xii' } },
        }), service as any, { liveCitations: true });

        const request = service.formatCitationSequence.mock.calls[0][0];
        expect(request.clusters[0].items).toEqual([{ id: 1, locator: 'xii', label: 'page' }, { id: 'beaver-external-W1' }]);
        expect(request.embeddedItems['beaver-external-W1']).toMatchObject({ title: 'Ext', type: 'article' });

        const [first, missing, note] = result.citations.clusters;
        expect(first.plain).toBe('(1:xii; beaver-external-W1 & co)');
        expect(first.items).toEqual([
            { id: 1, uris: ['http://zotero.org/users/1/items/AAAAAAAA'], itemData: { id: 1, title: 'Lib' }, locator: 'xii', label: 'page' },
            { id: 'beaver-external-W1', uris: ['https://openalex.org/W1'], itemData: { id: 'beaver-external-W1' } },
        ]);
        expect(first.fallbackTexts).toEqual(['(ext-FILE0001, p. 2)']);
        expect(missing).toMatchObject({ html: '', items: [], fallbackTexts: [] });
        expect(note.fallbackTexts).toEqual(['(My note)']);
        expect(result.warnings).toEqual([expect.objectContaining({ code: 'unresolved_citations', count: 1 })]);
        expect(JSON.parse(result.citations.documentData!)).toMatchObject({
            style: { styleID: 'http://www.zotero.org/styles/apa', locale: 'en-US', hasBibliography: true, bibliographyStyleHasBeenSet: true },
            prefs: { fieldType: 'Field' },
        });
    });

    it('loads citation styles before formatting', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'A <citation id="u-AAAAAAAA"/>' }] });
        await formatExportCitations(doc, snapshot(), service as any, { liveCitations: true });
        expect(Zotero.Styles.init).toHaveBeenCalledOnce();
    });

    it('formats clusters in written order and maps results back to their clusters', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown:
            'Body[^n] <citation id="u-AAAAAAAA" loc="page1"/>.\n\n[^n]: Note <citation id="u-AAAAAAAA" loc="page9"/>.' }] });
        const result = await formatExportCitations(doc, snapshot(), service as any, { liveCitations: true });
        const request = service.formatCitationSequence.mock.calls[0][0];
        // The footnote's citation (cluster 1) is met before the body citation (cluster 0).
        expect(request.clusters.map((cluster: any) => cluster.items[0].locator)).toEqual(['9', '1']);
        expect(result.citations.clusters[0].plain).toBe('(1:1 & co)');
        expect(result.citations.clusters[1].plain).toBe('(1:9 & co)');
    });

    it('omits document preferences for static citations', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'A <citation id="u-AAAAAAAA"/>' }] });
        const result = await formatExportCitations(doc, snapshot(), service as any, { liveCitations: false });
        expect(result.citations.documentData).toBeNull();
    });
});
