import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/getAPIBaseURL', () => ({ default: 'https://api.example.com' }));
vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ localUserKey: 'local-user-key' })),
    getInstanceLibraryRefs: vi.fn(() => []),
}));
vi.mock('../../../src/services/agentService', () => ({
    getWSAuthToken: vi.fn().mockResolvedValue('token'),
}));
vi.mock('../../../src/services/busyContext', () => ({
    getBusyContext: vi.fn(() => ({ busy: false })),
}));
vi.mock('../../../src/services/agentDataDispatch', () => ({
    createZoteroDataProvider: vi.fn(() => ({})),
}));
vi.mock('../../../src/services/syncPause', () => ({
    PROVIDER_MUTATING_RUN_SYNC_PAUSE_OWNER: 'provider-mutating-run',
    scheduleResumeAfterRun: vi.fn(),
}));

import { ProviderConnection } from '../../../src/services/providerConnection';
import { scheduleResumeAfterRun } from '../../../src/services/syncPause';

const OriginalWebSocket = (globalThis as any).WebSocket;

class TestWebSocket {
    static OPEN = 1;
}

function installFakeSocket(conn: ProviderConnection) {
    const sent: string[] = [];
    (conn as any).ws = {
        readyState: TestWebSocket.OPEN,
        send: vi.fn((message: string) => sent.push(message)),
    };
    return sent;
}

async function dispatchProviderMessage(conn: ProviderConnection, event: Record<string, any>) {
    await (conn as any).handleMessage(JSON.stringify(event), Date.now(), vi.fn());
    await (conn as any).actionExecutionQueue;
}

describe('ProviderConnection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).WebSocket = TestWebSocket;
    });

    afterEach(() => {
        (globalThis as any).WebSocket = OriginalWebSocket;
    });

    it('schedules sync resume with the mutating entry owner after a provider action settles', async () => {
        const dataProvider = {
            agent_action_execute: {
                handle: vi.fn().mockResolvedValue({
                    type: 'agent_action_execute_response',
                    request_id: 'req-1',
                    success: true,
                }),
                errorResponse: vi.fn(),
                serialize: true,
                syncPauseOwner: 'custom-owner',
            },
        };
        const conn = new ProviderConnection('https://api.example.com', dataProvider);
        const sent = installFakeSocket(conn);

        await dispatchProviderMessage(conn, {
            event: 'agent_action_execute',
            request_id: 'req-1',
        });

        expect(dataProvider.agent_action_execute.handle).toHaveBeenCalledTimes(1);
        expect(scheduleResumeAfterRun).toHaveBeenCalledWith('custom-owner');
        expect(JSON.parse(sent[0])).toMatchObject({
            type: 'agent_action_execute_response',
            request_id: 'req-1',
            success: true,
        });
    });

    it('does not schedule sync resume for non-mutating provider requests', async () => {
        const dataProvider = {
            list_items_request: {
                handle: vi.fn().mockResolvedValue({
                    type: 'list_items',
                    request_id: 'req-1',
                    items: [],
                    total_count: 0,
                }),
                errorResponse: vi.fn(),
            },
        };
        const conn = new ProviderConnection('https://api.example.com', dataProvider);
        const sent = installFakeSocket(conn);

        await dispatchProviderMessage(conn, {
            event: 'list_items_request',
            request_id: 'req-1',
        });
        await Promise.resolve();

        expect(dataProvider.list_items_request.handle).toHaveBeenCalledTimes(1);
        expect(scheduleResumeAfterRun).not.toHaveBeenCalled();
        expect(JSON.parse(sent[0])).toMatchObject({
            type: 'list_items',
            request_id: 'req-1',
        });
    });
});
