import { beforeEach, describe, expect, it, vi } from 'vitest';

// agentRunAtoms.ts transitively imports the WS transport layer. Mock it wholesale
// (rather than pulling in agentDataProvider's handler graph) since this test only
// cares about the arguments the chat-send path passes into connect().
const FIXTURE_IDENTITY = {
    frontendVersion: '0.99.1-test',
    clientType: 'zotero-plugin',
    clientFeatures: ['note_support', 'view_page_images'],
    zoteroInstance: {
        local_user_key: 'test-local-key',
        index_scope_refs: [{ library_id: 1 }],
    },
};
const { connectMock, resolveClientIdentityMock } = vi.hoisted(() => ({
    connectMock: vi.fn().mockResolvedValue(undefined),
    resolveClientIdentityMock: vi.fn(),
}));
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentService: { connect: connectMock, close: vi.fn() },
    AgentConnectionError: class AgentConnectionError extends Error {},
}));
vi.mock('@beaver/agent-core/transport/clientIdentity', () => ({
    resolveClientIdentity: resolveClientIdentityMock,
}));

vi.mock('../../../react/atoms/applicationState', () => ({
    getApplicationStateProvider: vi.fn(() => async () => ({})),
}));

vi.mock('../../../src/services/systemNotifications', () => ({
    notifyRunComplete: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));

vi.mock('@beaver/agent-core/transport/clients/diagnosticsService', () => ({
    reportConnectionFailure: vi.fn(),
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: {
        auth: { getSession: vi.fn(), refreshSession: vi.fn() },
    },
}));

vi.mock('../../../src/beaver-extract', () => ({
    prewarmMuPDFWorker: vi.fn(),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { store } from '../../../react/store';
import { sendWSMessageAtom } from '../../../react/atoms/agentRunAtoms';
import { sessionAtom } from '../../../react/atoms/auth';

describe('sendWSMessageAtom connect() identity', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockResolvedValue(undefined);
        resolveClientIdentityMock.mockReturnValue(FIXTURE_IDENTITY);
        store.set(sessionAtom, { user: { id: 'user-1' } } as any);
    });

    it('forwards the identity resolved by the client-identity seam, unchanged', async () => {
        await store.set(sendWSMessageAtom, 'hello');

        expect(resolveClientIdentityMock).toHaveBeenCalledTimes(1);
        expect(connectMock).toHaveBeenCalledTimes(1);
        const [, , frontendVersion, clientType, clientFeatures, zoteroInstance] = connectMock.mock.calls[0];
        expect(frontendVersion).toBe(FIXTURE_IDENTITY.frontendVersion);
        expect(clientType).toBe(FIXTURE_IDENTITY.clientType);
        expect(clientFeatures).toBe(FIXTURE_IDENTITY.clientFeatures);
        // Same reference as resolveClientIdentity() returned — no defensive
        // copy needed since the seam already builds a fresh object per call.
        expect(zoteroInstance).toBe(FIXTURE_IDENTITY.zoteroInstance);
    });
});
