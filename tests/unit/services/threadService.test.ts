import { beforeEach, describe, expect, it, vi } from 'vitest';

// ThreadService's import chain reaches supabaseClient, which throws at module
// load without Supabase env. Stub it (we spy on `get` and never hit the network).
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

import { ThreadService } from '../../../src/services/threadService';

/**
 * Unit tests for ThreadService.findThreadsByItem — the library arrives as a DTO
 * carrying both identities, so these cover how the service turns it into query
 * params. Deriving the portable ref from a local library id is the caller's job
 * and is covered in `libraryIdentity.test.ts`.
 */
describe('ThreadService.findThreadsByItem', () => {
    let service: ThreadService;
    let getSpy: ReturnType<typeof vi.spyOn>;
    let lastEndpoint: string;

    beforeEach(() => {
        service = new ThreadService('https://example.test');
        // Capture the endpoint the service would call; don't hit the network.
        getSpy = vi.spyOn(service as any, 'get').mockImplementation(async (endpoint: string) => {
            lastEndpoint = endpoint;
            return [];
        });
        lastEndpoint = '';
    });

    function params(): URLSearchParams {
        const qs = lastEndpoint.split('?')[1] ?? '';
        return new URLSearchParams(qs);
    }

    it('sends both identities for the personal library', async () => {
        await service.findThreadsByItem({ libraryId: 1, libraryRef: 'u' }, ['ABC123'], 'both');

        expect(getSpy).toHaveBeenCalledOnce();
        const p = params();
        expect(p.get('library_id')).toBe('1');
        expect(p.get('library_ref')).toBe('u');
        expect(p.getAll('zotero_keys')).toEqual(['ABC123']);
        expect(p.get('mode')).toBe('both');
    });

    it('sends both identities for a group library', async () => {
        await service.findThreadsByItem({ libraryId: 7, libraryRef: 'g12345' }, ['GRP001'], 'citations');

        const p = params();
        // The device-local id still rides along for the numeric fallback.
        expect(p.get('library_id')).toBe('7');
        expect(p.get('library_ref')).toBe('g12345');
    });

    it('omits library_ref when the caller has none', async () => {
        await service.findThreadsByItem({ libraryId: -1, libraryRef: null }, ['EXT00001']);

        const p = params();
        expect(p.get('library_id')).toBe('-1');
        expect(p.has('library_ref')).toBe(false);
    });

    it('omits library_ref when the caller leaves it out entirely', async () => {
        await service.findThreadsByItem({ libraryId: 99 }, ['K1']);

        const p = params();
        expect(p.get('library_id')).toBe('99');
        expect(p.has('library_ref')).toBe(false);
    });

    it('forwards multiple zotero keys alongside the ref', async () => {
        await service.findThreadsByItem({ libraryId: 1, libraryRef: 'u' }, ['K1', 'K2', 'K3']);

        const p = params();
        expect(p.getAll('zotero_keys')).toEqual(['K1', 'K2', 'K3']);
        expect(p.get('library_ref')).toBe('u');
    });
});

/**
 * Unit tests for the instance-scope params on the thread listing endpoints and
 * the claim-instance request shape. Identity always arrives as a DTO — the
 * service performs no identity lookups itself.
 */
describe('ThreadService instance scoping', () => {
    let service: ThreadService;
    let getSpy: ReturnType<typeof vi.fn>;
    let postSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        service = new ThreadService('https://example.test');
        getSpy = vi.fn().mockResolvedValue({ data: [], next_cursor: null, has_more: false });
        postSpy = vi.fn().mockResolvedValue({ claimed: 0 });
        (service as any).get = getSpy;
        (service as any).post = postSpy;
    });

    describe('getPaginatedThreads', () => {
        it('sends no identity params when unscoped', async () => {
            await service.getPaginatedThreads(15);
            expect(getSpy).toHaveBeenCalledWith('/api/v1/threads/paginated?limit=15');
        });

        it('sends both identity params and the count flag when scoped', async () => {
            await service.getPaginatedThreads(15, null, { zoteroUserId: '123', zoteroLocalId: 'LOCALKEY' }, true);
            expect(getSpy).toHaveBeenCalledWith(
                '/api/v1/threads/paginated?limit=15&zotero_user_id=123&zotero_local_id=LOCALKEY&include_other_count=true'
            );
        });

        it('omits a null user id (unsynced install) and the count flag by default', async () => {
            await service.getPaginatedThreads(15, 'cursor-1', { zoteroUserId: null, zoteroLocalId: 'LOCALKEY' });
            expect(getSpy).toHaveBeenCalledWith(
                '/api/v1/threads/paginated?limit=15&after=cursor-1&zotero_local_id=LOCALKEY'
            );
        });
    });

    describe('searchThreads', () => {
        it('sends no identity params when unscoped', async () => {
            await service.searchThreads('foo', 10);
            expect(getSpy).toHaveBeenCalledWith('/api/v1/threads/search?q=foo&limit=10');
        });

        it('appends identity params when scoped', async () => {
            await service.searchThreads('foo', 10, null, { zoteroUserId: '123', zoteroLocalId: 'LOCALKEY' });
            expect(getSpy).toHaveBeenCalledWith(
                '/api/v1/threads/search?q=foo&limit=10&zotero_user_id=123&zotero_local_id=LOCALKEY'
            );
        });
    });

    describe('claimThreads', () => {
        it('posts the claim payload including the expected Beaver user', async () => {
            postSpy.mockResolvedValue({ claimed: 3 });

            const result = await service.claimThreads(
                { zoteroUserId: '123', zoteroLocalId: 'LOCALKEY' },
                'beaver-user-uuid'
            );

            expect(result).toEqual({ claimed: 3 });
            expect(postSpy).toHaveBeenCalledWith('/api/v1/threads/claim-instance', {
                zotero_local_id: 'LOCALKEY',
                zotero_user_id: '123',
                expected_user_id: 'beaver-user-uuid',
            });
        });
    });
});
