/**
 * Lock for the WS auth-handshake envelope that AgentService.connect() sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSupabase } = vi.hoisted(() => ({
    mockSupabase: {
        auth: { getSession: vi.fn(), refreshSession: vi.fn() },
    },
}));

vi.mock('../../../src/services/supabaseClient', () => ({ supabase: mockSupabase }));
vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/services/agentDataProvider', () => ({
    handleZoteroDataRequest: vi.fn(),
    handleExternalReferenceCheckRequest: vi.fn(),
    handleZoteroDocumentRequest: vi.fn(),
    handleZoteroAttachmentPageImagesRequest: vi.fn(),
    handleZoteroAttachmentSearchRequest: vi.fn(),
    handleItemSearchByMetadataRequest: vi.fn(),
    handleItemSearchByTopicRequest: vi.fn(),
    handleZoteroSearchRequest: vi.fn(),
    handleListItemsRequest: vi.fn(),
    handleListCollectionsRequest: vi.fn(),
    handleListTagsRequest: vi.fn(),
    handleListLibrariesRequest: vi.fn(),
    handleGetMetadataRequest: vi.fn(),
    handleGetAnnotationsRequest: vi.fn(),
    handleFindAnnotationsRequest: vi.fn(),
    handleAgentActionValidateRequest: vi.fn(),
    handleAgentActionExecuteRequest: vi.fn(),
    handleReadNoteRequest: vi.fn(),
}));
vi.mock('../../../react/agents/agentActions', () => ({ toAgentAction: vi.fn((a) => a) }));

import { AgentService } from '../../../src/services/agentService';
import type { AgentRunRequest, WSCallbacks, ZoteroInstanceWire } from '../../../src/services/agentProtocol';

class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];
    readonly url: string;
    readyState = MockWebSocket.CONNECTING;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    send = vi.fn();
    close = vi.fn(() => { this.readyState = MockWebSocket.CLOSING; });
    constructor(url: string) { this.url = url; MockWebSocket.instances.push(this); }
    emitOpen(): void { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }
}

function createCallbacks(): WSCallbacks {
    return {
        onReady: vi.fn(), onRequestAck: vi.fn(),
        onPart: vi.fn().mockResolvedValue(undefined), onToolReturn: vi.fn().mockResolvedValue(undefined),
        onToolCallProgress: vi.fn(), onToolCallArgsStream: vi.fn(),
        onRunComplete: vi.fn().mockResolvedValue(undefined), onStreamingDone: vi.fn(),
        onDone: vi.fn(), onThread: vi.fn(), onThreadName: vi.fn(), onError: vi.fn(),
        onWarning: vi.fn(), onAgentActions: vi.fn().mockResolvedValue(undefined), onRetry: vi.fn(),
        onMissingZoteroData: vi.fn(), onDeferredApprovalRequest: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(),
    };
}

/**
 * Drive connect() far enough that the auth message is sent (open + the ~50ms
 * post-open delay), then return the parsed auth payload. The connect promise is
 * intentionally not awaited (it only resolves on `ready`).
 */
async function captureAuthMessage(service: AgentService, connectCall: () => Promise<void>): Promise<any> {
    const initial = MockWebSocket.instances.length;
    connectCall().catch(() => { /* connect resolves on ready, which we don't emit */ });
    for (let i = 0; i < 20 && MockWebSocket.instances.length === initial; i++) {
        await Promise.resolve();
    }
    const socket = MockWebSocket.instances[initial];
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

describe('AgentService auth handshake envelope', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        MockWebSocket.instances = [];
        vi.stubGlobal('WebSocket', MockWebSocket);
        mockSupabase.auth.getSession.mockReset();
        mockSupabase.auth.getSession.mockResolvedValue({
            data: { session: { access_token: 'jwt-token', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
            error: null,
        });
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

    it('legacy 2-arg call sends type+token, no client identity fields', async () => {
        const service = new AgentService('https://api.example.com');
        const auth = await captureAuthMessage(service, () =>
            service.connect({ type: 'chat' } as AgentRunRequest, createCallbacks()),
        );
        expect(auth.type).toBe('auth');
        expect(auth.token).toBe('jwt-token');
        // conditional spread: absent keys must NOT appear (backend treats absence
        // as defaults; presence of an empty/garbage value would change behavior)
        expect('client_type' in auth).toBe(false);
        expect('client_features' in auth).toBe(false);
        expect('zotero_instance' in auth).toBe(false);
    });

    it('call with frontendVersion only includes it (current Zotero plugin)', async () => {
        const service = new AgentService('https://api.example.com');
        const auth = await captureAuthMessage(service, () =>
            service.connect({ type: 'chat' } as AgentRunRequest, createCallbacks(), '0.20.3'),
        );
        expect(auth.frontend_version).toBe('0.20.3');
        expect('client_type' in auth).toBe(false);
    });

    it('fully-specified call (Lane C + instance identity) sends all handshake fields', async () => {
        const service = new AgentService('https://api.example.com');
        const instance: ZoteroInstanceWire = {
            local_user_key: '28tUI2tp',
            account_name: 'greg.hoch',
            device_name: 'Joschas-MacBook-Pro-3',
            data_dir: 'Zotero',
        };
        const auth = await captureAuthMessage(service, () =>
            service.connect(
                { type: 'chat' } as AgentRunRequest,
                createCallbacks(),
                '0.21.0',
                'zotero-plugin',
                ['note_support', 'view_page_images'],
                instance,
            ),
        );
        expect(auth.frontend_version).toBe('0.21.0');
        expect(auth.client_type).toBe('zotero-plugin');
        expect(auth.client_features).toEqual(['note_support', 'view_page_images']);
        expect(auth.zotero_instance).toEqual(instance);
    });

    it('a Word-style client reuses connect() with its own client_type', async () => {
        const service = new AgentService('https://api.example.com');
        const auth = await captureAuthMessage(service, () =>
            service.connect(
                { type: 'chat' } as AgentRunRequest,
                createCallbacks(),
                undefined,
                'word-addin',
                ['library_management'],
            ),
        );
        expect(auth.client_type).toBe('word-addin');
        expect(auth.client_features).toEqual(['library_management']);
        // no zotero_instance for a non-Zotero client
        expect('zotero_instance' in auth).toBe(false);
    });
});
