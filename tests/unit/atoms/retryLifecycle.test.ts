import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '@beaver/agent-core/agents/types';

// =============================================================================
// Module Mocks (must be before imports of the module under test)
// =============================================================================

// agentRunAtoms transitively imports the WS transport layer. Mocking connect()
// gives the tests the callbacks the server would drive, so a retry can be run
// through its whole lifecycle without a socket.
const { connectMock, cancelMock, undoEditMetadataMock, addPopupMessageMock, updateActionMock } = vi.hoisted(() => ({
    connectMock: vi.fn().mockResolvedValue(undefined),
    cancelMock: vi.fn().mockResolvedValue(undefined),
    undoEditMetadataMock: vi.fn().mockResolvedValue({
        fieldsReverted: 1,
        alreadyReverted: [],
        manuallyModified: [],
        needsConfirmation: false,
    }),
    addPopupMessageMock: vi.fn(),
    updateActionMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentService: { connect: connectMock, close: vi.fn(), cancel: cancelMock },
    AgentConnectionError: class AgentConnectionError extends Error {},
    // Only the thread-switch test reaches this, and only to find the thread it
    // switched to empty.
    agentRunService: { getThreadRuns: vi.fn(async () => ({ runs: [], agent_actions: [] })) },
}));
vi.mock('@beaver/agent-core/transport/clientIdentity', () => ({
    resolveClientIdentity: vi.fn(() => ({
        frontendVersion: '0.0.0-test',
        clientType: 'zotero-plugin',
        clientFeatures: [],
        zoteroInstance: undefined,
    })),
}));
vi.mock('../../../react/atoms/applicationState', () => ({
    getApplicationStateProvider: vi.fn(() => async () => ({})),
}));
vi.mock('../../../src/services/systemNotifications', () => ({
    notifyRunComplete: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));
vi.mock('@beaver/agent-core/transport/clients/diagnosticsService', () => ({
    reportConnectionFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));
vi.mock('../../../src/beaver-extract', () => ({
    prewarmMuPDFWorker: vi.fn(),
}));
vi.mock('../../../react/utils/noteEditorDiffPreview', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    dismissDiffPreview: vi.fn().mockResolvedValue(undefined),
}));
// The one undo the fixture action needs; asserting on it is how the tests tell
// whether the Zotero side ran.
vi.mock('../../../react/utils/editMetadataActions', () => ({
    undoEditMetadataAction: undoEditMetadataMock,
}));
vi.mock('@beaver/agent-core/transport/clients/agentActionsService', () => ({
    agentActionsService: { updateAction: updateActionMock },
}));
vi.mock('../../../react/utils/popupMessageUtils', async () => {
    const { atom } = await import('jotai');
    return {
        addPopupMessageAtom: atom(null, (_get, _set, message: unknown) => addPopupMessageMock(message)),
        updatePopupMessageAtom: atom(null, () => {}),
    };
});
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { store } from '../../../react/store';
import {
    activeRunAtom,
    allRunsAtom,
    currentThreadIdAtom,
    threadRunsAtom,
} from '@beaver/agent-core/run-state/atoms';
import { citationsAtom } from '@beaver/agent-core/citations/atoms';
import { threadAgentActionsAtom, type AgentAction } from '../../../react/agents/agentActions';
import {
    closeWSConnectionAtom,
    isWSChatPendingAtom,
    isWSConnectedAtom,
    isWSReadyAtom,
    pendingRetryAtom,
    regenerateFromRunAtom,
    regenerateWithEditedPromptAtom,
} from '../../../react/atoms/agentRunAtoms';
import { sessionAtom } from '../../../react/atoms/auth';
import { selectedModelAtom } from '../../../react/atoms/models';

const THREAD_ID = 'thread-1';

function makeRun(id: string): AgentRun {
    return {
        id,
        user_id: 'user-1',
        thread_id: THREAD_ID,
        agent_name: 'beaver',
        user_prompt: { content: `prompt for ${id}` },
        status: 'completed',
        model_messages: [],
        created_at: new Date().toISOString(),
        consent_to_share: false,
        model_name: 'gpt-5',
    };
}

function makeAppliedMetadataAction(runId: string, id: string): AgentAction {
    return {
        id,
        run_id: runId,
        action_type: 'edit_metadata',
        status: 'applied',
        created_at: new Date().toISOString(),
    } as unknown as AgentAction;
}

/**
 * An applied note whose Zotero item the undo will look for and not find.
 * `libraryRef` absent leaves a bare, device-local `library_id`.
 */
function makeAppliedNoteAction(runId: string, id: string, libraryRef?: string): AgentAction {
    return {
        id,
        run_id: runId,
        action_type: 'zotero_note',
        status: 'applied',
        created_at: new Date().toISOString(),
        result_data: { library_id: 7, zotero_key: 'NOTEKEY1', ...(libraryRef ? { library_ref: libraryRef } : {}) },
    } as unknown as AgentAction;
}

/** The callbacks the mocked connect() was handed for the in-flight run. */
function wsCallbacks(): any {
    return connectMock.mock.calls[connectMock.mock.calls.length - 1][1];
}

/** The run request the mocked connect() was handed. */
function wsRequest(): any {
    return connectMock.mock.calls[connectMock.mock.calls.length - 1][0];
}

/**
 * The `thread` event, as the server sends it.
 *
 * `deletedRunIds` names the rows a retry's truncation actually deleted, and
 * `anchoredBy` which anchor it used — null for a retry where none ran. Leaving
 * the truncation out entirely models a backend too old to report one.
 */
function threadEvent(
    threadId: string,
    deletedRunIds?: string[],
    anchoredBy: 'keep_set' | 'retry_run_id' | null = 'retry_run_id',
): any {
    return {
        event: 'thread',
        thread_id: threadId,
        ...(deletedRunIds
            ? { retry_truncation: { deleted_run_ids: deletedRunIds, anchored_by: anchoredBy } }
            : {}),
    };
}

/** Seed a two-run thread: `a` (the retry target) and `b` behind it. */
function seedThread(): void {
    store.set(threadRunsAtom, [makeRun('a'), makeRun('b')]);
    store.set(currentThreadIdAtom, THREAD_ID);
    store.set(citationsAtom, [
        { citation_id: 'cite-a', run_id: 'a' },
        { citation_id: 'cite-b', run_id: 'b' },
    ] as any);
    store.set(threadAgentActionsAtom, []);
    store.set(activeRunAtom, null);
}

describe('retry lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockResolvedValue(undefined);
        store.set(sessionAtom, { user: { id: 'user-1' } } as any);
        store.set(selectedModelAtom, { name: 'gpt-5', provider: 'openai' } as any);
        store.set(pendingRetryAtom, null);
        store.set(isWSChatPendingAtom, false);
        seedThread();
        (globalThis as any).Zotero.Prompt = {
            BUTTON_TITLE_CANCEL: 1,
            confirm: vi.fn(() => 0),
        };
    });

    it('keeps the runs it replaces until the server confirms the truncation', async () => {
        await store.set(regenerateFromRunAtom, 'a');

        // Nothing removed yet, and both anchors describe what the server should
        // delete once it gets there.
        expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual(['a', 'b']);
        expect(store.get(citationsAtom)).toHaveLength(2);
        expect(wsRequest().retry_run_id).toBe('a');
        // Empty, and sent anyway: 'a' is the first run of the thread, so "the
        // client keeps nothing" is the only anchor the server can use if 'a'
        // was never persisted.
        expect(wsRequest().retry_keep_run_ids).toEqual([]);

        const pending = store.get(pendingRetryAtom);
        expect(pending?.sourceRunId).toBe('a');
        expect(pending?.runIdsToRemove).toEqual(['a', 'b']);

        // The retry's own run is live but stays out of the rendered thread, so
        // the prompt is not shown twice.
        expect(store.get(activeRunAtom)?.id).toBe(pending?.runId);
        expect(store.get(allRunsAtom).map((r: AgentRun) => r.id)).toEqual(['a', 'b']);
    });

    it('applies the truncation when the thread event confirms it', async () => {
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;

        wsCallbacks().onThread(THREAD_ID, threadEvent(THREAD_ID, ['a', 'b']));

        expect(store.get(threadRunsAtom)).toEqual([]);
        expect(store.get(citationsAtom)).toEqual([]);
        expect(store.get(pendingRetryAtom)).toBeNull();
        expect(store.get(allRunsAtom).map((r: AgentRun) => r.id)).toEqual([newRunId]);
    });

    it('takes the server truncation as it comes, including runs it never held', async () => {
        // Both truncation paths delete a trailing block at or after the retry
        // point, so the extra ids are runs this client never loaded — one
        // another client wrote to the same thread. Nothing local answers to
        // them, and the ones that do are still removed.
        await store.set(regenerateFromRunAtom, 'a');

        wsCallbacks().onThread(THREAD_ID, threadEvent(THREAD_ID, ['a', 'b', 'written-elsewhere']));

        expect(store.get(threadRunsAtom)).toEqual([]);
        expect(store.get(citationsAtom)).toEqual([]);
    });

    it('removes a planned run the server had no row to delete for', async () => {
        // 'b' never reached the database — the request that started it died
        // before the run row was written — so an anchored truncation deletes
        // 'a' alone and reports only that. The turn is still replaced.
        await store.set(regenerateFromRunAtom, 'a');
        expect(store.get(pendingRetryAtom)?.runIdsToRemove).toEqual(['a', 'b']);

        wsCallbacks().onThread(THREAD_ID, threadEvent(THREAD_ID, ['a'], 'keep_set'));

        expect(store.get(threadRunsAtom)).toEqual([]);
        expect(store.get(citationsAtom)).toEqual([]);
    });

    it('removes the planned tail when an anchored truncation had nothing to delete', async () => {
        // The server's thread already ended at the run the client keeps, so
        // every turn the retry replaces was a local-only one. Anchoring is what
        // makes that "already truncated", not "never truncated".
        await store.set(regenerateFromRunAtom, 'a');

        wsCallbacks().onThread(THREAD_ID, threadEvent(THREAD_ID, [], 'keep_set'));

        expect(store.get(threadRunsAtom)).toEqual([]);
        expect(store.get(pendingRetryAtom)).toBeNull();
    });

    it('removes the run a truncation anchored on but found nothing to delete', async () => {
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;

        // The run-id anchor found no run to delete from — 'a' was never
        // persisted — and there was no keep set to fall back on. Its prompt is
        // not in the history the replacement run was given, so showing it would
        // repeat the prompt on screen.
        wsCallbacks().onThread(THREAD_ID, threadEvent(THREAD_ID, [], 'retry_run_id'));

        // 'b' is a different matter: the server said nothing about it, and it
        // may well still be in the thread it is answering from.
        expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual(['b']);
        expect(store.get(citationsAtom).map((c: any) => c.citation_id)).toEqual(['cite-b']);
        expect(store.get(pendingRetryAtom)).toBeNull();
        expect(store.get(allRunsAtom).map((r: AgentRun) => r.id)).toEqual(['b', newRunId]);
    });

    it('drops the whole plan when the server ran the retry in a thread of its own', async () => {
        // Stopping the first run of a thread before its `thread` event arrives
        // leaves the client with no thread id to send, so the server has no
        // thread to truncate and creates one. Nothing the client holds is in
        // it — keeping the plan is what showed the same prompt twice.
        store.set(threadRunsAtom, [{ ...makeRun('a'), thread_id: null as any, status: 'error' }]);
        store.set(currentThreadIdAtom, null);
        store.set(citationsAtom, []);

        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;
        expect(store.get(pendingRetryAtom)?.threadId).toBeNull();
        expect(wsRequest().thread_id).toBeNull();

        wsCallbacks().onThread('server-made-thread', threadEvent('server-made-thread', [], null));

        expect(store.get(threadRunsAtom)).toEqual([]);
        expect(store.get(allRunsAtom).map((r: AgentRun) => r.id)).toEqual([newRunId]);
    });

    it('falls back to its own plan when the server reports no truncation', async () => {
        await store.set(regenerateFromRunAtom, 'a');

        // A backend too old to report one. Nothing has changed for it.
        wsCallbacks().onThread(THREAD_ID, threadEvent(THREAD_ID));

        expect(store.get(threadRunsAtom)).toEqual([]);
        expect(store.get(citationsAtom)).toEqual([]);
        expect(store.get(pendingRetryAtom)).toBeNull();
    });

    it('leaves the thread untouched when the run fails before that confirmation', async () => {
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;

        wsCallbacks().onError({
            event: 'error',
            type: 'usage_limit_exceeded',
            message: 'no credits',
            run_id: newRunId,
        });

        expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual(['a', 'b']);
        expect(store.get(citationsAtom)).toHaveLength(2);
        expect(store.get(pendingRetryAtom)).toBeNull();
        // The failed shell is dropped; the popup is what carries the error.
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(allRunsAtom).map((r: AgentRun) => r.id)).toEqual(['a', 'b']);
        expect(addPopupMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'error',
                title: expect.stringContaining('Retry failed'),
                text: expect.not.stringContaining('already undone'),
            }),
        );
    });

    it('leaves the thread untouched when the user cancels before that confirmation', async () => {
        await store.set(regenerateFromRunAtom, 'a');

        await store.set(closeWSConnectionAtom);

        expect(cancelMock).toHaveBeenCalledTimes(1);
        expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual(['a', 'b']);
        expect(store.get(pendingRetryAtom)).toBeNull();
        expect(store.get(activeRunAtom)).toBeNull();
        // Cancel is intentional — no error popup for it.
        expect(addPopupMessageMock).not.toHaveBeenCalled();
    });

    it('still tears down the stopped run when cancel rejects', async () => {
        await store.set(regenerateFromRunAtom, 'a');

        cancelMock.mockRejectedValueOnce(new Error('InvalidStateError'));

        await store.set(closeWSConnectionAtom);

        expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual(['a', 'b']);
        expect(store.get(pendingRetryAtom)).toBeNull();
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(isWSConnectedAtom)).toBe(false);
        expect(store.get(isWSReadyAtom)).toBe(false);
        expect(addPopupMessageMock).not.toHaveBeenCalled();
    });

    it('applies a truncation that lands while cancel is flushing, then marks the new run canceled', async () => {
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;

        cancelMock.mockImplementationOnce(async () => {
            wsCallbacks().onThread(THREAD_ID, threadEvent(THREAD_ID, ['a', 'b']));
        });

        await store.set(closeWSConnectionAtom);

        expect(store.get(pendingRetryAtom)).toBeNull();
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual([newRunId]);
        expect(store.get(threadRunsAtom)[0].status).toBe('canceled');
        expect(addPopupMessageMock).not.toHaveBeenCalled();
    });

    it('does not pop a retry-failed error when the backend errors during cancel', async () => {
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;

        cancelMock.mockImplementationOnce(async () => {
            wsCallbacks().onError({
                event: 'error',
                type: 'internal_error',
                message: 'boom',
                run_id: newRunId,
            });
        });

        await store.set(closeWSConnectionAtom);

        expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual(['a', 'b']);
        expect(store.get(pendingRetryAtom)).toBeNull();
        expect(store.get(activeRunAtom)).toBeNull();
        expect(addPopupMessageMock).not.toHaveBeenCalled();
    });

    it('does not auto-resume a run the user is stopping', async () => {
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;
        wsCallbacks().onThread(THREAD_ID, threadEvent(THREAD_ID, ['a', 'b']));
        const connectCount = connectMock.mock.calls.length;

        cancelMock.mockImplementationOnce(async () => {
            wsCallbacks().onError({
                event: 'error',
                type: 'internal_error',
                message: 'boom',
                run_id: newRunId,
                try_auto_resume: true,
            });
        });

        await store.set(closeWSConnectionAtom);

        expect(connectMock.mock.calls.length).toBe(connectCount);
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual([newRunId]);
        expect(store.get(threadRunsAtom)[0].status).toBe('canceled');
        expect(addPopupMessageMock).not.toHaveBeenCalled();
    });

    it('does not auto-resume a run while switching threads', async () => {
        const { loadThreadAtom } = await import('../../../react/atoms/threads');
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;
        wsCallbacks().onThread(THREAD_ID, threadEvent(THREAD_ID, ['a', 'b']));
        const connectCount = connectMock.mock.calls.length;

        cancelMock.mockImplementationOnce(async () => {
            wsCallbacks().onError({
                event: 'error',
                type: 'internal_error',
                message: 'boom',
                run_id: newRunId,
                try_auto_resume: true,
            });
        });

        await store.set(loadThreadAtom, { user_id: 'user-1', threadId: 'thread-2' });

        expect(connectMock.mock.calls.length).toBe(connectCount);
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(threadRunsAtom).some((r: AgentRun) => r.id === newRunId)).toBe(false);
    });

    it('does not cancel a newer run that started during the cancel flush', async () => {
        await store.set(regenerateFromRunAtom, 'a');

        cancelMock.mockImplementationOnce(async () => {
            store.set(activeRunAtom, { ...makeRun('newer'), status: 'in_progress' });
            store.set(pendingRetryAtom, null);
            store.set(isWSConnectedAtom, true);
            store.set(isWSReadyAtom, true);
        });

        await store.set(closeWSConnectionAtom);

        expect(store.get(activeRunAtom)?.id).toBe('newer');
        expect(store.get(activeRunAtom)?.status).toBe('in_progress');
        expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual(['a', 'b']);
        expect(store.get(isWSConnectedAtom)).toBe(true);
        expect(store.get(isWSReadyAtom)).toBe(true);
    });

    it('does not cancel a newer run when cancel rejects after that run started', async () => {
        await store.set(regenerateFromRunAtom, 'a');

        cancelMock.mockImplementationOnce(async () => {
            store.set(activeRunAtom, { ...makeRun('newer'), status: 'in_progress' });
            store.set(pendingRetryAtom, null);
            store.set(isWSConnectedAtom, true);
            store.set(isWSReadyAtom, true);
            throw new Error('InvalidStateError');
        });

        await store.set(closeWSConnectionAtom);

        expect(store.get(activeRunAtom)?.id).toBe('newer');
        expect(store.get(activeRunAtom)?.status).toBe('in_progress');
        expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual(['a', 'b']);
        expect(store.get(isWSConnectedAtom)).toBe(true);
        expect(store.get(isWSReadyAtom)).toBe(true);
    });

    it('applies the truncation on streamed content when no thread event arrived', async () => {
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;

        await wsCallbacks().onPart({
            run_id: newRunId,
            message_index: 0,
            part: { part_kind: 'text', content: 'hello' },
        });

        expect(store.get(threadRunsAtom)).toEqual([]);
        expect(store.get(pendingRetryAtom)).toBeNull();
    });

    it('applies the truncation when the run completes without a thread event', async () => {
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;

        await wsCallbacks().onRunComplete({ run_id: newRunId });

        expect(store.get(threadRunsAtom)).toEqual([]);
        expect(store.get(pendingRetryAtom)).toBeNull();
    });

    it('applies the truncation on done when nothing else did', async () => {
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;

        wsCallbacks().onDone();

        expect(store.get(pendingRetryAtom)).toBeNull();
        // The completed run took the place of the runs it replaced.
        expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual([newRunId]);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
    });

    it('surfaces a failure after the commit on the run itself, not in a popup', async () => {
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;
        wsCallbacks().onThread(THREAD_ID, threadEvent(THREAD_ID, ['a', 'b']));

        wsCallbacks().onError({
            event: 'error',
            type: 'internal_error',
            message: 'boom',
            run_id: newRunId,
        });

        // The truncation is the server's now, so the error belongs to the run
        // that is on screen — with its retry and resume actions.
        expect(store.get(activeRunAtom)?.status).toBe('error');
        expect(addPopupMessageMock).not.toHaveBeenCalled();
        expect(store.get(isWSChatPendingAtom)).toBe(false);
    });

    it('reports only the first terminal event for a run', async () => {
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;
        const errorEvent = {
            event: 'error',
            type: 'internal_error',
            message: 'boom',
            run_id: newRunId,
        };

        wsCallbacks().onError(errorEvent);
        wsCallbacks().onError(errorEvent);

        expect(addPopupMessageMock).toHaveBeenCalledTimes(1);
        expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual(['a', 'b']);
    });

    it('drops the plan when the user switches threads mid-flight', async () => {
        const { loadThreadAtom } = await import('../../../react/atoms/threads');
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;

        await store.set(loadThreadAtom, { user_id: 'user-1', threadId: 'thread-2' });

        expect(store.get(pendingRetryAtom)).toBeNull();
        expect(store.get(activeRunAtom)).toBeNull();
        // The retry's run was never shown, so the thread switch does not leave
        // it behind as a canceled turn.
        expect(store.get(threadRunsAtom).some((r: AgentRun) => r.id === newRunId)).toBe(false);
    });

    it('still switches threads when cancel rejects', async () => {
        const { loadThreadAtom } = await import('../../../react/atoms/threads');
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;

        cancelMock.mockRejectedValueOnce(new Error('InvalidStateError'));

        await store.set(loadThreadAtom, { user_id: 'user-1', threadId: 'thread-2' });

        expect(store.get(pendingRetryAtom)).toBeNull();
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(currentThreadIdAtom)).toBe('thread-2');
        expect(store.get(threadRunsAtom).some((r: AgentRun) => r.id === newRunId)).toBe(false);
    });

    it('does not carry a retry that committed during cancel onto the thread being opened', async () => {
        const { loadThreadAtom } = await import('../../../react/atoms/threads');
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;

        cancelMock.mockImplementationOnce(async () => {
            wsCallbacks().onThread(THREAD_ID, threadEvent(THREAD_ID, ['a', 'b']));
        });

        await store.set(loadThreadAtom, { user_id: 'user-1', threadId: 'thread-2' });

        expect(store.get(pendingRetryAtom)).toBeNull();
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(threadRunsAtom).some((r: AgentRun) => r.id === newRunId)).toBe(false);
    });

    describe('applied Zotero changes', () => {
        beforeEach(() => {
            store.set(threadAgentActionsAtom, [makeAppliedMetadataAction('b', 'action-1')]);
        });

        it('reverts them before the request goes out', async () => {
            await store.set(regenerateFromRunAtom, 'a');

            expect(undoEditMetadataMock).toHaveBeenCalledTimes(1);
            // Reverted before the request, so an interrupted undo still has the
            // server-side records to resume from.
            expect(undoEditMetadataMock.mock.invocationCallOrder[0])
                .toBeLessThan(connectMock.mock.invocationCallOrder[0]);
            // Card and backend follow the library: the undo completed, so the
            // action is undone while the old turn is still on screen.
            expect(store.get(threadAgentActionsAtom)[0].status).toBe('undone');
            expect(updateActionMock).toHaveBeenCalledWith(
                'action-1',
                expect.objectContaining({ status: 'undone', clear_result_data: true }),
            );

            wsCallbacks().onThread(THREAD_ID, threadEvent(THREAD_ID, ['a', 'b']));
            expect(store.get(threadAgentActionsAtom)).toEqual([]);
        });

        it('does not mark a skipped library undo as undone', async () => {
            undoEditMetadataMock.mockResolvedValueOnce({
                fieldsReverted: 0,
                alreadyReverted: [],
                manuallyModified: [],
                needsConfirmation: false,
                unverifiable: true,
            });
            // 'Undo & Retry', then Cancel at the "retry anyway?" prompt.
            (globalThis as any).Zotero.Prompt.confirm = vi.fn()
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(1);

            await store.set(regenerateFromRunAtom, 'a');

            expect(connectMock).not.toHaveBeenCalled();
            expect(store.get(threadAgentActionsAtom)[0].status).toBe('applied');
            expect(updateActionMock).not.toHaveBeenCalled();
        });

        it('does not mark a partial field revert as undone', async () => {
            // Fields the user edited after the apply are deliberately kept, so
            // the value the agent wrote may still be on the item. Calling that
            // undone would discard the snapshot needed to finish the job.
            undoEditMetadataMock.mockResolvedValueOnce({
                fieldsReverted: 1,
                alreadyReverted: [],
                manuallyModified: ['publisher'],
                needsConfirmation: true,
            });
            // 'Undo & Retry', then Cancel at the "retry anyway?" prompt.
            (globalThis as any).Zotero.Prompt.confirm = vi.fn()
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(1);

            await store.set(regenerateFromRunAtom, 'a');

            expect(connectMock).not.toHaveBeenCalled();
            expect(store.get(threadAgentActionsAtom)[0].status).toBe('applied');
            expect(updateActionMock).not.toHaveBeenCalled();
        });

        it('does not mark a field revert that could not read or write as undone', async () => {
            undoEditMetadataMock.mockResolvedValueOnce({
                fieldsReverted: 0,
                alreadyReverted: [],
                manuallyModified: [],
                needsConfirmation: false,
                failed: ['publisher'],
            });
            // 'Undo & Retry', then Cancel at the "retry anyway?" prompt.
            (globalThis as any).Zotero.Prompt.confirm = vi.fn()
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(1);

            await store.set(regenerateFromRunAtom, 'a');

            expect(connectMock).not.toHaveBeenCalled();
            expect(store.get(threadAgentActionsAtom)[0].status).toBe('applied');
            expect(updateActionMock).not.toHaveBeenCalled();
        });

        it('leaves an approval gate out of the changes it warns about', async () => {
            // confirm_extraction records a decision, not a library change, so
            // it must not be counted among the undos that could not be
            // confirmed. The metadata action alongside it is what carries the
            // run past the "anything to undo at all?" check.
            store.set(threadAgentActionsAtom, [
                makeAppliedMetadataAction('b', 'action-1'),
                {
                    id: 'action-2',
                    run_id: 'b',
                    action_type: 'confirm_extraction',
                    status: 'applied',
                    created_at: new Date().toISOString(),
                } as unknown as AgentAction,
            ]);

            await store.set(regenerateFromRunAtom, 'a');

            // One confirm prompt for the metadata change, and no second one
            // asking about undos that could not be confirmed.
            expect((globalThis as any).Zotero.Prompt.confirm).toHaveBeenCalledTimes(1);
            expect(connectMock).toHaveBeenCalled();
            expect(store.get(threadAgentActionsAtom)[0].status).toBe('undone');
            expect(store.get(threadAgentActionsAtom)[1].status).toBe('applied');
        });

        describe('an item the undo cannot find', () => {
            let originalItems: any;
            let originalLibraries: any;

            beforeEach(() => {
                originalItems = (globalThis as any).Zotero.Items;
                originalLibraries = (globalThis as any).Zotero.Libraries;
                (globalThis as any).Zotero.Libraries = {
                    ...originalLibraries,
                    userLibraryID: 1,
                };
                (globalThis as any).Zotero.Items = {
                    ...originalItems,
                    getByLibraryAndKeyAsync: vi.fn(async () => null),
                };
            });

            afterEach(() => {
                (globalThis as any).Zotero.Items = originalItems;
                (globalThis as any).Zotero.Libraries = originalLibraries;
            });

            it('counts a miss through a device-local library id as unconfirmed', async () => {
                // A bare group library_id is numbered per device, so the miss may
                // just mean that id names a different group here — no proof the
                // note was deleted, and no grounds to call the action undone.
                store.set(threadAgentActionsAtom, [makeAppliedNoteAction('b', 'action-1')]);
                (globalThis as any).Zotero.Prompt.confirm = vi.fn()
                    .mockReturnValueOnce(0)
                    .mockReturnValueOnce(1);

                await store.set(regenerateFromRunAtom, 'a');

                expect(connectMock).not.toHaveBeenCalled();
                expect(store.get(threadAgentActionsAtom)[0].status).toBe('applied');
                expect(updateActionMock).not.toHaveBeenCalled();
            });

            it('treats a miss on a portable reference as already reverted', async () => {
                // `u` names the personal library, whose id is the same on every
                // device, so the item really is gone.
                store.set(threadAgentActionsAtom, [makeAppliedNoteAction('b', 'action-1', 'u')]);

                await store.set(regenerateFromRunAtom, 'a');

                expect(connectMock).toHaveBeenCalled();
                expect(store.get(threadAgentActionsAtom)[0].status).toBe('undone');
            });
        });

        it('puts an undo it could not record to the user before replacing the turn', async () => {
            // The Zotero undo landed but its status did not reach the backend —
            // the case where both requests fail for the same reason. Retrying
            // would delete the turn and leave the server's `applied` row to come
            // back on the next thread load, so the user gets the choice.
            updateActionMock.mockRejectedValueOnce(new Error('offline'));
            // 'Undo & Retry', then Cancel at the "retry anyway?" prompt.
            (globalThis as any).Zotero.Prompt.confirm = vi.fn()
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(1);

            await store.set(regenerateFromRunAtom, 'a');

            expect((globalThis as any).Zotero.Prompt.confirm).toHaveBeenCalledTimes(2);
            expect(connectMock).not.toHaveBeenCalled();
            expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual(['a', 'b']);
            // The library really was reverted, so the card says so either way.
            expect(store.get(threadAgentActionsAtom)[0].status).toBe('undone');
            // The change was undone; only the record of it was not. The prompt
            // must not say it may still be in their library, or offer to
            // discard a record of something there is nothing left to undo.
            expect((globalThis as any).Zotero.Prompt.confirm).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    title: 'Some undone changes were not saved',
                    text: expect.stringContaining('could not save that to your account'),
                }),
            );
            const { text } = (globalThis as any).Zotero.Prompt.confirm.mock.lastCall[0];
            expect(text).not.toContain('may still be in your library');
            expect(text).not.toContain('only you can undo them');
        });

        it('warns about the library when the undo itself is unconfirmed', async () => {
            undoEditMetadataMock.mockResolvedValueOnce({
                fieldsReverted: 0,
                alreadyReverted: [],
                manuallyModified: [],
                needsConfirmation: false,
                unverifiable: true,
            });
            (globalThis as any).Zotero.Prompt.confirm = vi.fn()
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(1);

            await store.set(regenerateFromRunAtom, 'a');

            expect((globalThis as any).Zotero.Prompt.confirm).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    title: 'Some changes could not be undone',
                    text: expect.stringContaining('may still be in your library'),
                }),
            );
        });

        it('does not retry behind the user when a revert fails outright', async () => {
            undoEditMetadataMock.mockRejectedValueOnce(new Error('item is gone'));
            // 'Undo & Retry', then Cancel at the "retry anyway?" prompt.
            (globalThis as any).Zotero.Prompt.confirm = vi.fn()
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(1);

            await store.set(regenerateFromRunAtom, 'a');

            // Retrying would delete the only record of how to finish the undo,
            // so the thread is left exactly as it is for the user to act on.
            expect(connectMock).not.toHaveBeenCalled();
            expect(store.get(pendingRetryAtom)).toBeNull();
            expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual(['a', 'b']);
            expect(store.get(threadAgentActionsAtom)[0].status).toBe('applied');
        });

        it('retries after a failed revert when the user says so', async () => {
            undoEditMetadataMock.mockRejectedValueOnce(new Error('item is gone'));
            // 'Undo & Retry', then 'Retry Anyway'.
            (globalThis as any).Zotero.Prompt.confirm = vi.fn()
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(0);

            await store.set(regenerateFromRunAtom, 'a');

            expect(connectMock).toHaveBeenCalledTimes(1);
            expect(store.get(pendingRetryAtom)?.runIdsToRemove).toEqual(['a', 'b']);
        });

        it('tells the user about a revert that only got part way', async () => {
            // One field went back and one was left as the user had it, so the
            // action stays applied — but their library did change, and the
            // failure popup is where they hear about it.
            undoEditMetadataMock.mockResolvedValueOnce({
                fieldsReverted: 1,
                alreadyReverted: [],
                manuallyModified: ['publisher'],
                needsConfirmation: true,
            });
            // 'Undo & Retry', then 'Retry Anyway'.
            (globalThis as any).Zotero.Prompt.confirm = vi.fn()
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(0);

            await store.set(regenerateFromRunAtom, 'a');
            const newRunId = store.get(pendingRetryAtom)?.runId;

            wsCallbacks().onError({
                event: 'error',
                type: 'internal_error',
                message: 'boom',
                run_id: newRunId,
            });

            expect(store.get(threadAgentActionsAtom)[0].status).toBe('applied');
            expect(addPopupMessageMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: expect.stringContaining('Some of the changes'),
                }),
            );
        });

        it('keeps the reverted actions recoverable when the retry then fails', async () => {
            await store.set(regenerateFromRunAtom, 'a');
            const newRunId = store.get(pendingRetryAtom)?.runId;

            wsCallbacks().onError({
                event: 'error',
                type: 'internal_error',
                message: 'boom',
                run_id: newRunId,
            });

            // The user asked for the undo and got it. The turns come back with
            // their cards showing `undone`, matching the library.
            expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual(['a', 'b']);
            expect(store.get(threadAgentActionsAtom)[0].status).toBe('undone');
            expect(addPopupMessageMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: expect.stringContaining('already undone'),
                }),
            );
        });

        it('does not start the retry when the user cancels the dialog', async () => {
            (globalThis as any).Zotero.Prompt.confirm = vi.fn(() => 1);

            await store.set(regenerateFromRunAtom, 'a');

            expect(connectMock).not.toHaveBeenCalled();
            expect(store.get(pendingRetryAtom)).toBeNull();
            expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual(['a', 'b']);
        });

        it('keeps them when the user chooses to retry without undoing', async () => {
            (globalThis as any).Zotero.Prompt.confirm = vi.fn(() => 2);

            await store.set(regenerateFromRunAtom, 'a');

            expect(undoEditMetadataMock).not.toHaveBeenCalled();
            expect(store.get(threadAgentActionsAtom)[0].status).toBe('applied');
        });
    });

    it('sends the edited prompt and keeps the original message until confirmed', async () => {
        await store.set(regenerateWithEditedPromptAtom, {
            runId: 'a',
            editedPrompt: { content: 'edited prompt' },
        });

        expect(wsRequest().user_prompt.content).toBe('edited prompt');
        expect(wsRequest().retry_run_id).toBe('a');
        // The message the user edited is still on screen, carrying its original
        // text, so a failed retry leaves them exactly where they started.
        expect(store.get(threadRunsAtom)[0].user_prompt.content).toBe('prompt for a');
    });

    describe('retrying a run that is not in the thread yet', () => {
        it('cancels the run in flight and starts over without a pending truncation', async () => {
            store.set(threadRunsAtom, []);
            store.set(activeRunAtom, { ...makeRun('live'), status: 'in_progress' });

            await store.set(regenerateFromRunAtom, 'live');

            expect(cancelMock).toHaveBeenCalledTimes(1);
            // Nothing to keep on screen, so the new run is shown straight away
            // and an error would land on it as an in-chat card, not a popup.
            expect(store.get(pendingRetryAtom)).toBeNull();
            expect(store.get(allRunsAtom)).toHaveLength(1);
        });

        it('auto-retries a failed run without cancelling or prompting', async () => {
            const { autoRetryErroredRunAtom } = await import('../../../react/atoms/agentRunAtoms');
            store.set(threadRunsAtom, []);
            store.set(activeRunAtom, { ...makeRun('failed'), status: 'error' });
            store.set(threadAgentActionsAtom, [makeAppliedMetadataAction('failed', 'action-1')]);

            await store.set(autoRetryErroredRunAtom, 'failed');

            expect(connectMock).toHaveBeenCalledTimes(1);
            // A failed run has nothing to cancel, and auto-retry never asks
            // about — or reverts — the Zotero changes of what it replaces.
            expect(cancelMock).not.toHaveBeenCalled();
            expect((globalThis as any).Zotero.Prompt.confirm).not.toHaveBeenCalled();
            expect(undoEditMetadataMock).not.toHaveBeenCalled();
        });
    });

    it('does not truncate into another thread the user switched to', async () => {
        await store.set(regenerateFromRunAtom, 'a');

        // Switching threads replaces the runs; the plan must not be applied to
        // whatever is on screen now.
        store.set(currentThreadIdAtom, 'thread-2');
        store.set(threadRunsAtom, [makeRun('other')]);

        wsCallbacks().onThread('thread-2', threadEvent('thread-2', ['a', 'b']));

        expect(store.get(threadRunsAtom).map((r: AgentRun) => r.id)).toEqual(['other']);
        expect(store.get(pendingRetryAtom)).toBeNull();
    });
});
