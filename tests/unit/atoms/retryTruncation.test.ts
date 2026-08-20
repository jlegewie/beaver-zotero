/**
 * A retry commits its removal on the backend before anything local changes:
 * confirm dialog (consent) → POST /truncate (commit) → undo → local removal →
 * send. Until the POST succeeds nothing moves on either side, so a failure is
 * a popup over an intact thread and a refusal ("continued elsewhere") reloads
 * the thread instead of destroying it.
 *
 * Every retry surface — the run-footer retry button, the error-card retry,
 * edit-and-retry, and auto-retry — goes through the same code
 * (`startRegenerateRun` / `startAutoRetryRun` + `truncateThreadOnServer`), so
 * these tests drive the public atoms of each surface.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectMock, truncateMock, loadThreadRunsMock, undoEditMetadataMock } = vi.hoisted(() => ({
    connectMock: vi.fn().mockResolvedValue(undefined),
    truncateMock: vi.fn(),
    loadThreadRunsMock: vi.fn(),
    undoEditMetadataMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentService: { connect: connectMock, close: vi.fn(), cancel: vi.fn() },
    AgentConnectionError: class AgentConnectionError extends Error {},
}));
vi.mock('@beaver/agent-core/transport/threadService', () => ({
    threadService: {
        truncateThread: truncateMock,
        getThread: vi.fn().mockResolvedValue({ id: 'thread-1', name: 'Test thread' }),
    },
}));
vi.mock('@beaver/agent-core/run-state/loadThreadRuns', () => ({
    loadThreadRuns: loadThreadRunsMock,
}));
vi.mock('../../../react/utils/editMetadataActions', () => ({
    undoEditMetadataAction: undoEditMetadataMock,
}));
vi.mock('@beaver/agent-core/transport/clientIdentity', () => ({
    resolveClientIdentity: vi.fn(() => ({
        frontendVersion: '0.0.0-test',
        clientType: 'zotero-plugin',
        clientFeatures: [],
        zoteroInstance: {},
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
    reportConnectionFailure: vi.fn(),
}));
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));
vi.mock('../../../src/beaver-extract', () => ({ prewarmMuPDFWorker: vi.fn() }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import type { AgentRun } from '@beaver/agent-core/agents/types';
import { store } from '../../../react/store';
import {
    activeRunAtom,
    currentThreadIdAtom,
    threadRunsAtom,
} from '@beaver/agent-core/run-state/atoms';
import { citationsAtom } from '@beaver/agent-core/citations/atoms';
import { threadAgentActionsAtom } from '../../../react/agents/agentActions';
import { popupMessagesAtom } from '../../../react/atoms/ui';
import {
    autoRetryErroredRunAtom,
    isWSChatPendingAtom,
    regenerateFromRunAtom,
    regenerateWithEditedPromptAtom,
    resumeFromRunAtom,
    retryPendingRunIdAtom,
    sendWSMessageAtom,
    wsErrorAtom,
} from '../../../react/atoms/agentRunAtoms';
import { selectedModelAtom } from '../../../react/atoms/models';
import { sessionAtom } from '../../../react/atoms/auth';
import { ApiError, ServerError } from '@beaver/agent-core/types/apiErrors';

function makeRun(id: string, overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        id,
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: `prompt for ${id}` },
        status: 'completed',
        model_messages: [],
        created_at: new Date().toISOString(),
        consent_to_share: false,
        model_name: 'test-model',
        ...overrides,
    } as AgentRun;
}

function makeAppliedMetadataEdit(id: string, runId: string) {
    return {
        id,
        run_id: runId,
        action_type: 'edit_metadata',
        status: 'applied',
        created_at: new Date().toISOString(),
    } as any;
}

/** A successful truncation report naming exactly the given runs. */
function okReport(deletedRunIds: string[]) {
    return { deleted_run_ids: deletedRunIds, refused_run_ids: [], reason: null };
}

function refusedReport(
    refusedRunIds: string[],
    reason: 'not_a_suffix' | 'tail_mismatch' = 'not_a_suffix',
) {
    return { deleted_run_ids: [], refused_run_ids: refusedRunIds, reason };
}

/** The request handed to the transport by the most recent send. */
function sentRequest(): any {
    expect(connectMock).toHaveBeenCalled();
    return connectMock.mock.calls[connectMock.mock.calls.length - 1][0];
}

function threadRunIds(): string[] {
    return store.get(threadRunsAtom).map((run: AgentRun) => run.id);
}

const promptConfirmMock = vi.fn();

describe('retry via synchronous truncation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockResolvedValue(undefined);
        truncateMock.mockResolvedValue(okReport([]));
        loadThreadRunsMock.mockResolvedValue({ runs: [], citations: [], agentActions: [] });
        undoEditMetadataMock.mockResolvedValue(undefined);
        // 'Undo && Retry' = 0, cancel = 1, 'Retry' (skip undo) = 2.
        promptConfirmMock.mockReturnValue(2);
        (globalThis as any).Zotero.Prompt = {
            confirm: promptConfirmMock,
            BUTTON_TITLE_CANCEL: 'Cancel',
        };

        store.set(sessionAtom, { user: { id: 'user-1' } } as any);
        store.set(selectedModelAtom, { name: 'test-model', provider: 'test' } as any);
        // The store is a module singleton, so a send left pending by the
        // previous test would silently block the next one.
        store.set(isWSChatPendingAtom, false);
        store.set(wsErrorAtom, null);
        store.set(currentThreadIdAtom, 'thread-1');
        store.set(activeRunAtom, null);
        store.set(threadRunsAtom, []);
        store.set(threadAgentActionsAtom, []);
        store.set(citationsAtom, []);
        store.set(popupMessagesAtom, []);
        store.set(retryPendingRunIdAtom, null);
    });

    it('cancel in the confirm dialog aborts with no POST and no local change', async () => {
        store.set(threadRunsAtom, [makeRun('a'), makeRun('b')]);
        store.set(threadAgentActionsAtom, [makeAppliedMetadataEdit('act-1', 'b')]);
        promptConfirmMock.mockReturnValue(1); // cancel

        await store.set(regenerateFromRunAtom, 'b');

        expect(promptConfirmMock).toHaveBeenCalled();
        expect(truncateMock).not.toHaveBeenCalled();
        expect(connectMock).not.toHaveBeenCalled();
        expect(threadRunIds()).toEqual(['a', 'b']);
        expect(store.get(threadAgentActionsAtom)).toHaveLength(1);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
    });

    it('a failed POST is a popup over an intact thread', async () => {
        store.set(threadRunsAtom, [makeRun('a'), makeRun('b'), makeRun('c')]);
        store.set(citationsAtom, [{ run_id: 'c' } as any]);
        truncateMock.mockRejectedValue(new Error('network down'));

        await store.set(regenerateFromRunAtom, 'b');

        expect(truncateMock).toHaveBeenCalledWith('thread-1', ['b', 'c'], 'a');
        expect(connectMock).not.toHaveBeenCalled();
        // Nothing moved: runs, citations, and the loading flags are untouched.
        expect(threadRunIds()).toEqual(['a', 'b', 'c']);
        expect(store.get(citationsAtom)).toHaveLength(1);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
        expect(store.get(retryPendingRunIdAtom)).toBeNull();
        expect(store.get(popupMessagesAtom).some(m => m.title === 'Retry failed')).toBe(true);
    });

    it('shows the retry loading state exactly while the removal commits', async () => {
        store.set(threadRunsAtom, [makeRun('a'), makeRun('b')]);
        truncateMock.mockImplementation(async () => {
            // The clicked run's retry is pending during the POST — this is
            // what the retry buttons render their spinner from.
            expect(store.get(retryPendingRunIdAtom)).toBe('b');
            expect(store.get(isWSChatPendingAtom)).toBe(true);
            return okReport(['b']);
        });

        await store.set(regenerateFromRunAtom, 'b');

        // Cleared once the replacement run shell took over.
        expect(store.get(retryPendingRunIdAtom)).toBeNull();
        expect(connectMock).toHaveBeenCalled();
    });

    it('a refusal reloads the thread and removes nothing locally', async () => {
        const runs = [makeRun('a'), makeRun('b'), makeRun('c')];
        store.set(threadRunsAtom, runs);
        truncateMock.mockResolvedValue(refusedReport(['b', 'c']));
        // The reload serves the server's copy of the thread whole.
        loadThreadRunsMock.mockResolvedValue({ runs, citations: [], agentActions: [] });

        await store.set(regenerateFromRunAtom, 'b');

        expect(connectMock).not.toHaveBeenCalled();
        expect(store.get(popupMessagesAtom).some(m => m.title === 'Chat changed elsewhere')).toBe(true);
        // The thread was reloaded rather than truncated.
        expect(loadThreadRunsMock).toHaveBeenCalledWith('thread-1', expect.anything());
        expect(threadRunIds()).toEqual(['a', 'b', 'c']);
        expect(store.get(isWSChatPendingAtom)).toBe(false);
    });

    it('a tail mismatch is handled like any other refusal', async () => {
        // The stale-retry case: another client already replaced the named
        // runs, so the names match nothing but the surviving tail differs.
        const runs = [makeRun('a'), makeRun('b')];
        store.set(threadRunsAtom, runs);
        truncateMock.mockResolvedValue(refusedReport([], 'tail_mismatch'));
        loadThreadRunsMock.mockResolvedValue({ runs, citations: [], agentActions: [] });

        await store.set(regenerateFromRunAtom, 'b');

        expect(connectMock).not.toHaveBeenCalled();
        expect(store.get(popupMessagesAtom).some(m => m.title === 'Chat changed elsewhere')).toBe(true);
        expect(loadThreadRunsMock).toHaveBeenCalledWith('thread-1', expect.anything());
        expect(threadRunIds()).toEqual(['a', 'b']);
    });

    it('on success the order is POST, undo, local removal, then send', async () => {
        store.set(threadRunsAtom, [makeRun('a'), makeRun('b'), makeRun('c')]);
        store.set(threadAgentActionsAtom, [makeAppliedMetadataEdit('act-1', 'b')]);
        promptConfirmMock.mockReturnValue(0); // Undo && Retry

        const order: string[] = [];
        truncateMock.mockImplementation(async () => {
            order.push('truncate');
            // The confirm dialog precedes the POST (consent before commit).
            expect(promptConfirmMock).toHaveBeenCalled();
            return okReport(['b', 'c']);
        });
        undoEditMetadataMock.mockImplementation(async () => {
            order.push('undo');
            // The undo executes after the POST but before the local removal.
            expect(threadRunIds()).toEqual(['a', 'b', 'c']);
        });
        connectMock.mockImplementation(async () => {
            order.push('send');
        });

        await store.set(regenerateFromRunAtom, 'b');

        expect(order).toEqual(['truncate', 'undo', 'send']);
        expect(threadRunIds()).toEqual(['a']);
        expect(store.get(threadAgentActionsAtom)).toHaveLength(0);

        // The replacement is an ordinary run request: no retry anchors, no
        // thread-state assertion.
        const request = sentRequest();
        expect(request.user_prompt.content).toBe('prompt for b');
        expect(request.retry_run_id).toBeUndefined();
        expect(request.retry_keep_run_ids).toBeUndefined();
        expect(request.thread_run_ids).toBeUndefined();
    });

    it('edit-and-retry shares the flow and sends the edited prompt', async () => {
        store.set(threadRunsAtom, [makeRun('a'), makeRun('b'), makeRun('c')]);
        truncateMock.mockResolvedValue(okReport(['b', 'c']));

        await store.set(regenerateWithEditedPromptAtom, {
            runId: 'b',
            editedPrompt: { content: 'rewritten' },
        });

        expect(truncateMock).toHaveBeenCalledWith('thread-1', ['b', 'c'], 'a');
        expect(threadRunIds()).toEqual(['a']);
        const request = sentRequest();
        expect(request.user_prompt.content).toBe('rewritten');
        expect(request.retry_run_id).toBeUndefined();
        expect(request.thread_run_ids).toBeUndefined();
    });

    it('folds a terminal active run into the dialog and the POSTed removal', async () => {
        // A run that errored without a terminal `done` sits in the active
        // slot; its applied actions must reach the confirm dialog and its ID
        // the POSTed removed set (the backend persisted it).
        store.set(threadRunsAtom, [makeRun('a')]);
        store.set(activeRunAtom, makeRun('failed', { status: 'error' }));
        store.set(threadAgentActionsAtom, [makeAppliedMetadataEdit('act-1', 'failed')]);
        promptConfirmMock.mockReturnValue(2); // Retry without undoing
        truncateMock.mockResolvedValue(okReport(['failed']));

        await store.set(regenerateFromRunAtom, 'failed');

        // The dialog listed the failed run's applied action.
        expect(promptConfirmMock).toHaveBeenCalled();
        expect(promptConfirmMock.mock.calls[0][0].text).toContain('1 metadata edit');
        // The POST named the failed run.
        expect(truncateMock).toHaveBeenCalledWith('thread-1', ['failed'], 'a');
        expect(undoEditMetadataMock).not.toHaveBeenCalled();
        expect(threadRunIds()).toEqual(['a']);
        expect(sentRequest().user_prompt.content).toBe('prompt for failed');
    });

    it('retrying the first run names the whole thread', async () => {
        store.set(threadRunsAtom, [makeRun('a'), makeRun('b')]);
        truncateMock.mockResolvedValue(okReport(['a', 'b']));

        await store.set(regenerateFromRunAtom, 'a');

        expect(truncateMock).toHaveBeenCalledWith('thread-1', ['a', 'b'], null);
        expect(threadRunIds()).toEqual([]);
        expect(sentRequest().user_prompt.content).toBe('prompt for a');
    });

    describe('auto-retry', () => {
        it('POSTs the failed run without a dialog and restarts from the root prompt', async () => {
            store.set(threadRunsAtom, [makeRun('a')]);
            store.set(activeRunAtom, makeRun('failed', { status: 'error' }));
            // Applied actions stay in place on auto-retry: no dialog, no undo.
            store.set(threadAgentActionsAtom, [makeAppliedMetadataEdit('act-1', 'failed')]);
            truncateMock.mockResolvedValue(okReport(['failed']));

            await store.set(autoRetryErroredRunAtom, 'failed');

            expect(promptConfirmMock).not.toHaveBeenCalled();
            expect(undoEditMetadataMock).not.toHaveBeenCalled();
            expect(truncateMock).toHaveBeenCalledWith('thread-1', ['failed'], 'a');
            expect(threadRunIds()).toEqual(['a']);
            expect(sentRequest().user_prompt.content).toBe('prompt for failed');
        });

        it('removes the whole resume chain, not just the failed resume run', async () => {
            store.set(threadRunsAtom, [
                makeRun('a'),
                makeRun('root'),
            ]);
            store.set(activeRunAtom, makeRun('failed', {
                status: 'error',
                user_prompt: { content: '', is_resume: true, resumes_run_id: 'root' },
            }));
            truncateMock.mockResolvedValue(okReport(['root', 'failed']));

            await store.set(autoRetryErroredRunAtom, 'failed');

            expect(truncateMock).toHaveBeenCalledWith('thread-1', ['root', 'failed'], 'a');
            expect(threadRunIds()).toEqual(['a']);
            // The restart preserves the original question from the chain root.
            expect(sentRequest().user_prompt.content).toBe('prompt for root');
        });

        it('a failed POST takes the auto-retry error path with nothing to unwind', async () => {
            store.set(threadRunsAtom, [makeRun('a')]);
            store.set(activeRunAtom, makeRun('failed', { status: 'error' }));
            truncateMock.mockRejectedValue(new Error('network down'));

            await store.set(autoRetryErroredRunAtom, 'failed');

            expect(connectMock).not.toHaveBeenCalled();
            expect(store.get(wsErrorAtom)?.type).toBe('auto_retry_error');
            expect(store.get(isWSChatPendingAtom)).toBe(false);
            expect(store.get(retryPendingRunIdAtom)).toBeNull();
            // Nothing was removed — the failed run is archived into thread
            // history (view coherence), not deleted.
            expect(threadRunIds()).toEqual(['a', 'failed']);
        });

        it('a refusal reloads the thread instead of raising a retry error', async () => {
            // The auto-retry raced a rewrite from another client. There is no
            // user decision to retry against unseen history — the UI must
            // show the server's thread, not a generic auto-retry error over
            // the stale local view.
            const serverRuns = [makeRun('a'), makeRun('failed', { status: 'error' })];
            store.set(threadRunsAtom, [makeRun('a')]);
            store.set(activeRunAtom, makeRun('failed', { status: 'error' }));
            truncateMock.mockResolvedValue(refusedReport(['failed']));
            loadThreadRunsMock.mockResolvedValue({ runs: serverRuns, citations: [], agentActions: [] });

            await store.set(autoRetryErroredRunAtom, 'failed');

            expect(connectMock).not.toHaveBeenCalled();
            expect(store.get(wsErrorAtom)).toBeNull();
            expect(store.get(popupMessagesAtom).some(m => m.title === 'Chat changed elsewhere')).toBe(true);
            expect(loadThreadRunsMock).toHaveBeenCalledWith('thread-1', expect.anything());
            expect(store.get(isWSChatPendingAtom)).toBe(false);
            expect(store.get(retryPendingRunIdAtom)).toBeNull();
        });
    });

    describe('the retry lock', () => {
        it('blocks a second retry while another commit is in flight', async () => {
            store.set(threadRunsAtom, [makeRun('a'), makeRun('b'), makeRun('c')]);
            let resolveTruncate!: (report: unknown) => void;
            truncateMock.mockImplementation(
                () => new Promise((resolve) => { resolveTruncate = resolve; }),
            );

            // Not awaited: the first retry runs synchronously up to its POST.
            const first = store.set(regenerateFromRunAtom, 'c');
            expect(store.get(retryPendingRunIdAtom)).toBe('c');

            // Retry controls of other runs are still clickable — the lock is
            // what keeps this from issuing a second, racing truncation.
            await store.set(regenerateFromRunAtom, 'b');
            expect(truncateMock).toHaveBeenCalledTimes(1);

            resolveTruncate(okReport(['c']));
            await first;

            expect(threadRunIds()).toEqual(['a', 'b']);
            expect(connectMock).toHaveBeenCalledTimes(1);
            expect(sentRequest().user_prompt.content).toBe('prompt for c');
        });

        it('blocks a send mid-commit even after a stale pending clear', async () => {
            // The failed run's dying socket clears isWSChatPendingAtom after
            // onError dispatched the auto-retry; the retry lock must still
            // block a user send until the commit finishes.
            store.set(threadRunsAtom, [makeRun('a')]);
            store.set(activeRunAtom, makeRun('failed', { status: 'error' }));
            truncateMock.mockImplementation(async () => {
                store.set(isWSChatPendingAtom, false); // the stale clear
                await store.set(sendWSMessageAtom, 'sneaky follow-up');
                expect(connectMock).not.toHaveBeenCalled();
                return okReport(['failed']);
            });

            await store.set(autoRetryErroredRunAtom, 'failed');

            expect(connectMock).toHaveBeenCalledTimes(1);
            expect(sentRequest().user_prompt.content).toBe('prompt for failed');
        });

        it('blocks a resume while a retry commit is in flight', async () => {
            store.set(threadRunsAtom, [makeRun('a')]);
            store.set(activeRunAtom, makeRun('failed', {
                status: 'error',
                error: { type: 'llm_error', message: 'boom', is_resumable: true },
            }));
            store.set(retryPendingRunIdAtom, 'other');

            await store.set(resumeFromRunAtom, 'failed');

            expect(connectMock).not.toHaveBeenCalled();
        });
    });

    describe('paths that never truncate', () => {
        it('an ordinary send makes no POST and asserts nothing', async () => {
            store.set(threadRunsAtom, [makeRun('a'), makeRun('b')]);

            await store.set(sendWSMessageAtom, 'hello');

            expect(truncateMock).not.toHaveBeenCalled();
            const request = sentRequest();
            expect(request.thread_run_ids).toBeUndefined();
            expect(request.retry_run_id).toBeUndefined();
            expect(request.retry_keep_run_ids).toBeUndefined();
        });

        it('resumes a run the backend cut off, which is not an error run', async () => {
            // How a shutdown-interrupted run comes back from the backend:
            // status `canceled`, with the cause in `error.reason_code`.
            store.set(threadRunsAtom, [makeRun('a'), makeRun('interrupted', {
                status: 'canceled',
                error: {
                    type: 'canceled',
                    message: 'The client closed the connection',
                    reason_code: 'client_closed',
                },
            })]);

            await store.set(resumeFromRunAtom, 'interrupted');

            expect(truncateMock).not.toHaveBeenCalled();
            expect(threadRunIds()).toEqual(['a', 'interrupted']);
            const request = sentRequest();
            expect(request.user_prompt.is_resume).toBe(true);
            expect(request.user_prompt.resumes_run_id).toBe('interrupted');
        });

        it.each([
            ['the user stopped it', 'client_cancel'],
            ['nothing says why it ended', undefined],
        ])('refuses to resume a canceled run when %s', async (_label, reasonCode) => {
            store.set(threadRunsAtom, [makeRun('canceled', {
                status: 'canceled',
                error: reasonCode
                    ? { type: 'canceled', message: 'Stopped', reason_code: reasonCode }
                    : undefined,
            })]);

            await store.set(resumeFromRunAtom, 'canceled');

            expect(connectMock).not.toHaveBeenCalled();
        });

        it('still refuses an error run the backend did not call resumable', async () => {
            store.set(threadRunsAtom, [makeRun('failed', {
                status: 'error',
                error: { type: 'llm_error', message: 'boom' },
            })]);

            await store.set(resumeFromRunAtom, 'failed');

            expect(connectMock).not.toHaveBeenCalled();
        });

        it('a resume keeps the failed run and makes no POST', async () => {
            store.set(threadRunsAtom, [makeRun('a')]);
            store.set(activeRunAtom, makeRun('failed', {
                status: 'error',
                error: { type: 'llm_error', message: 'boom', is_resumable: true },
            }));

            await store.set(resumeFromRunAtom, 'failed');

            expect(truncateMock).not.toHaveBeenCalled();
            expect(threadRunIds()).toEqual(['a', 'failed']);
            const request = sentRequest();
            expect(request.user_prompt.is_resume).toBe(true);
            expect(request.user_prompt.resumes_run_id).toBe('failed');
            expect(request.retry_run_id).toBeUndefined();
        });
    });

    describe('transport re-POST', () => {
        it('re-POSTs exactly once on an ambiguous failure', async () => {
            const { ThreadService } = await vi.importActual<
                typeof import('@beaver/agent-core/transport/threadService')
            >('@beaver/agent-core/transport/threadService');
            const service = new ThreadService('http://test');
            const postMock = vi.fn()
                .mockRejectedValueOnce(new ServerError('lost in transit'))
                .mockResolvedValueOnce(okReport([]));
            (service as any).post = postMock;

            const report = await service.truncateThread('thread-1', ['b'], 'a');

            expect(postMock).toHaveBeenCalledTimes(2);
            expect(postMock.mock.calls[0][0]).toBe(postMock.mock.calls[1][0]);
            expect(postMock.mock.calls[0][1]).toEqual({ removed_run_ids: ['b'], expected_tail_run_id: 'a' });
            expect(report.deleted_run_ids).toEqual([]);
        });

        it('does not re-POST a definitive 4xx', async () => {
            const { ThreadService } = await vi.importActual<
                typeof import('@beaver/agent-core/transport/threadService')
            >('@beaver/agent-core/transport/threadService');
            const service = new ThreadService('http://test');
            const postMock = vi.fn().mockRejectedValue(new ApiError(422, 'Unprocessable Entity'));
            (service as any).post = postMock;

            await expect(service.truncateThread('thread-1', ['b'], 'a')).rejects.toBeInstanceOf(ApiError);
            expect(postMock).toHaveBeenCalledTimes(1);
        });
    });
});
