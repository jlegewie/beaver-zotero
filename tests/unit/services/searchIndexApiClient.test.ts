import { afterEach, describe, expect, it, vi } from 'vitest';
import pako from 'pako';
import { SearchIndexApiClient } from '../../../src/services/searchIndex/searchIndexApiClient';

describe('search index wire contract', () => {
    afterEach(() => vi.restoreAllMocks());
    it('sends a lossless gzip body for payload uploads', async () => {
        const client = new SearchIndexApiClient();
        const post = vi.spyOn(client as any, 'postRaw').mockResolvedValue({ status: 'completed' });
        const request = { source: 'zotero_attachment', scope_ref: 'lDEVICE01', zotero_key: 'ABCDEFGH', zotero_local_id: 'DEVICE01', content_kind: 'snapshot', doc_hash: 'a'.repeat(64), extract_schema_version: '1', payload: { text: 'Synthetic text with accents: café.' } };
        await client.upsertPayload(request as any);
        expect(post.mock.calls[0][0]).toBe('/api/v1/index/upsert');
        expect(post.mock.calls[0][2]).toEqual({ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
        expect(JSON.parse(pako.ungzip(post.mock.calls[0][1] as Uint8Array, { to: 'string' }))).toEqual(request);
    });
    it('uploads EPUB payloads without their citation index under the cached document hash', async () => {
        const client = new SearchIndexApiClient();
        const post = vi.spyOn(client as any, 'postRaw').mockResolvedValue({ status: 'completed' });
        const payload = {
            content_kind: 'epub',
            schemaVersion: '2',
            sectionCount: 1,
            sections: [{ index: 0, rawHref: 'a.xhtml', items: [{ id: 'p1', text: 'Body.' }] }],
            citationIndex: { p1: { id: 'p1', kind: 'item', sectionIndex: 0, itemId: 'p1' } },
            diagnostics: { extractedTextChars: 5, sourceTextChars: 5, textCoverage: 1 },
        };
        const request = { source: 'zotero_attachment', scope_ref: 'lDEVICE01', zotero_key: 'ABCDEFGH', zotero_local_id: 'DEVICE01', content_kind: 'epub', doc_hash: 'b'.repeat(64), extract_schema_version: '2', payload };

        await client.upsertPayload(request as any);

        const sent = JSON.parse(pako.ungzip(post.mock.calls[0][1] as Uint8Array, { to: 'string' }));
        expect(sent.doc_hash).toBe('b'.repeat(64));
        expect(sent.payload).not.toHaveProperty('citationIndex');
        expect(sent.payload.sections).toEqual(payload.sections);
        // The caller's cached document is not modified.
        expect(payload.citationIndex).toBeDefined();
    });
    it('bounds both upsert paths with a client deadline', async () => {
        // Without a deadline an upsert waits forever and pins one of the
        // lane's in-flight slots, so this backstop must not be dropped.
        const client = new SearchIndexApiClient();
        const request = { source: 'zotero_attachment', scope_ref: 'lDEVICE01', zotero_key: 'ABCDEFGH', zotero_local_id: 'DEVICE01', content_kind: 'snapshot', doc_hash: 'a'.repeat(64), extract_schema_version: '1' };
        const postRaw = vi.spyOn(client as any, 'postRaw').mockResolvedValue({ status: 'completed' });
        const post = vi.spyOn(client as any, 'post').mockResolvedValue({ status: 'tagged' });

        await client.upsertPayload({ ...request, payload: { text: 'x' } } as any);
        await client.upsertHash(request as any);

        // Held above the backend's own whole-document deadline so the server
        // answers with a coded, retry-carrying 503 before this fires.
        expect((postRaw.mock.calls[0][3] as any).timeoutMs).toBeGreaterThan(300_000);
        expect((post.mock.calls[0][2] as any).timeoutMs).toBeGreaterThan(300_000);
    });
    it('shares requirements within an account generation and retries failed reads', async () => {
        let generation = 1;
        (Zotero.Beaver as any) = { account: { getGeneration: () => generation } };
        const client = new SearchIndexApiClient();
        const get = vi.spyOn(client as any, 'get').mockResolvedValue({ index_version: 3 });
        await Promise.all([client.requirements(), client.requirements()]);
        expect(get).toHaveBeenCalledTimes(1);
        generation++;
        get.mockRejectedValueOnce(new Error('offline'));
        await expect(client.requirements()).rejects.toThrow('offline');
        await client.requirements();
        expect(get).toHaveBeenCalledTimes(3);
    });
});
