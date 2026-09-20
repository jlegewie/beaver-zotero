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
    it('retains an authoritative fetch across acknowledgement updates and fences cached values by account', async () => {
        let generation = 1;
        (Zotero.Beaver as any) = { account: { getGeneration: () => generation } };
        const client = new SearchIndexApiClient();
        let resolve!: (value: any) => void;
        vi.spyOn(client as any, 'get').mockImplementation(() => new Promise(r => { resolve = r; }));
        const request = client.requirements();
        expect(client.getCachedRequirements()).toBeUndefined();
        const current = { index_version: 3, namespace_generation: 2, index_validity: 'current' as const,
            extract_schema_versions: { pdf: ['4'], epub: ['1'], snapshot: ['1'] } };
        client.recordRequirements(current);
        expect(client.getCachedRequirements()).toBe(current);
        const authoritative = { ...current, index_validity: 'missing' };
        resolve(authoritative);
        await request;
        expect(client.getCachedRequirements()).toEqual(authoritative);
        expect(await client.requirements()).toEqual(authoritative);
        generation++;
        expect(client.getCachedRequirements()).toBeUndefined();
    });

    it('preserves an acknowledgement after a concurrent GET fails while allowing a fresh GET', async () => {
        let generation = 1;
        (Zotero.Beaver as any) = { account: { getGeneration: () => generation } };
        const client = new SearchIndexApiClient();
        let reject!: (error: Error) => void;
        const get = vi.spyOn(client as any, 'get').mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
        const request = client.requirements();
        const current = { index_version: 3, namespace_generation: 2, index_validity: 'current' as const,
            extract_schema_versions: { pdf: ['4'], epub: ['1'], snapshot: ['1'] } };
        client.recordRequirements(current);
        reject(new Error('offline'));
        await expect(request).rejects.toThrow('offline');
        expect(client.getCachedRequirements()).toBe(current);
        const authoritative = { ...current, index_validity: 'missing' };
        get.mockResolvedValueOnce(authoritative);
        expect(await client.requirements()).toEqual(authoritative);
        expect(get).toHaveBeenCalledTimes(2);
        expect(client.getCachedRequirements()).toEqual(authoritative);
        generation++;
        expect(client.getCachedRequirements()).toBeUndefined();
    });

    it.each([false, true])('expires unknown requirements promptly (recorded=%s)', async recorded => {
        vi.useFakeTimers();
        try {
            const client = new SearchIndexApiClient();
            const unknown = { index_version: 3, index_validity: 'unknown' as const, namespace_generation: null,
                extract_schema_versions: { pdf: ['4'], epub: ['1'], snapshot: ['1'] } };
            const get = vi.spyOn(client as any, 'get').mockResolvedValue(unknown);
            if (recorded) client.recordRequirements(unknown);
            else await client.requirements();
            get.mockClear();
            await vi.advanceTimersByTimeAsync(4999);
            await client.requirements();
            expect(get).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            await client.requirements();
            expect(get).toHaveBeenCalledTimes(1);
        } finally { vi.useRealTimers(); }
    });

});
