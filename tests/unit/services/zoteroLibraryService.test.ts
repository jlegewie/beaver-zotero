/**
 * Pins the request envelope and the offline vs. other-failure branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSupabase } = vi.hoisted(() => ({
    mockSupabase: {
        auth: {
            getSession: vi.fn(),
            refreshSession: vi.fn(),
        },
    },
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({ supabase: mockSupabase }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    isZoteroOffline,
    zoteroLibraryService,
} from '@beaver/agent-core/transport/clients/zoteroLibraryService';
import { ApiError } from '@beaver/agent-core/types/apiErrors';

let fetchMock: ReturnType<typeof vi.fn>;

/** Response body the backend returns for a failed library request. */
function providerFailure(code: string, message: string): Response {
    return new Response(JSON.stringify({ detail: { code, message } }), {
        status: 424,
        statusText: 'Failed Dependency',
    });
}

describe('zoteroLibraryService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        mockSupabase.auth.getSession.mockResolvedValue({
            data: {
                session: {
                    access_token: 'token',
                    expires_at: Math.floor(Date.now() / 1000) + 3600,
                },
            },
            error: null,
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends the op envelope and returns that op\'s data', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    op: 'list_tags',
                    data: {
                        tags: [{ name: 'methods', item_count: 4, color: '#FF6666' }],
                        total_count: 1,
                        library_id: 1,
                        library_ref: 'u',
                        library_name: 'My Library',
                    },
                }),
                { status: 200, statusText: 'OK' },
            ),
        );

        const data = await zoteroLibraryService.runOp('list_tags', {
            library_id: 'u',
            min_item_count: 2,
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain('/api/v1/zotero/request');
        expect(JSON.parse(init.body)).toEqual({
            op: 'list_tags',
            params: { library_id: 'u', min_item_count: 2 },
        });
        expect(data.total_count).toBe(1);
        expect(data.tags[0].name).toBe('methods');
        expect(data.library_ref).toBe('u');
    });

    it('surfaces a closed Zotero as the offline signal, not a generic failure', async () => {
        fetchMock.mockResolvedValue(
            providerFailure('zotero_offline', 'Zotero is not reachable. Open Zotero and try again.'),
        );

        const error = await zoteroLibraryService
            .runOp('list_libraries', {})
            .then(() => null, (e: unknown) => e);

        expect(isZoteroOffline(error)).toBe(true);
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).message).toContain('Open Zotero');
    });

    it('does not report other provider failures as offline', async () => {
        fetchMock.mockResolvedValue(
            providerFailure('library_not_found', 'No library named "Shared" on this device.'),
        );

        const error = await zoteroLibraryService
            .runOp('list_collections', { library_id: 'Shared' })
            .then(() => null, (e: unknown) => e);

        expect(error).toBeInstanceOf(ApiError);
        expect(isZoteroOffline(error)).toBe(false);
        expect((error as ApiError).code).toBe('library_not_found');
    });
});
