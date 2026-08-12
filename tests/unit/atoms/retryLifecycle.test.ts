import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '@beaver/agent-core/agents/types';

// =============================================================================
// Module Mocks (must be before imports of the module under test)
// =============================================================================

// agentRunAtoms transitively imports the WS transport layer. Mocking connect()
// gives the tests the callbacks the server would drive, so a retry can be run
// through its whole lifecycle without a socket.
const { connectMock, cancelMock, undoEditMetadataMock, addPopupMessageMock } = vi.hoisted(() => ({
    connectMock: vi.fn().mockResolvedValue(undefined),
    cancelMock: vi.fn().mockResolvedValue(undefined),
    undoEditMetadataMock: vi.fn().mockResolvedValue(undefined),
    addPopupMessageMock: vi.fn(),
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

/** The callbacks the mocked connect() was handed for the in-flight run. */
function wsCallbacks(): any {
    return connectMock.mock.calls[connectMock.mock.calls.length - 1][1];
}

/** The run request the mocked connect() was handed. */
function wsRequest(): any {
    return connectMock.mock.calls[connectMock.mock.calls.length - 1][0];
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
        expect(store.get(threadRunsAtom).map(r => r.id)).toEqual(['a', 'b']);
        expect(store.get(citationsAtom)).toHaveLength(2);
        expect(wsRequest().retry_run_id).toBe('a');
        expect(wsRequest().retry_keep_run_ids).toBeUndefined();

        const pending = store.get(pendingRetryAtom);
        expect(pending?.sourceRunId).toBe('a');
        expect(pending?.runIdsToRemove).toEqual(['a', 'b']);

        // The retry's own run is live but stays out of the rendered thread, so
        // the prompt is not shown twice.
        expect(store.get(activeRunAtom)?.id).toBe(pending?.runId);
        expect(store.get(allRunsAtom).map(r => r.id)).toEqual(['a', 'b']);
    });

    it('applies the truncation when the thread event confirms it', async () => {
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;

        wsCallbacks().onThread(THREAD_ID);

        expect(store.get(threadRunsAtom)).toEqual([]);
        expect(store.get(citationsAtom)).toEqual([]);
        expect(store.get(pendingRetryAtom)).toBeNull();
        expect(store.get(allRunsAtom).map(r => r.id)).toEqual([newRunId]);
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

        expect(store.get(threadRunsAtom).map(r => r.id)).toEqual(['a', 'b']);
        expect(store.get(citationsAtom)).toHaveLength(2);
        expect(store.get(pendingRetryAtom)).toBeNull();
        // The failed shell is dropped; the popup is what carries the error.
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(allRunsAtom).map(r => r.id)).toEqual(['a', 'b']);
        expect(addPopupMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'error', title: expect.stringContaining('Retry failed') }),
        );
    });

    it('leaves the thread untouched when the user cancels before that confirmation', async () => {
        await store.set(regenerateFromRunAtom, 'a');

        await store.set(closeWSConnectionAtom);

        expect(store.get(threadRunsAtom).map(r => r.id)).toEqual(['a', 'b']);
        expect(store.get(pendingRetryAtom)).toBeNull();
        expect(store.get(activeRunAtom)).toBeNull();
        // Cancel is intentional — no error popup for it.
        expect(addPopupMessageMock).not.toHaveBeenCalled();
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
        expect(store.get(threadRunsAtom).map(r => r.id)).toEqual([newRunId]);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
    });

    it('surfaces a failure after the commit on the run itself, not in a popup', async () => {
        await store.set(regenerateFromRunAtom, 'a');
        const newRunId = store.get(pendingRetryAtom)?.runId;
        wsCallbacks().onThread(THREAD_ID);

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
        expect(store.get(threadRunsAtom).map(r => r.id)).toEqual(['a', 'b']);
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
        expect(store.get(threadRunsAtom).some(r => r.id === newRunId)).toBe(false);
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
            // Deliberately left applied: a helper that resolves is not proof
            // it reverted anything, and recording `undone` would discard the
            // result data a second attempt needs. Reopening the thread
            // reconciles it against Zotero.
            expect(store.get(threadAgentActionsAtom)[0].status).toBe('applied');

            wsCallbacks().onThread(THREAD_ID);
            expect(store.get(threadAgentActionsAtom)).toEqual([]);
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
            expect(store.get(threadRunsAtom).map(r => r.id)).toEqual(['a', 'b']);
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

        it('keeps the reverted actions recoverable when the retry then fails', async () => {
            await store.set(regenerateFromRunAtom, 'a');
            const newRunId = store.get(pendingRetryAtom)?.runId;

            wsCallbacks().onError({
                event: 'error',
                type: 'internal_error',
                message: 'boom',
                run_id: newRunId,
            });

            // The user asked for the undo and got it, and the turns it belonged
            // to come back. The record stays applied and keeps its result data,
            // so a second attempt at the reversal is still possible.
            expect(store.get(threadRunsAtom).map(r => r.id)).toEqual(['a', 'b']);
            expect(store.get(threadAgentActionsAtom)[0].status).toBe('applied');
        });

        it('does not start the retry when the user cancels the dialog', async () => {
            (globalThis as any).Zotero.Prompt.confirm = vi.fn(() => 1);

            await store.set(regenerateFromRunAtom, 'a');

            expect(connectMock).not.toHaveBeenCalled();
            expect(store.get(pendingRetryAtom)).toBeNull();
            expect(store.get(threadRunsAtom).map(r => r.id)).toEqual(['a', 'b']);
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

        wsCallbacks().onThread('thread-2');

        expect(store.get(threadRunsAtom).map(r => r.id)).toEqual(['other']);
        expect(store.get(pendingRetryAtom)).toBeNull();
    });
});
