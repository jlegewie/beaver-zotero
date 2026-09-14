import {
    threadAdmissionAtom,
    threadConflictAtom,
} from "../../../react/runtime/threadAdmission";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionFailureEvidence } from "@beaver/agent-core/transport/connectionFailure";

const {
    connectMock,
    closeMock,
    cancelMock,
    loadThreadRunsMock,
    resolveClientIdentityMock,
    reportConnectionFailureMock,
} = vi.hoisted(() => ({
    connectMock: vi.fn(),
    closeMock: vi.fn(),
    cancelMock: vi.fn(),
    loadThreadRunsMock: vi.fn(),
    resolveClientIdentityMock: vi.fn(),
    reportConnectionFailureMock: vi.fn().mockResolvedValue(undefined),
}));

// A stand-in for the service, and a stand-in class that the retry loop's
// `instanceof` check still narrows against: the mocked specifier and the loop's
// own relative import resolve to one module, so both see this same class.
vi.mock("@beaver/agent-core/transport/agentService", () => ({
    agentRunService: {
        getThreadRuns: vi
            .fn()
            .mockResolvedValue({
                runs: [],
                agent_actions: [],
                tail_run_id: null,
                activity: { state: "idle", run_id: null },
            }),
    },
    agentService: {
        connect: connectMock,
        close: closeMock,
        cancel: cancelMock,
        isConnected: () => true,
    },
    AgentConnectionError: class AgentConnectionError extends Error {
        evidence: ConnectionFailureEvidence;
        constructor(message: string, evidence: ConnectionFailureEvidence) {
            super(message);
            this.name = "AgentConnectionError";
            this.evidence = evidence;
        }
    },
}));
vi.mock("@beaver/agent-core/transport/clientIdentity", () => ({
    resolveClientIdentity: resolveClientIdentityMock,
}));
vi.mock("@beaver/agent-core/transport/clients/diagnosticsService", () => ({
    reportConnectionFailure: reportConnectionFailureMock,
}));
vi.mock("../../../react/atoms/applicationState", () => ({
    getApplicationStateProvider: vi.fn(() => async () => ({})),
}));
vi.mock("../../../src/services/systemNotifications", () => ({
    notifyRunComplete: vi.fn(),
    notifyUserQuestion: vi.fn(),
}));
vi.mock("@beaver/agent-core/transport/supabaseClient", () => ({
    supabase: { auth: { getSession: vi.fn(), refreshSession: vi.fn() } },
}));
vi.mock("../../../src/beaver-extract", () => ({ prewarmMuPDFWorker: vi.fn() }));
vi.mock("@beaver/agent-core/platform/logger", () => ({ logger: vi.fn() }));

vi.mock('@beaver/agent-core/run-state/loadThreadRuns', () => ({ loadThreadRuns: loadThreadRunsMock }));
vi.mock('../../../react/utils/annotationUtils', () => ({
    BeaverTemporaryAnnotations: { cleanupAll: vi.fn().mockResolvedValue(undefined) },
}));

import { newThreadAtom, loadThreadAtom } from '../../../react/atoms/threads';
import { citationsAtom } from '@beaver/agent-core/citations/atoms';
import { runApprovalPolicyAtom } from '../../../react/atoms/runApprovalPolicy';
import { streamingDoneRunIdsAtom, approvalResponseIntentsAtom, closeWSConnectionAtom, isWSConnectedAtom } from '../../../react/atoms/agentRunAtoms';
import { AgentConnectionError } from "@beaver/agent-core/transport/agentService";
import {
    activeRunAtom,
    wsReconnectingAtom,
} from "@beaver/agent-core/run-state/atoms";
import { store } from "../../../react/store";
import {
    isWSChatPendingAtom,
    isWSReadyAtom,
    sendWSMessageAtom,
    wsErrorAtom,
} from "../../../react/atoms/agentRunAtoms";
import { popupMessagesAtom } from "../../../react/atoms/ui";
import { sessionAtom } from "../../../react/atoms/auth";

import { ThreadPresence } from "../../../src/services/threads/threadPresence";
import { initializeWindowRuntime } from "../../../react/runtime/windowRuntime";
import { releaseWriter } from "../../../react/runtime/threadWriter";
import { getCredentialGeneration } from "@beaver/agent-core/transport/credentials";
import {
    currentThreadIdAtom,
    threadRunsAtom,
} from "@beaver/agent-core/run-state/atoms";
import {
    currentMessageContentAtom,
    currentMessageItemsAtom,
} from "../../../react/atoms/messageComposition";
import { threadPresenceAtom, threadHistoryStaleAtom, threadReadOnlyAtom, otherThreadWriterAtom, viewedHistoryRevisionAtom } from "../../../react/runtime/threadProjection";
import {
    clearClientShutDownLatch,
    closeWSConnectionForShutdownAtom,
    retryPendingRunIdAtom,
} from "../../../react/atoms/agentRunAtoms";
const runtime = { id: "a", status: "ready", hostWindow: {} } as any;
initializeWindowRuntime(runtime);
let presence: ThreadPresence;
beforeEach(() => {
    store.set(threadAdmissionAtom, null);
    store.set(threadConflictAtom, null);
    releaseWriter();
    vi.clearAllMocks();
    clearClientShutDownLatch();
    presence = new ThreadPresence();
    presence.reset(getCredentialGeneration());
    (Zotero as any).Beaver = {
        presence,
        threads: { invalidateViews: vi.fn(), patchThread: vi.fn() },
    };
    presence.subscribe(snapshot => store.set(threadPresenceAtom, snapshot));
    store.set(popupMessagesAtom, []);
    store.set(currentThreadIdAtom, "t");
    store.set(viewedHistoryRevisionAtom, 0);
    store.set(activeRunAtom, null);
    store.set(threadRunsAtom, []);
    store.set(isWSChatPendingAtom, false);
    store.set(wsErrorAtom, null);
    store.set(sessionAtom, { user: { id: "user-1" } } as any);
    store.set(currentMessageContentAtom, "my draft");
    store.set(currentMessageItemsAtom, []);
    resolveClientIdentityMock.mockReturnValue({
        frontendVersion: "test",
        clientType: "zotero-plugin",
        clientFeatures: [],
    });
});
describe("writer admission at the real send entry point", () => {
    it("refuses a competing send before preparation and preserves the draft", async () => {
        const owner = presence.claim("b", "t", getCredentialGeneration())!;
        await store.set(sendWSMessageAtom, "hello");
        expect(connectMock).not.toHaveBeenCalled();
        expect(store.get(currentMessageContentAtom)).toBe("my draft");
        expect(presence.owns(owner)).toBe(true);
    });
    it("shows busy rather than stale-history feedback while another writer owns an invalidated chat", async () => {
        presence.claim("b", "t", getCredentialGeneration());
        presence.invalidate("t");
        await store.set(sendWSMessageAtom, "hello");
        expect(connectMock).not.toHaveBeenCalled();
        expect(store.get(currentMessageContentAtom)).toBe("my draft");
        expect(store.get(popupMessagesAtom).at(-1)?.title).toBe("Responding in another window");
    });
    it("keeps the owner and its borrowed surfaces editable through its own realtime invalidation", async () => {
        let callbacks: any;
        connectMock.mockImplementation(async (_request, value) => { callbacks = value; });
        await store.set(sendWSMessageAtom, "hello");
        presence.invalidate("t");
        expect(store.get(otherThreadWriterAtom)).toBeNull();
        expect(store.get(threadHistoryStaleAtom)).toBe(false);
        expect(store.get(threadReadOnlyAtom)).toBe(false);
        callbacks.onDone();
        expect(store.get(threadHistoryStaleAtom)).toBe(false);
        presence.invalidate("t");
        expect(store.get(threadHistoryStaleAtom)).toBe(true);
    });
    it("holds ownership through connection and finalization, rejecting stale socket completions", async () => {
        let callbacks: any;
        connectMock.mockImplementation(async (_request, value) => {
            callbacks = value;
        });
        const preparing = store.set(sendWSMessageAtom, "hello");
        expect(presence.getSnapshot().claims).toHaveLength(1);
        expect(presence.claim("b", "t", getCredentialGeneration())).toBeNull();
        await preparing;
        expect(presence.getSnapshot().claims).toHaveLength(1);
        callbacks.onDone();
        expect(presence.getSnapshot().claims).toHaveLength(0);
        const successor = presence.claim("b", "t", getCredentialGeneration())!;
        const history = store.get(threadRunsAtom);
        callbacks.onThread("wrong-thread");
        callbacks.onDone();
        expect(store.get(currentThreadIdAtom)).toBe("t");
        expect(store.get(threadRunsAtom)).toEqual(history);
        expect(presence.owns(successor)).toBe(true);
    });
    it("requires draft-preserving reconciliation after another writer settles", async () => {
        const owner = presence.claim("b", "t", getCredentialGeneration())!;
        presence.release(owner);
        await store.set(sendWSMessageAtom, "hello");
        expect(connectMock).not.toHaveBeenCalled();
        expect(store.get(currentMessageContentAtom)).toBe("my draft");
    });
    it("revokes a preparing connection when its renderer closes", async () => {
        let resolve!: () => void;
        connectMock.mockImplementation(
            () =>
                new Promise<void>((r) => {
                    resolve = r;
                }),
        );
        const sending = store.set(sendWSMessageAtom, "hello");
        await vi.waitFor(() => expect(connectMock).toHaveBeenCalledOnce());
        store.set(retryPendingRunIdAtom, "retry-being-prepared");
        store.set(closeWSConnectionForShutdownAtom, "Main window closed");
        expect(store.get(retryPendingRunIdAtom)).toBeNull();
        expect(presence.getSnapshot().claims).toHaveLength(0);
        const successor = presence.claim("b", "t", getCredentialGeneration())!;
        const revisionAfterShutdown = store.get(viewedHistoryRevisionAtom);
        resolve();
        await sending;
        expect(presence.owns(successor)).toBe(true);
        expect(store.get(viewedHistoryRevisionAtom)).toBe(revisionAfterShutdown);
    });
});

describe('navigation after streaming finishes with a writer lease', () => {
    it.each(['new chat', 'switch chat', 'stop'] as const)(
        'clears abandoned source linking on %s and reopening',
        async (navigation) => {
            let callbacks: any;
            connectMock.mockImplementation(async (_request, value) => { callbacks = value; });
            await store.set(sendWSMessageAtom, 'hello');
            const run = store.get(activeRunAtom)!;
            callbacks.onStreamingDone({ run_id: run.id });
            store.set(approvalResponseIntentsAtom, new Map([['approval', true]]));
            store.set(runApprovalPolicyAtom, { runId: run.id, fullAccess: true, approvedResources: new Set(['item']) });
            expect(store.get(streamingDoneRunIdsAtom).has(run.id)).toBe(true);
            cancelMock.mockImplementation(async () => { callbacks.onClose(1000, 'User cancelled', true); });
            loadThreadRunsMock.mockResolvedValue({
                runs: [],
                citations: [],
                agentActions: [],
                tailRunId: null,
                activity: { state: "idle", run_id: null },
            });
            if (navigation === 'new chat') {
            await store.set(newThreadAtom, { skipAutoPopulate: true, skipActiveRunConfirm: true });
        } else if (navigation === 'switch chat') {
            expect(await store.set(loadThreadAtom, { threadId: 'other', user_id: 'user-1', threadName: 'Other', threadIdentity: { zoteroUserId: null, zoteroLocalId: null } })).toBe(true);
        } else {
            await store.set(closeWSConnectionAtom);
        }
            if (navigation === 'stop') expect(store.get(threadReadOnlyAtom)).toBe(false);
            expect(cancelMock).toHaveBeenCalledOnce();
            expect(store.get(streamingDoneRunIdsAtom).size).toBe(0);
            expect(store.get(approvalResponseIntentsAtom).size).toBe(0);
            expect(store.get(runApprovalPolicyAtom).runId).toBeNull();
            expect(presence.getSnapshot().claims).toHaveLength(0);
            const canceled = { ...run, status: 'canceled', completed_at: new Date().toISOString() };
            loadThreadRunsMock.mockResolvedValue({
                runs: [canceled],
                citations: [],
                agentActions: [],
                tailRunId: null,
                activity: { state: "idle", run_id: null },
            });
            expect(await store.set(loadThreadAtom, { threadId: 't', user_id: 'user-1', threadName: 'Original', threadIdentity: { zoteroUserId: null, zoteroLocalId: null } })).toBe(true);
            expect(store.get(threadRunsAtom)[0].status).toBe('canceled');
            expect(store.get(citationsAtom)).toEqual([]);
            expect(store.get(streamingDoneRunIdsAtom).has(run.id)).toBe(false);
            callbacks.onStreamingDone({ run_id: run.id });
            callbacks.onDone();
            expect(store.get(streamingDoneRunIdsAtom).size).toBe(0);
            expect(store.get(threadRunsAtom)).toEqual([canceled]);
            const abandonedCallbacks = callbacks;
            await store.set(sendWSMessageAtom, 'next response');
            const successor = store.get(activeRunAtom)!;
            callbacks.onStreamingDone({ run_id: successor.id });
            abandonedCallbacks.onClose(1000, 'Late close', true);
            abandonedCallbacks.onDone();
            abandonedCallbacks.onRunCitations({ run_id: run.id, citations: [] });
            expect(store.get(activeRunAtom)?.id).toBe(successor.id);
            expect(store.get(isWSChatPendingAtom)).toBe(true);
            expect([...store.get(streamingDoneRunIdsAtom)]).toEqual([successor.id]);
        },
    );
});

describe('terminal cleanup before writer revocation', () => {
    it('clears connection state when an error releases ownership before socket close', async () => {
        let callbacks: any;
        connectMock.mockImplementation(async (_request, value) => { callbacks = value; });
        await store.set(sendWSMessageAtom, 'hello');
        store.set(isWSConnectedAtom, true);
        store.set(isWSReadyAtom, true);
        callbacks.onStreamingDone({ run_id: store.get(activeRunAtom)!.id });
        callbacks.onError({ type: 'error', error: 'Failed', error_type: 'test_error' });
        callbacks.onClose(1000, 'Finished', true);
        expect(store.get(streamingDoneRunIdsAtom).size).toBe(0);
        expect(store.get(isWSConnectedAtom)).toBe(false);
        expect(store.get(isWSReadyAtom)).toBe(false);
    });
    it('archives a completed response when stopped during citation linking', async () => {
        let callbacks: any;
        connectMock.mockImplementation(async (_request, value) => { callbacks = value; });
        await store.set(sendWSMessageAtom, 'hello');
        const run = store.get(activeRunAtom)!;
        callbacks.onStreamingDone({ run_id: run.id });
        await callbacks.onRunComplete({ run_id: run.id, citations: null });
        cancelMock.mockImplementation(async () => { callbacks.onClose(1000, 'User cancelled', true); });
        await store.set(closeWSConnectionAtom);
        expect(store.get(activeRunAtom)).toBeNull();
        expect(store.get(threadRunsAtom)).toEqual([expect.objectContaining({ id: run.id, status: 'completed' })]);
        expect(store.get(streamingDoneRunIdsAtom).size).toBe(0);
    });
});
