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
