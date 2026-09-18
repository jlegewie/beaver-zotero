import { beforeEach, describe, expect, it, vi } from 'vitest';
const { observe, kind } = vi.hoisted(() => ({ observe: vi.fn(), kind: vi.fn() }));
vi.mock('../../../src/services/documentExtraction/sourceObservation', () => ({ observeAttachmentSource: observe }));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({ getReadableContentKind: kind }));
vi.mock('../../../src/utils/zoteroInstanceIdentity', () => ({ getIndexScopeRef: (id: number) => `g${id}` }));
import { discoverSearchCensus } from '../../../src/services/searchIndex/searchCensus';

describe('complete search attachment census', () => {
    let items: any[];
    let rows: any[];
    beforeEach(() => {
        vi.clearAllMocks();
        items = Array.from({ length: 10 }, (_, id) => ({ id, key: `key${id}`, libraryID: 1, kind: 'pdf' }));
        rows = [{ zoteroKey: 'key0', contentKind: 'pdf', extractStatus: 'done', structuredDocumentHash: 'hash0',
            extractSchemaVersion: '4', extractionSource: 'source0' }];
        Zotero.Beaver = { db: { getAttachmentProcessingStatesByLibrary: async () => rows } } as any;
        (Zotero as any).DB = {};
        (Zotero as any).Items = {};
        (Zotero as any).Attachments = { LINK_MODE_LINKED_URL: 3 };
        Zotero.DB.queryAsync = vi.fn(async (_sql, _params, options: any) => {
            for (const item of items) options.onRow({ getResultByIndex: () => item.id });
        }) as any;
        Zotero.Items.getAsync = vi.fn(async (ids: number[]) => items.filter((item) => ids.includes(item.id))) as any;
        kind.mockImplementation((item) => item.kind);
        observe.mockResolvedValue({ identity: 'source0', signature: { mtime_ms: 1, size_bytes: 2 } });
    });
    it('counts all supported attachments despite an incomplete ledger', async () => {
        const result = await discoverSearchCensus([1], () => true);
        expect(result[0].attachments).toHaveLength(10);
        expect(result[0].attachments.filter((item) => item.identity)).toHaveLength(1);
    });
    it('excludes unsupported files and never queries excluded libraries', async () => {
        items[1].kind = 'image'; items[2].kind = 'text'; items[3].kind = null;
        const result = await discoverSearchCensus([1, 1], () => true);
        expect(result).toHaveLength(1);
        expect(result[0].attachments).toHaveLength(7);
        expect(Zotero.DB.queryAsync).toHaveBeenCalledTimes(1);
        expect(vi.mocked(Zotero.DB.queryAsync).mock.calls[0][1]?.[0]).toBe(1);
    });
    it('retains unavailable supported files in the denominator without trusting an old hash', async () => {
        observe.mockResolvedValue({ identity: 'missing', signature: null });
        const result = await discoverSearchCensus([1], () => true);
        expect(result[0].attachments).toHaveLength(10);
        expect(result[0].attachments.every((item) => !item.identity)).toBe(true);
    });
    it('does not use a previous hash after source replacement or failed observation', async () => {
        observe.mockResolvedValue(null);
        expect((await discoverSearchCensus([1], () => true))[0].attachments[0].identity).toBeNull();
    });
    it('aborts an incomplete discovery instead of publishing a partial denominator', async () => {
        Zotero.Items.getAsync = vi.fn(async () => []) as any;
        await expect(discoverSearchCensus([1], () => true)).rejects.toThrow('changed during enumeration');
    });
    it('fences scope changes before enumerating another library', async () => {
        let current = true;
        observe.mockImplementation(async () => { current = false; return null; });
        await expect(discoverSearchCensus([1, 2], () => current)).rejects.toThrow('scope changed');
        expect(Zotero.DB.queryAsync).toHaveBeenCalledTimes(1);
    });
});
