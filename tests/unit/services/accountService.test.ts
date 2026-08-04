/**
 * The account endpoints carry this install's identity, and the backend uses it
 * to authorize the account and register the device. A wrong or missing
 * identifier here locks a user out or registers the wrong install, so the
 * emitted request bodies are pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSupabase, mockResolveClientIdentity } = vi.hoisted(() => ({
    mockSupabase: {
        auth: {
            getSession: vi.fn(),
            refreshSession: vi.fn(),
        },
    },
    mockResolveClientIdentity: vi.fn(),
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({ supabase: mockSupabase }));
vi.mock('@beaver/agent-core/transport/clientIdentity', () => ({
    resolveClientIdentity: mockResolveClientIdentity,
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { accountService } from '../../../src/services/accountService';

const IDENTITY = {
    frontendVersion: '0.22.5',
    clientType: 'zotero-plugin',
    clientFeatures: [],
    zoteroInstance: { local_user_key: 'local-key-1', user_id: '90210' },
};

let fetchMock: ReturnType<typeof vi.fn>;

/** The JSON body of the single request the call under test issued. */
function sentBody(): any {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return JSON.parse(fetchMock.mock.calls[0][1].body);
}

describe('AccountService identity payloads', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockResolveClientIdentity.mockReturnValue(IDENTITY);
        fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ message: 'ok' }), { status: 200, statusText: 'OK' }),
        );
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

    it('sends the install identity and version when loading the profile', async () => {
        await accountService.getProfileWithPlan();

        expect(sentBody()).toEqual({
            zotero_local_id: 'local-key-1',
            zotero_user_id: '90210',
            frontend_version: '0.22.5',
            register_first_device: true,
        });
    });

    // Zotero sync being off leaves the account id unknown. The key must be
    // absent rather than sent as null, which the backend would treat as a value.
    it('omits the account id when the install has none', async () => {
        mockResolveClientIdentity.mockReturnValue({
            ...IDENTITY,
            zoteroInstance: { local_user_key: 'local-key-1' },
        });

        await accountService.getProfileWithPlan();

        const body = sentBody();
        expect(body.zotero_local_id).toBe('local-key-1');
        expect('zotero_user_id' in body).toBe(false);
    });

    const IDENTITY_METHODS: [string, () => Promise<unknown>][] = [
        ['authorizeAccess', () => accountService.authorizeAccess(true, [], false, false, false)],
        ['authorizeFreeAccess', () => accountService.authorizeFreeAccess()],
        ['completeUpgradeConsent', () => accountService.completeUpgradeConsent()],
        ['acknowledgeDowngrade', () => accountService.acknowledgeDowngrade()],
    ];

    it.each(IDENTITY_METHODS)('sends the install identity from %s', async (_name, call) => {
        await call();

        const body = sentBody();
        expect(body.zotero_local_id).toBe('local-key-1');
        expect(body.zotero_user_id).toBe('90210');
    });

    it.each(IDENTITY_METHODS)('omits the account id from %s when the install has none', async (_name, call) => {
        mockResolveClientIdentity.mockReturnValue({
            ...IDENTITY,
            zoteroInstance: { local_user_key: 'local-key-1' },
        });

        await call();

        const body = sentBody();
        expect(body.zotero_local_id).toBe('local-key-1');
        expect('zotero_user_id' in body).toBe(false);
    });

    it('returns no models rather than throwing when the model list fails', async () => {
        fetchMock.mockResolvedValue(new Response('nope', { status: 500, statusText: 'Server Error' }));

        await expect(accountService.getModelList('plan-1')).resolves.toEqual([]);
    });
});
