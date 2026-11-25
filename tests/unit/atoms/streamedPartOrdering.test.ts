import { setCredentialAdapter } from '@beaver/agent-core/transport/credentials';
/**
 * Ordering between streamed parts and everything else on the socket.
 *
 * The session applies each part as it arrives; the window renders streamed
 * text once per animation frame (see `runProjection`). Every other change
 * reaches the window at once, together with the text that streamed before it,
 * so a run completing, a card, or a stop never shows ahead of that text.
 *
 * The frame is never allowed to run here: anything the window shows got there
 * because an urgent change applied it, not because time passed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSupabase, processToolReturnResults } = vi.hoisted(() => ({
    processToolReturnResults: vi.fn(),
    mockSupabase: {
        auth: {
            getSession: vi.fn(),
            refreshSession: vi.fn(),
        },
    },
}));

vi.mock('../../../react/agents/toolResultProcessing', () => ({ processToolReturnResults }));

vi.mock('../../../react/runtime/windowRuntime', () => ({
    tryGetWindowRuntime: () => ({ hostWindow: frozenWindow }),
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
import { isWSReadyAtom } from '../../../react/agentRuns/runEngine';
import { abandonActiveRunLocallyAtom, createWSCallbacks } from '../../../react/atoms/agentRunAtoms';
import { store } from '../../../react/store';
import { flushRunProjection } from '../../../react/runtime/windowRunSession';
import { chatStore } from '../../helpers/runSession';

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
    let callbacks: ReturnType<typeof createWSCallbacks>;

    beforeEach(() => {
        callbacks = createWSCallbacks(chatStore().set);
        vi.mocked(Zotero.getMainWindow).mockReturnValue(frozenWindow as unknown as Window);
        chatStore().set(threadRunsAtom, []);
        chatStore().set(activeRunAtom, streamingRun());
        // A run set up from scratch is not more of the previous test's stream.
        flushRunProjection();
    });

    it('applies a part to the session at once and shows it on the next frame', async () => {
        await callbacks.onPart(textPart('Half an ans'));

        expect(streamedText(chatStore().get(activeRunAtom))).toBe('Half an ans');
        expect(streamedText(store.get(activeRunAtom))).toBeUndefined();
    });

    it('shows the streamed text together with the next change that is not streaming', async () => {
        await callbacks.onPart(textPart('Half an ans'));
        callbacks.onToolCallProgress({
            event: 'tool_call_progress',
            run_id: 'run-1',
            tool_call_id: 'call-1',
            progress: 'searching',
        } as WSToolCallProgressEvent);
        expect(streamedText(store.get(activeRunAtom))).toBeUndefined();

        callbacks.onReady?.({} as never);

        expect(store.get(isWSReadyAtom)).toBe(true);
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

    it('keeps the streamed text when the user stops the run mid-response', async () => {
        await callbacks.onPart(textPart('An answer that was cut off here'));

        // Stop: the run is archived as canceled and the slot is cleared, which
        // would leave the queued text nowhere to land.
        store.set(abandonActiveRunLocallyAtom);

        const archived = store.get(threadRunsAtom);
        expect(archived).toHaveLength(1);
        expect(archived[0].status).toBe('canceled');
        expect(streamedText(archived[0])).toBe('An answer that was cut off here');
    });

    it('keeps a tool call with no items to load when the run is stopped as it arrives', () => {
        // Not awaited: with no item data to load, the call is queued before
        // anything else can run, so the stop that follows still archives it.
        void callbacks.onPart({
            event: 'part',
            run_id: 'run-1',
            message_index: 0,
            part_index: 0,
            part: { part_kind: 'tool-call', tool_name: 'search', tool_call_id: 'call-1', args: {} },
        } as unknown as WSPartEvent);

        store.set(abandonActiveRunLocallyAtom);

        const archived = store.get(threadRunsAtom);
        expect(archived).toHaveLength(1);
        const message = archived[0].model_messages[0];
        expect(message?.kind === 'response' ? message.parts[0]?.part_kind : undefined).toBe('tool-call');
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

        expect(streamedText(chatStore().get(activeRunAtom))).toBe('The whole answer.');
    });
});


describe('WebSocket account lifetime', () => {
    afterEach(() => setCredentialAdapter(undefined));
    it('rejects a write when the account changes during an already-entered async callback', async () => {
        let generation = 1;
        setCredentialAdapter({auth: mockSupabase.auth as any, getGeneration: () => generation});
        let resume!: () => void;
        processToolReturnResults.mockImplementationOnce(async (_part, set) => {
            await new Promise<void>(resolve => { resume = resolve; });
            set(activeRunAtom, null);
        });
        const set = vi.fn();
        const callbacks = createWSCallbacks(set as any);
        const pending = callbacks.onToolReturn({run_id: 'run-1', part: {part_kind: 'tool-return'}} as any);
        generation++;
        resume();
        await expect(pending).rejects.toMatchObject({code: 'ACCOUNT_CHANGED'});
        expect(set).not.toHaveBeenCalled();
    });
    it('rejects every stale callback even if the run never emitted an error', async () => {
        let generation = 1;
        setCredentialAdapter({auth: mockSupabase.auth as any, getGeneration: () => generation});
        const set = vi.fn();
        const callbacks = createWSCallbacks(set as any);
        generation++;
        for (const callback of Object.values(callbacks)) {
            if (typeof callback === 'function') await callback({});
        }
        expect(set).not.toHaveBeenCalled();
    });
});
