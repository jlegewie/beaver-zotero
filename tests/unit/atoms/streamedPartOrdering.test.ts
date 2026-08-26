/**
 * Ordering between streamed parts and everything else on the socket.
 *
 * Part events are buffered for an animation frame before they reach
 * `activeRunAtom` (see `streamingPartQueue`), so every other callback has to
 * apply that buffer before it reads or writes run state. A tool return, a run
 * completing, or an error that ran ahead of the buffer would archive a run
 * missing the text the reader had already watched arrive.
 *
 * The frame is never allowed to run here: anything these tests observe in the
 * run got there because a callback flushed the queue, not because time passed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSupabase } = vi.hoisted(() => ({
    mockSupabase: {
        auth: {
            getSession: vi.fn(),
            refreshSession: vi.fn(),
        },
    },
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: mockSupabase,
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemDataWithAllTypes: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

vi.mock('../../../src/services/agentDataProvider', () => ({
    handleZoteroDataRequest: vi.fn(),
    handleExternalReferenceCheckRequest: vi.fn(),
    handleZoteroDocumentRequest: vi.fn(),
    handleZoteroAttachmentPageImagesRequest: vi.fn(),
    handleZoteroAttachmentImageRequest: vi.fn(),
    handleZoteroViewImagesRequest: vi.fn(),
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


import type {
    WSPartEvent,
    WSRunCompleteEvent,
    WSToolCallProgressEvent,
} from '@beaver/agent-core/protocol/agentProtocol';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { activeRunAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { createWSCallbacks } from '../../../react/atoms/agentRunAtoms';
import { store } from '../../../react/store';

/** A window whose animation frames never run. */
const frozenWindow = {
    closed: false,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
};

function streamingRun(): AgentRun {
    return {
        id: 'run-1',
        thread_id: 'thread-1',
        status: 'in_progress',
        model_messages: [],
        user_prompt: { content: 'question', is_resume: false },
    } as unknown as AgentRun;
}

function textPart(content: string): WSPartEvent {
    return {
        event: 'part',
        run_id: 'run-1',
        message_index: 0,
        part_index: 0,
        part: { part_kind: 'text', content },
    } as unknown as WSPartEvent;
}

/** The text of the streamed response as it currently stands in the store. */
function streamedText(run: AgentRun | null): string | undefined {
    const message = run?.model_messages[0];
    if (!message || message.kind !== 'response') return undefined;
    const part = message.parts[0];
    return part?.part_kind === 'text' ? part.content : undefined;
}

describe('streamed parts and the other WebSocket callbacks', () => {
    const callbacks = createWSCallbacks(store.set);

    beforeEach(() => {
        vi.mocked(Zotero.getMainWindow).mockReturnValue(frozenWindow as unknown as Window);
        store.set(threadRunsAtom, []);
        store.set(activeRunAtom, streamingRun());
    });

    it('holds a streamed part until something flushes it', async () => {
        await callbacks.onPart(textPart('Half an ans'));

        expect(streamedText(store.get(activeRunAtom))).toBeUndefined();
    });

    it('applies queued parts before a tool call progress event', async () => {
        await callbacks.onPart(textPart('Half an ans'));

        callbacks.onToolCallProgress({
            event: 'tool_call_progress',
            run_id: 'run-1',
            tool_call_id: 'call-1',
            progress: 'searching',
        } as WSToolCallProgressEvent);

        expect(streamedText(store.get(activeRunAtom))).toBe('Half an ans');
    });

    it('completes a run with the text that streamed just before it', async () => {
        await callbacks.onPart(textPart('The whole answer.'));

        await callbacks.onRunComplete({
            event: 'run_complete',
            run_id: 'run-1',
            usage: null,
            cost: null,
            citations: null,
            agent_actions: null,
        } as WSRunCompleteEvent);

        expect(streamedText(store.get(activeRunAtom))).toBe('The whole answer.');
    });

    it('applies every queued part, in the order they arrived', async () => {
        await callbacks.onPart(textPart('The'));
        await callbacks.onPart(textPart('The whole'));
        await callbacks.onPart(textPart('The whole answer.'));

        callbacks.onToolCallProgress({
            event: 'tool_call_progress',
            run_id: 'run-1',
            tool_call_id: 'call-1',
            progress: 'searching',
        } as WSToolCallProgressEvent);

        expect(streamedText(store.get(activeRunAtom))).toBe('The whole answer.');
    });
});
