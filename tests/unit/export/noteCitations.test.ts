import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/libraryIdentity', () => ({ resolveLibraryRef: vi.fn(() => 1) }));
vi.mock('../../../src/utils/zoteroItemHelpers', () => ({ getBestPDFAttachmentAsync: vi.fn(async () => null) }));

import { formatExportCitations } from '../../../src/services/export/exportCitations';
import type { CitationCluster, ExportDoc, NoteCitationItem } from '@beaver/agent-export/types';

const LIVE = 'http://zotero.org/users/1/items/LIVE0001';
const OLD = 'http://zotero.org/users/99/items/LIVE0001';
const DELETED = 'http://zotero.org/users/1/items/GONE0001';
const CACHED = 'http://zotero.org/groups/5/items/CACHE001';
const NOTHING = 'http://zotero.org/users/1/items/NONE0001';

const EMPTY = { citationsByKey: {}, externalReferences: {}, externalItemMapping: {}, pageLabelsByAttachmentId: {} };

function docWith(clusters: Array<Array<{ note: NoteCitationItem; previewText?: string }>>): ExportDoc {
    const built: CitationCluster[] = clusters.map((items, index) => ({
        index,
        items: items.map(item => ({ ref: null, requestedKey: '', rawTag: '', ...item })),
    }));
    return {
        title: '',
        sections: [{ kind: 'markdown', scope: 0, children: [{ type: 'paragraph', children: built.map(cluster => ({ type: 'citation' as const, clusterIndex: cluster.index })) }] }],
        clusters: built,
    };
}

describe('formatExportCitations for note citations', () => {
    const service = {
        resolveStyle: vi.fn(() => ({ style: { class: 'in-text' }, locale: 'en-US' })),
        formatCitationSequence: vi.fn((request: any) => ({
            styleId: 'apa',
            locale: 'en-US',
            styleClass: 'in-text' as const,
            hasBibliography: true,
            clusters: request.clusters.map((cluster: any) => (cluster.items.length ? { html: '(cited)', rtf: 'rtf' } : null)),
            itemData: Object.fromEntries(request.clusters.flatMap((cluster: any) => cluster.items.map((item: any) => [String(item.id), { id: item.id }]))),
            bibliography: null,
        })),
    };
    const live = { id: 11, key: 'LIVE0001', parentItemID: null, isNote: () => false, loadAllData: vi.fn(async () => {}) };

    beforeEach(() => {
        vi.clearAllMocks();
        (Zotero as any).EditorInstance = { getItemFromURIs: vi.fn(async (uris: string[]) => (uris.includes(LIVE) || uris.includes(OLD) ? live : undefined)) };
        (Zotero as any).URI = { getItemURI: vi.fn(() => LIVE) };
        (Zotero as any).Items = { getAsync: vi.fn() };
        (Zotero as any).Styles = { initialized: vi.fn(() => true), init: vi.fn() };
    });

    it('cites the library item a citation names, with its stored locator type and notes', async () => {
        const doc = docWith([[{ note: { uris: [OLD], locator: '3', label: 'chapter', prefix: 'see', suffix: 'n. 2', suppressAuthor: true } }]]);
        const result = await formatExportCitations(doc, EMPTY, service as any, { liveCitations: false });
        expect(service.formatCitationSequence.mock.calls[0][0].clusters[0].items).toEqual([
            { id: 11, locator: '3', label: 'chapter', prefix: 'see', suffix: 'n. 2', suppressAuthor: true },
        ]);
        // The item's current URI first; the stored one kept for Zotero to recognize.
        expect(result.citations.clusters[0].items[0]).toMatchObject({ id: 11, uris: [LIVE, OLD], label: 'chapter', suppressAuthor: true });
        expect(result.warnings).toEqual([]);
    });

    it('keeps a citation of a deleted item a citation, from its inline or stored metadata', async () => {
        const doc = docWith([
            [{ note: { uris: [DELETED], itemData: { id: DELETED, type: 'book', title: 'Gone' }, locator: 'xii' } }],
            [{ note: { uris: [CACHED] } }, { note: { uris: [DELETED] } }],
        ]);
        const result = await formatExportCitations(doc, EMPTY, service as any, {
            liveCitations: false,
            noteCitationItems: [{ uris: [CACHED], itemData: { id: CACHED, type: 'article', title: 'Cached' } }],
        });
        const request = service.formatCitationSequence.mock.calls[0][0];
        const [gone] = request.clusters[0].items;
        const [cached, goneAgain] = request.clusters[1].items;
        expect(gone).toMatchObject({ locator: 'xii', label: 'page' });
        // One work, one processor id, however often it is cited.
        expect(goneAgain.id).toBe(gone.id);
        expect(request.embeddedItems[gone.id]).toEqual({ id: DELETED, type: 'book', title: 'Gone' });
        expect(request.embeddedItems[cached.id]).toEqual({ id: CACHED, type: 'article', title: 'Cached' });
        expect(result.citations.clusters[1].items.map(item => item.uris)).toEqual([[CACHED], [DELETED]]);
        expect(result.warnings).toEqual([]);
    });

    it('treats a work cited under the same URIs in another order as one work', async () => {
        const data = { id: DELETED, type: 'book', title: 'Gone' };
        const doc = docWith([[{ note: { uris: [DELETED, NOTHING], itemData: data } }], [{ note: { uris: [NOTHING, DELETED] } }]]);
        await formatExportCitations(doc, EMPTY, service as any, { liveCitations: false });
        const request = service.formatCitationSequence.mock.calls[0][0];
        expect(request.clusters[1].items[0].id).toBe(request.clusters[0].items[0].id);
        expect(Object.keys(request.embeddedItems)).toHaveLength(1);
    });

    it('treats URIs the stored metadata lists together as one work', async () => {
        const ALIAS = 'http://zotero.org/users/1/items/ALIAS001';
        const doc = docWith([[{ note: { uris: [DELETED] } }], [{ note: { uris: [ALIAS] } }]]);
        await formatExportCitations(doc, EMPTY, service as any, {
            liveCitations: false,
            noteCitationItems: [{ uris: [DELETED, ALIAS], itemData: { id: DELETED, type: 'book', title: 'Gone' } }],
        });
        const request = service.formatCitationSequence.mock.calls[0][0];
        expect(request.clusters[1].items[0].id).toBe(request.clusters[0].items[0].id);
    });

    it('writes what the note shows for an item it cannot resolve, and says so', async () => {
        const doc = docWith([[{ note: { uris: [LIVE] } }, { note: { uris: [NOTHING] }, previewText: '(Nobody, 1999)' }]]);
        const result = await formatExportCitations(doc, EMPTY, service as any, { liveCitations: false });
        expect(result.citations.clusters[0].items.map(item => item.id)).toEqual([11]);
        expect(result.citations.clusters[0].fallbackTexts).toEqual(['(Nobody, 1999)']);
        expect(result.warnings).toEqual([expect.objectContaining({ code: 'unresolved_citations', count: 1 })]);
    });

    it('writes a citation that shows its items only together as the note shows it when one cannot be resolved', async () => {
        const doc = docWith([[
            { note: { uris: [LIVE] }, groupPreview: '(Live 2014; Nobody 1999; Other 2000)' },
            { note: { uris: [NOTHING] }, groupPreview: '(Live 2014; Nobody 1999; Other 2000)' },
            { note: { uris: ['http://zotero.org/users/1/items/OTHER001'] }, groupPreview: '(Live 2014; Nobody 1999; Other 2000)' },
        ]]);
        const result = await formatExportCitations(doc, EMPTY, service as any, { liveCitations: false });
        // Not the resolved work formatted and then again inside the preview.
        expect(result.citations.clusters[0].items).toEqual([]);
        expect(result.citations.clusters[0].fallbackTexts).toEqual(['(Live 2014; Nobody 1999; Other 2000)']);
        expect(result.warnings).toEqual([expect.objectContaining({ code: 'unresolved_citations', count: 2 })]);
    });

    it('cites the works of a citation shown only together when all of them resolve', async () => {
        const doc = docWith([[
            { note: { uris: [LIVE], locator: '3' }, groupPreview: '(Live 2014, p. 3; Live 2014, p. 8)' },
            { note: { uris: [OLD], locator: '8' }, groupPreview: '(Live 2014, p. 3; Live 2014, p. 8)' },
        ]]);
        const result = await formatExportCitations(doc, EMPTY, service as any, { liveCitations: false });
        expect(result.citations.clusters[0].items.map(item => item.locator)).toEqual(['3, 8']);
        expect(result.citations.clusters[0].fallbackTexts).toEqual([]);
    });

    it('merges the same work twice in a cluster only when cited the same way', async () => {
        const doc = docWith([[
            { note: { uris: [LIVE], locator: '3' } },
            { note: { uris: [LIVE], locator: '8' } },
            { note: { uris: [LIVE], locator: '2', label: 'chapter' } },
        ]]);
        await formatExportCitations(doc, EMPTY, service as any, { liveCitations: false });
        expect(service.formatCitationSequence.mock.calls[0][0].clusters[0].items).toEqual([
            { id: 11, locator: '3, 8', label: 'page' },
            { id: 11, locator: '2', label: 'chapter' },
        ]);
    });
});
