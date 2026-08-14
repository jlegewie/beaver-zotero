/**
 * Every request states the runs the client holds, and the server deletes the
 * trailing block after the last of them it recognises. Two properties of that
 * set are load-bearing and silent when broken — a wrong set still sends, still
 * streams, and only shows up as history the user cannot see:
 *
 * - a retry must assert the thread *after* its local truncation, or the server
 *   is told to keep what the user just replaced;
 * - an ordinary send must assert every run on screen, including a failed one
 *   still in the active slot, or the server deletes it and cascades the
 *   `agent_actions` of anything it applied in Zotero.
 *
 * Send, retry, edit-retry, resume, and auto-retry are separate atoms; each has
 * to build that set itself. A path that forgets is not saved by the others.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectMock } = vi.hoisted(() => ({
    connectMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@beaver/agent-core/transport/agentService', () => ({
    agentService: { connect: connectMock, close: vi.fn(), cancel: vi.fn() },
    AgentConnectionError: class AgentConnectionError extends Error {},
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
    isStreamingAtom,
    threadRunsAtom,
} from '@beaver/agent-core/run-state/atoms';
import {
    autoRetryErroredRunAtom,
    isWSChatPendingAtom,
    regenerateFromRunAtom,
    regenerateWithEditedPromptAtom,
    resumeFromRunAtom,
    sendWSMessageAtom,
} from '../../../react/atoms/agentRunAtoms';
import { selectedModelAtom } from '../../../react/atoms/models';
import { sessionAtom } from '../../../react/atoms/auth';

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

/** The request handed to the transport by the most recent send. */
function sentRequest(): any {
    expect(connectMock).toHaveBeenCalled();
    return connectMock.mock.calls[connectMock.mock.calls.length - 1][0];
}

describe('thread state asserted on a request', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockResolvedValue(undefined);
        store.set(sessionAtom, { user: { id: 'user-1' } } as any);
        store.set(selectedModelAtom, { name: 'test-model', provider: 'test' } as any);
        // The store is a module singleton, so a send left pending by the
        // previous test would silently block the next one.
        store.set(isWSChatPendingAtom, false);
        store.set(currentThreadIdAtom, 'thread-1');
        store.set(activeRunAtom, null);
        store.set(threadRunsAtom, []);
    });

    it('states every run the thread holds on an ordinary send', async () => {
        store.set(threadRunsAtom, [makeRun('a'), makeRun('b')]);

        await store.set(sendWSMessageAtom, 'hello');

        expect(sentRequest().thread_run_ids).toEqual(['a', 'b']);
        // Not a retry: nothing is being replaced, so no anchor is named.
        expect(sentRequest().retry_run_id).toBeUndefined();
    });

    it('includes a failed run still in the active slot', async () => {
        // A run that errored without a terminal `done` never reaches thread
        // history, but the user is looking at its error card and the server
        // has it. Omitting it would anchor on 'a' and delete it.
        store.set(threadRunsAtom, [makeRun('a')]);
        store.set(activeRunAtom, makeRun('failed', { status: 'error' }));

        await store.set(sendWSMessageAtom, 'follow-up');

        expect(sentRequest().thread_run_ids).toEqual(['a', 'failed']);
        // The failed run is archived into thread history so the next request
        // still holds it. Overwriting the active slot without that would drop
        // it from the client's view while the server kept it.
        expect(store.get(threadRunsAtom).map((run: AgentRun) => run.id)).toEqual(['a', 'failed']);
        expect(store.get(activeRunAtom)?.user_prompt.content).toBe('follow-up');
    });

    it('still names a real anchor when the active run was never persisted', async () => {
        // The failed-retry case the whole design exists for: 'x' is the shell of
        // a retry that died before the server wrote its row, so the server holds
        // runs after 'a' that the user can no longer see. Asserting 'x' alongside
        // 'a' is harmless — the server anchors on the last ID it recognises, so
        // the phantom cannot stop it truncating the stranded tail.
        store.set(threadRunsAtom, [makeRun('a')]);
        store.set(activeRunAtom, makeRun('x', { status: 'error' }));

        await store.set(sendWSMessageAtom, 'follow-up');

        expect(sentRequest().thread_run_ids).toEqual(['a', 'x']);
    });

    it('states the thread as it is after a retry truncated it locally', async () => {
        store.set(threadRunsAtom, [makeRun('a'), makeRun('b'), makeRun('c')]);

        await store.set(regenerateFromRunAtom, 'b');

        const request = sentRequest();
        // 'b' and everything after it are what the retry replaces, so they are
        // absent from the asserted set and 'b' is named as the anchor.
        expect(request.thread_run_ids).toEqual(['a']);
        expect(request.retry_run_id).toBe('b');
        // Sent alongside for backends that predate thread_run_ids.
        expect(request.retry_keep_run_ids).toEqual(['a']);
    });

    it('names the phantom when retrying a failed retry of the first run', async () => {
        // The case the removed anchor-inheritance used to cover. A retry of the
        // thread's first run died before the server persisted its replacement,
        // so the client holds nothing and an error shell 'p' sits in the active
        // slot. Retrying that shell asserts an empty thread and names 'p'.
        //
        // The empty set is not silence here: silence is gated on the absence of
        // retry_run_id, so the server tries 'p' (matching nothing), then falls
        // through to the empty keep set and clears the thread — the same
        // outcome the inherited anchor produced.
        store.set(threadRunsAtom, []);
        store.set(activeRunAtom, makeRun('p', { status: 'error' }));

        await store.set(regenerateFromRunAtom, 'p');

        const request = sentRequest();
        expect(request.thread_run_ids).toEqual([]);
        expect(request.retry_run_id).toBe('p');
    });

    it('asserts an empty thread when the retried run was the first', async () => {
        store.set(threadRunsAtom, [makeRun('a'), makeRun('b')]);

        await store.set(regenerateFromRunAtom, 'a');

        const request = sentRequest();
        // Empty is silence to the server unless a retry names an anchor too —
        // which is why retry_run_id has to travel with it.
        expect(request.thread_run_ids).toEqual([]);
        expect(request.retry_run_id).toBe('a');
        expect(request.retry_keep_run_ids).toBeUndefined();
    });

    it('retries a failed run still in the active slot without keeping it', async () => {
        // Retry from the error card: the failed run is what is being replaced,
        // so it must not appear in the asserted set.
        store.set(threadRunsAtom, [makeRun('a')]);
        store.set(activeRunAtom, makeRun('failed', { status: 'error' }));

        await store.set(regenerateFromRunAtom, 'failed');

        const request = sentRequest();
        expect(request.thread_run_ids).toEqual(['a']);
        expect(request.retry_run_id).toBe('failed');
        expect(store.get(threadRunsAtom).map((run: AgentRun) => run.id)).toEqual(['a']);
    });

    it('asserts the truncated thread when retrying from an edited prompt', async () => {
        store.set(threadRunsAtom, [makeRun('a'), makeRun('b'), makeRun('c')]);

        await store.set(regenerateWithEditedPromptAtom, {
            runId: 'b',
            editedPrompt: { content: 'rewritten' },
        });

        const request = sentRequest();
        expect(request.thread_run_ids).toEqual(['a']);
        expect(request.retry_run_id).toBe('b');
        expect(request.retry_keep_run_ids).toEqual(['a']);
        expect(request.user_prompt.content).toBe('rewritten');
    });

    it('retries an edited failed run in the active slot without keeping it', async () => {
        store.set(threadRunsAtom, [makeRun('a')]);
        store.set(activeRunAtom, makeRun('failed', { status: 'error' }));

        await store.set(regenerateWithEditedPromptAtom, {
            runId: 'failed',
            editedPrompt: { content: 'rewritten' },
        });

        const request = sentRequest();
        expect(request.thread_run_ids).toEqual(['a']);
        expect(request.retry_run_id).toBe('failed');
        expect(request.user_prompt.content).toBe('rewritten');
    });

    it('keeps the failed run when resuming from it', async () => {
        store.set(threadRunsAtom, [makeRun('a')]);
        store.set(activeRunAtom, makeRun('failed', {
            status: 'error',
            error: { type: 'llm_error', message: 'boom', is_resumable: true },
        }));

        await store.set(resumeFromRunAtom, 'failed');

        const request = sentRequest();
        expect(request.thread_run_ids).toEqual(['a', 'failed']);
        expect(request.retry_run_id).toBeUndefined();
        expect(request.user_prompt.is_resume).toBe(true);
        expect(request.user_prompt.resumes_run_id).toBe('failed');
        expect(store.get(threadRunsAtom).map((run: AgentRun) => run.id)).toEqual(['a', 'failed']);
        expect(store.get(activeRunAtom)?.user_prompt.is_resume).toBe(true);
    });

    it('auto-retries a failed active run as a retry of that run', async () => {
        store.set(threadRunsAtom, [makeRun('a')]);
        store.set(activeRunAtom, makeRun('failed', { status: 'error' }));

        await store.set(autoRetryErroredRunAtom, 'failed');

        const request = sentRequest();
        expect(request.thread_run_ids).toEqual(['a']);
        expect(request.retry_run_id).toBe('failed');
        expect(request.user_prompt.content).toBe('prompt for failed');
    });

    it('does not treat a failed active run as streaming', () => {
        // UserRequestView gates edit-retry on isStreamingAtom. A failed run
        // sitting in the active slot must not block editing that message.
        store.set(activeRunAtom, makeRun('failed', { status: 'error' }));
        expect(store.get(isStreamingAtom)).toBe(false);

        store.set(activeRunAtom, makeRun('live', { status: 'in_progress' }));
        expect(store.get(isStreamingAtom)).toBe(true);
    });
});
