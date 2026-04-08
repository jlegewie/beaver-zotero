import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    handleAgentActionExecuteRequest: vi.fn(),
    handleBatchEditNoteExecuteRequests: vi.fn(),
    handleReadNoteRequest: vi.fn(),
    handleAgentActionValidateRequest: vi.fn(),
    logger: vi.fn(),
    toAgentAction: vi.fn((action: any) => action),
}));

vi.mock('../../../src/services/agentDataProvider', () => ({
    handleZoteroDataRequest: vi.fn(),
    handleExternalReferenceCheckRequest: vi.fn(),
    handleZoteroAttachmentPagesRequest: vi.fn(),
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
    handleAgentActionValidateRequest: mocks.handleAgentActionValidateRequest,
    handleAgentActionExecuteRequest: mocks.handleAgentActionExecuteRequest,
    handleBatchEditNoteExecuteRequests: mocks.handleBatchEditNoteExecuteRequests,
    handleReadNoteRequest: mocks.handleReadNoteRequest,
}));

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: {
        auth: { getSession: vi.fn() },
    },
}));

vi.mock('../../../src/utils/getAPIBaseURL', () => ({
    default: 'http://example.test',
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: mocks.logger,
}));

vi.mock('../../../react/agents/types', () => ({
    AgentRun: class {},
}));

vi.mock('../../../react/agents/agentActions', () => ({
    AgentAction: class {},
    toAgentAction: mocks.toAgentAction,
}));

vi.mock('../../../src/services/apiService', () => ({
    ApiService: class {},
}));

import { AgentService } from '../../../src/services/agentService';
import type {
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
    WSReadNoteRequest,
} from '../../../src/services/agentProtocol';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function makeEditNoteRequest(request_id: string): WSAgentActionExecuteRequest {
    return {
        event: 'agent_action_execute',
        request_id,
        action_type: 'edit_note',
        action_data: {
            library_id: 1,
            zotero_key: 'NOTE0001',
            old_string: 'placeholder-a',
            new_string: 'filled-a',
        },
    };
}

function makeCreateNoteRequest(request_id: string): WSAgentActionExecuteRequest {
    return {
        event: 'agent_action_execute',
        request_id,
        action_type: 'create_note',
        action_data: {
            library_id: 1,
            parent_key: 'ITEM0001',
            note_html: '<p>new note</p>',
        },
    } as WSAgentActionExecuteRequest;
}

function makeReadNoteRequest(request_id: string): WSReadNoteRequest {
    return {
        event: 'read_note_request',
        request_id,
        note_id: '1-NOTE0001',
    };
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

function makeService() {
    const service = new AgentService('http://example.test');
    (service as any).callbacks = { onError: vi.fn() };
    (service as any).send = vi.fn();
    return service as any;
}

describe('AgentService edit_note ordering', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps later action_execute requests behind a buffered edit_note', async () => {
        const editResponse: WSAgentActionExecuteResponse = {
            type: 'agent_action_execute_response',
            request_id: 'edit-1',
            success: true,
        };
        const createResponse: WSAgentActionExecuteResponse = {
            type: 'agent_action_execute_response',
            request_id: 'create-1',
            success: true,
        };
        const pendingEdit = createDeferred<WSAgentActionExecuteResponse>();

        mocks.handleAgentActionExecuteRequest.mockImplementation((request: WSAgentActionExecuteRequest) => {
            if (request.request_id === 'edit-1') {
                return pendingEdit.promise;
            }
            return Promise.resolve(createResponse);
        });

        const service = makeService();

        await service.handleMessage(JSON.stringify(makeEditNoteRequest('edit-1')));
        await service.handleMessage(JSON.stringify(makeCreateNoteRequest('create-1')));
        await flushMicrotasks();

        expect(mocks.handleAgentActionExecuteRequest).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(80);

        expect(mocks.handleAgentActionExecuteRequest).toHaveBeenCalledTimes(1);
        expect(mocks.handleAgentActionExecuteRequest).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ request_id: 'edit-1' }),
        );

        pendingEdit.resolve(editResponse);
        await service.actionExecutionQueue;

        expect(mocks.handleAgentActionExecuteRequest).toHaveBeenCalledTimes(2);
        expect(mocks.handleAgentActionExecuteRequest).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ request_id: 'create-1' }),
        );
        expect(service.send.mock.calls.map(([message]: [any]) => message.request_id))
            .toEqual(['edit-1', 'create-1']);
    });

    it('keeps read_note_request behind a buffered edit_note', async () => {
        const editResponse: WSAgentActionExecuteResponse = {
            type: 'agent_action_execute_response',
            request_id: 'edit-1',
            success: true,
        };
        const pendingEdit = createDeferred<WSAgentActionExecuteResponse>();

        mocks.handleAgentActionExecuteRequest.mockImplementation((request: WSAgentActionExecuteRequest) => {
            if (request.request_id === 'edit-1') {
                return pendingEdit.promise;
            }
            return Promise.resolve(editResponse);
        });
        mocks.handleReadNoteRequest.mockResolvedValue({
            type: 'read_note',
            request_id: 'read-1',
            success: true,
            note_id: '1-NOTE0001',
            title: 'Test Note',
            total_lines: 1,
            content: 'filled-a',
            has_more: false,
            lines_returned: '1',
        });

        const service = makeService();

        await service.handleMessage(JSON.stringify(makeEditNoteRequest('edit-1')));
        await service.handleMessage(JSON.stringify(makeReadNoteRequest('read-1')));
        await flushMicrotasks();

        expect(mocks.handleReadNoteRequest).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(80);

        expect(mocks.handleAgentActionExecuteRequest).toHaveBeenCalledTimes(1);
        expect(mocks.handleReadNoteRequest).not.toHaveBeenCalled();

        pendingEdit.resolve(editResponse);
        await service.actionExecutionQueue;

        expect(mocks.handleReadNoteRequest).toHaveBeenCalledTimes(1);
        expect(mocks.handleReadNoteRequest).toHaveBeenCalledWith(
            expect.objectContaining({ request_id: 'read-1' }),
        );
        expect(service.send.mock.calls.map(([message]: [{ request_id: string }]) => message.request_id))
            .toEqual(['edit-1', 'read-1']);
    });
});
