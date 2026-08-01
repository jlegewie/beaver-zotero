import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/getAPIBaseURL', () => ({ default: 'https://api.example.com' }));
vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/services/agentService', () => ({
    getWSAuthToken: vi.fn().mockResolvedValue('token'),
}));
vi.mock('../../../src/services/busyContext', () => ({
    getBusyContext: vi.fn(() => ({ busy: false })),
}));
vi.mock('../../../src/services/syncPause', () => ({
    PROVIDER_MUTATING_RUN_SYNC_PAUSE_OWNER: 'provider-mutating-run',
    scheduleResumeAfterRun: vi.fn(),
}));

import { ProviderConnection } from '../../../src/services/providerConnection';
import { scheduleResumeAfterRun } from '../../../src/services/syncPause';
import { setClientIdentityProvider } from '../../../src/services/clientIdentity';
import type { ClientIdentity } from '../../../src/services/clientIdentity';

const OriginalWebSocket = (globalThis as any).WebSocket;

class TestWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: TestWebSocket[] = [];
    readonly url: string;
    readyState = TestWebSocket.CONNECTING;
    onopen: ((e: any) => void) | null = null;
    onmessage: ((e: any) => void) | null = null;
    onerror: ((e: any) => void) | null = null;
    onclose: ((e: any) => void) | null = null;
    send = vi.fn();
    close = vi.fn(() => { this.readyState = TestWebSocket.CLOSING; });
    constructor(url: string) {
        this.url = url;
        TestWebSocket.instances.push(this);
    }
    emitOpen(): void {
        this.readyState = TestWebSocket.OPEN;
        this.onopen?.(new Event('open'));
    }
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

/**
 * Drive connect() far enough that the auth message is sent (socket creation +
 * open + the ~50ms post-open delay), then return the parsed auth payload. The
 * connect() promise only resolves on a server `ready` event, which this
 * helper never emits, so it is intentionally not awaited.
 */
async function captureAuthMessage(connectCall: () => Promise<void>): Promise<any> {
    const initial = TestWebSocket.instances.length;
    connectCall().catch(() => { /* connect() never settles without a `ready` event */ });
    for (let i = 0; i < 20 && TestWebSocket.instances.length === initial; i++) {
        await Promise.resolve();
    }
    const socket = TestWebSocket.instances[initial];
    if (!socket) throw new Error('Expected connect() to create a WebSocket');
    socket.emitOpen();
    await vi.advanceTimersByTimeAsync(50);

    for (const call of socket.send.mock.calls) {
        const raw = call[0];
        const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (payload && payload.type === 'auth') return payload;
    }
    throw new Error('No auth message was sent');
}

describe('ProviderConnection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        TestWebSocket.instances = [];
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

    describe('auth handshake identity', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('builds the auth message from the registered client identity provider', async () => {
            const identity: ClientIdentity = {
                frontendVersion: '0.22.5',
                clientType: 'zotero-plugin',
                clientFeatures: ['note_support', 'view_page_images'],
                zoteroInstance: { local_user_key: 'user-key-1', account_name: 'test-account' },
            };
            setClientIdentityProvider(() => identity);

            const conn = new ProviderConnection('https://api.example.com', {});
            const auth = await captureAuthMessage(() => conn.connect());

            expect(auth.type).toBe('auth');
            expect(auth.token).toBe('token');
            expect(auth.frontend_version).toBe('0.22.5');
            expect(auth.client_type).toBe('zotero-plugin');
            expect(auth.client_features).toEqual(['note_support', 'view_page_images']);
            expect(auth.zotero_instance).toEqual({ local_user_key: 'user-key-1', account_name: 'test-account' });
            expect(auth.connect_attempts).toBe(1);
        });

        it('re-resolves the identity provider on a second connect attempt', async () => {
            const provider = vi.fn<[], ClientIdentity>()
                .mockReturnValueOnce({
                    frontendVersion: '0.22.5',
                    clientType: 'zotero-plugin',
                    clientFeatures: ['a'],
                    zoteroInstance: { local_user_key: 'first-install' },
                })
                .mockReturnValueOnce({
                    frontendVersion: '0.22.6',
                    clientType: 'zotero-plugin',
                    clientFeatures: ['b'],
                    zoteroInstance: { local_user_key: 'second-install' },
                });
            setClientIdentityProvider(provider);

            const conn = new ProviderConnection('https://api.example.com', {});
            const firstAuth = await captureAuthMessage(() => conn.connect());
            expect(firstAuth.zotero_instance).toEqual({ local_user_key: 'first-install' });

            // Force the connect() promise to settle so the second connect()
            // is not ignored as a duplicate in-flight attempt.
            conn.close();

            const secondAuth = await captureAuthMessage(() => conn.connect());
            expect(secondAuth.zotero_instance).toEqual({ local_user_key: 'second-install' });

            expect(provider).toHaveBeenCalledTimes(2);
        });
    });
});
