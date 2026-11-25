/**
 * Run sessions are independent of each other in one realm.
 *
 * The engine keeps nothing at module level: a session's callbacks write to its
 * own store, reach its own host and transport, and are revoked by its own
 * epoch. Two sessions side by side never see each other's events.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

const { mockSupabase } = vi.hoisted(() => ({
    mockSupabase: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({ supabase: mockSupabase }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ tryGetWindowRuntime: () => undefined }));
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

import type { WSPartEvent } from '@beaver/agent-core/protocol/agentProtocol';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { AgentService } from '@beaver/agent-core/transport/agentService';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
// Installs the renderer's own session, which neither session below may touch.
import { createWSCallbacks, isWSReadyAtom, staleApprovalActionIdsAtom } from '../../../react/atoms/agentRunAtoms';
import { RunSession, getRunSession } from '../../../react/agentRuns/runSession';
import type { RunHost } from '../../../react/agentRuns/runHost';

function streamingRun(id: string): AgentRun {
    return {
        id,
        thread_id: 'thread-1',
        status: 'in_progress',
        model_messages: [],
        user_prompt: { content: 'question', is_resume: false },
    } as unknown as AgentRun;
}

function textPart(runId: string, content: string): WSPartEvent {
    return {
        event: 'part',
        run_id: runId,
        message_index: 0,
        part_index: 0,
        part: { part_kind: 'text', content },
    } as unknown as WSPartEvent;
}

function streamedText(run: AgentRun | null): string | undefined {
    const message = run?.model_messages[0];
    if (!message || message.kind !== 'response') return undefined;
    const part = message.parts[0];
    return part?.part_kind === 'text' ? part.content : undefined;
}

function fakeHost(): RunHost {
    return new Proxy({} as RunHost, {
        get: (target, name: string) => ((target as any)[name] ??= vi.fn()),
    });
}

/** A session on its own store. */
function makeSession() {
    const store = createStore();
    const host = fakeHost();
    const service = { close: vi.fn() } as unknown as AgentService;
    const session = new RunSession(store, service, host);
    return { store, host, service, session };
}

describe('two run sessions in one realm', () => {
    let a: ReturnType<typeof makeSession>;
    let b: ReturnType<typeof makeSession>;

    beforeEach(() => {
        a = makeSession();
        b = makeSession();
        a.store.set(activeRunAtom, streamingRun('run-a'));
        b.store.set(activeRunAtom, streamingRun('run-b'));
    });

    it('streams each session into its own store', async () => {
        const callbacksA = createWSCallbacks(a.store.set, undefined, undefined, a.session);
        const callbacksB = createWSCallbacks(b.store.set, undefined, undefined, b.session);

        await callbacksA.onPart?.(textPart('run-a', 'from A'));
        await callbacksB.onPart?.(textPart('run-b', 'from B'));

        expect(streamedText(a.store.get(activeRunAtom))).toBe('from A');
        expect(streamedText(b.store.get(activeRunAtom))).toBe('from B');
        expect(getRunSession()).not.toBe(a.session);
        expect(getRunSession()).not.toBe(b.session);
    });

    it('reaches only its own host', () => {
        const callbacksA = createWSCallbacks(a.store.set, undefined, undefined, a.session);

        callbacksA.onReady?.({} as never);

        expect(a.host.backendReachable).toHaveBeenCalledTimes(1);
        expect(b.host.backendReachable).not.toHaveBeenCalled();
        expect(a.store.get(isWSReadyAtom)).toBe(true);
        expect(b.store.get(isWSReadyAtom)).toBe(false);
    });

    it('revokes only its own callbacks', async () => {
        const callbacksA = createWSCallbacks(a.store.set, undefined, undefined, a.session);
        const callbacksB = createWSCallbacks(b.store.set, undefined, undefined, b.session);

        // What abandoning a run locally does to the callbacks created before it.
        a.session.writerCallbackEpoch++;
        await callbacksA.onPart?.(textPart('run-a', 'late A'));
        await callbacksB.onPart?.(textPart('run-b', 'live B'));

        expect(streamedText(a.store.get(activeRunAtom))).toBeUndefined();
        expect(streamedText(b.store.get(activeRunAtom))).toBe('live B');
    });

    it('keeps the actions its events start in its own store', () => {
        const callbacksA = createWSCallbacks(a.store.set, undefined, undefined, a.session);

        // Marking an approval stale is an action of its own, started by the event.
        callbacksA.onDeferredApprovalStale?.({ action_id: 'action-1', reason: 'timeout' } as never);

        expect(a.store.get(staleApprovalActionIdsAtom).has('action-1')).toBe(true);
        expect(b.store.get(staleApprovalActionIdsAtom).size).toBe(0);
        expect(getRunSession().store.get(staleApprovalActionIdsAtom).size).toBe(0);
    });
});
