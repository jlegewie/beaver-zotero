import { beforeEach, describe, expect, it, vi } from 'vitest';

// agentRunAtoms.ts transitively imports the WS transport layer. Mock it wholesale
// (rather than pulling in agentDataProvider's handler graph) since this test only
// cares about the request the chat-send path passes into connect() and the
// callbacks it hands over with it.
const FIXTURE_IDENTITY = {
    frontendVersion: '0.99.1-test',
    clientType: 'zotero-plugin',
    clientFeatures: ['note_support', 'view_page_images'],
    zoteroInstance: {
        local_user_key: 'test-local-key',
        index_scope_refs: [{ library_id: 1 }],
    },
    extractSchemaVersions: { pdf: { current: '4', producible: ['4'] } },
};
const { connectMock, resolveClientIdentityMock } = vi.hoisted(() => ({
    connectMock: vi.fn().mockResolvedValue(undefined),
    resolveClientIdentityMock: vi.fn(),
}));
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentService: { connect: connectMock, close: vi.fn(), cancelHandoff: () => null, canLeaveRun: () => false, leaveRun: () => false, isReattaching: () => false },
    AgentConnectionError: class AgentConnectionError extends Error {},
}));
vi.mock('@beaver/agent-core/transport/clientIdentity', () => ({
    resolveClientIdentity: resolveClientIdentityMock,
}));

vi.mock('../../../src/services/searchIndexState', () => ({
    getSearchIndexState: vi.fn().mockResolvedValue({ version: 1, libraries: [{ library_ref: 'u', total: 100, indexed: 91, unavailable: 0 }] }),
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
import { isWSChatPendingAtom, sendWSMessageAtom } from '../../../react/atoms/agentRunAtoms';
import { sessionAtom } from '../../../react/atoms/auth';
import { pendingFeatureCreditsAtom } from '../../../react/atoms/featureCreditRuns';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';

describe('feature credits on the chat request', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockResolvedValue(undefined);
        resolveClientIdentityMock.mockReturnValue(FIXTURE_IDENTITY);
        store.set(sessionAtom, { user: { id: 'user-1' } } as any);
        store.set(isWSChatPendingAtom, false);
        store.set(activeRunAtom, null);
        store.set(pendingFeatureCreditsAtom, new Map());
    });

    it('names the feature task on the message it was sent for, and keeps it with the run', async () => {
        await store.set(sendWSMessageAtom, '/annotate the methods', { featureTask: 'annotate' });
        expect(connectMock.mock.calls[0][0].user_prompt.feature_task).toBe('annotate');
        expect(store.get(activeRunAtom)!.user_prompt.feature_task).toBe('annotate');
    });

    it('names no feature task on an ordinary message', async () => {
        await store.set(sendWSMessageAtom, 'hello');
        expect(connectMock.mock.calls[0][0].user_prompt).not.toHaveProperty('feature_task');
    });

    it('remembers the credits an acknowledgement reports for its run', async () => {
        await store.set(sendWSMessageAtom, '/annotate the methods', { featureTask: 'annotate' });
        const callbacks = connectMock.mock.calls[0][1];
        const runId = store.get(activeRunAtom)!.id;
        callbacks.onRequestAck({ runId, modelId: null, modelName: null, chargeType: 'credits', featureCredit: { key: 'annotate', credits: 5 } });
        expect([...store.get(pendingFeatureCreditsAtom).values()]).toEqual([{ runId, key: 'annotate', credits: 5 }]);
    });

    it('remembers nothing for an acknowledgement without credits', async () => {
        await store.set(sendWSMessageAtom, 'hello');
        const callbacks = connectMock.mock.calls[0][1];
        callbacks.onRequestAck({ runId: store.get(activeRunAtom)!.id, modelId: null, modelName: null, chargeType: 'credits' });
        expect(store.get(pendingFeatureCreditsAtom).size).toBe(0);
    });
});
