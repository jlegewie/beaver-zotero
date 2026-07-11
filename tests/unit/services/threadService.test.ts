import { beforeEach, describe, expect, it, vi } from 'vitest';

// ThreadService's import chain reaches supabaseClient, which throws at module
// load without Supabase env. Stub it (we spy on `get` and never hit the network).
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

import { ThreadService } from '../../../src/services/threadService';

/**
 * Unit tests for ThreadService.findThreadsByItem — verifies the device-portable
 * `library_ref` is derived from the local libraryID and appended to the query so
 * the backend can match group items written on another device.
 */
describe('ThreadService.findThreadsByItem', () => {
    const zotero = (globalThis as any).Zotero;
    const getGroupIDFromLibraryID = vi.fn();

    let service: ThreadService;
    let getSpy: ReturnType<typeof vi.spyOn>;
    let lastEndpoint: string;

    beforeEach(() => {
        getGroupIDFromLibraryID.mockReset();
        zotero.Libraries = { ...zotero.Libraries, userLibraryID: 1 };
        zotero.Groups = { ...zotero.Groups, getGroupIDFromLibraryID };

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

    it('appends library_ref="u" for the personal library', async () => {
        await service.findThreadsByItem(1, ['ABC123'], 'both');

        expect(getSpy).toHaveBeenCalledOnce();
        const p = params();
        expect(p.get('library_id')).toBe('1');
        expect(p.get('library_ref')).toBe('u');
        expect(p.getAll('zotero_keys')).toEqual(['ABC123']);
        expect(p.get('mode')).toBe('both');
    });

    it('appends library_ref="g<groupID>" for a group library', async () => {
        getGroupIDFromLibraryID.mockReturnValue(12345);

        await service.findThreadsByItem(7, ['GRP001'], 'citations');

        const p = params();
        // The device-local id (7) still rides along for the numeric fallback.
        expect(p.get('library_id')).toBe('7');
        expect(p.get('library_ref')).toBe('g12345');
        expect(getGroupIDFromLibraryID).toHaveBeenCalledWith(7);
    });

    it('omits library_ref for the external-file sentinel (-1)', async () => {
        await service.findThreadsByItem(-1, ['EXT00001']);

        const p = params();
        expect(p.get('library_id')).toBe('-1');
        expect(p.has('library_ref')).toBe(false);
    });

    it('omits library_ref when the group lookup fails (feed / unknown library)', async () => {
        getGroupIDFromLibraryID.mockImplementation(() => {
            throw new Error('Group not found');
        });

        await service.findThreadsByItem(99, ['K1']);

        const p = params();
        expect(p.get('library_id')).toBe('99');
        expect(p.has('library_ref')).toBe(false);
    });

    it('forwards multiple zotero keys alongside the ref', async () => {
        await service.findThreadsByItem(1, ['K1', 'K2', 'K3']);

        const p = params();
        expect(p.getAll('zotero_keys')).toEqual(['K1', 'K2', 'K3']);
        expect(p.get('library_ref')).toBe('u');
    });
});
