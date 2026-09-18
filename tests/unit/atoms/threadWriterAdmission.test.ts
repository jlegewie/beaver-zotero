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
import { refreshFinishedChatAvailabilityAtom, canOpenFinishedChatAtom } from "../../../react/runtime/windowCommands";
import { agentRunService, AgentConnectionError } from "@beaver/agent-core/transport/agentService";
import {
    activeRunAtom,
    wsReconnectingAtom,
} from "@beaver/agent-core/run-state/atoms";
import { store } from "../../../react/store";
import {
    isWSChatPendingAtom,
    isWSReadyAtom,
    sendWSMessageAtom,
    resumeFromRunAtom,
    wsErrorAtom,
} from "../../../react/atoms/agentRunAtoms";
import { popupMessagesAtom } from "../../../react/atoms/ui";
import { selectedModelAtom } from "../../../react/atoms/models";
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
    currentMessageCollectionsAtom,
    currentMessageExternalFilesAtom,
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
    vi.mocked(agentRunService.getThreadRuns).mockReset().mockResolvedValue({
        runs: [], tail_run_id: null, activity: { state: "idle", run_id: null },
    });
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
    store.set(currentMessageCollectionsAtom, []);
    store.set(currentMessageExternalFilesAtom, []);
    resolveClientIdentityMock.mockReturnValue({
        frontendVersion: "test",
        clientType: "zotero-plugin",
        clientFeatures: [],
    });
});
describe("writer admission at the real send entry point", () => {
    it("resumes a failed first run with the persisted server tail", async () => {
        store.set(currentThreadIdAtom, null);
        store.set(selectedModelAtom, { name: "test-model", provider: "test" } as any);
        let callbacks: any;
        connectMock.mockImplementation(async (_request, value) => { callbacks = value; });
        await store.set(sendWSMessageAtom, "hello");
        const firstRun = store.get(activeRunAtom)!;
        callbacks.onRequestAck({ runId: firstRun.id });
        callbacks.onThread("new-thread");
        callbacks.onError({ event: "error", type: "llm_rate_limit", message: "Rate limited",
            run_id: firstRun.id, is_resumable: true });
        vi.mocked(agentRunService.getThreadRuns).mockResolvedValueOnce({
            runs: [], tail_run_id: firstRun.id, activity: { state: "idle", run_id: null },
        });

        await store.set(resumeFromRunAtom, firstRun.id);

        expect(connectMock).toHaveBeenCalledTimes(2);
        expect(connectMock.mock.calls[1][0]).toMatchObject({
            thread_id: "new-thread", expected_tail_run_id: firstRun.id,
            user_prompt: { is_resume: true, resumes_run_id: firstRun.id },
        });
    });
    it.each(["durable", "unconfirmed", "not-saved"])("sends a follow-up after a %s first-run failure", async (state) => {
        store.set(currentThreadIdAtom, null);
        let callbacks: any;
        connectMock.mockImplementation(async (_request, value) => { callbacks = value; });
        await store.set(sendWSMessageAtom, "hello");
        const firstRun = store.get(activeRunAtom)!;
        callbacks.onRequestAck({ runId: firstRun.id });
        callbacks.onThread("new-thread");
        if (state === "durable") await callbacks.onRunComplete({ run_id: firstRun.id, high_token_usage: true });
        callbacks.onError({ event: "error", type: "llm_rate_limit", message: "Rate limited",
            run_id: firstRun.id, is_resumable: true });
        const tail = state === "not-saved" ? null : firstRun.id;
        vi.mocked(agentRunService.getThreadRuns).mockResolvedValueOnce({
            runs: [], tail_run_id: tail, activity: { state: "idle", run_id: null },
        });

        await store.set(sendWSMessageAtom, "Please try again");

        expect(connectMock).toHaveBeenCalledTimes(2);
        expect(connectMock.mock.calls[1][0].expected_tail_run_id).toBe(tail);
        if (state === "durable") expect(agentRunService.getThreadRuns).not.toHaveBeenCalled();
    });
    it("resumes a confirmed failure without reading history again", async () => {
        store.set(currentThreadIdAtom, null);
        store.set(selectedModelAtom, { name: "test-model", provider: "test" } as any);
        let callbacks: any;
        connectMock.mockImplementation(async (_request, value) => { callbacks = value; });
        await store.set(sendWSMessageAtom, "hello");
        const firstRun = store.get(activeRunAtom)!;
        callbacks.onRequestAck({ runId: firstRun.id });
        callbacks.onThread("new-thread");
        await callbacks.onRunComplete({ run_id: firstRun.id, high_token_usage: true });
        callbacks.onError({ event: "error", type: "llm_rate_limit", message: "Rate limited",
            run_id: firstRun.id, is_resumable: true });

        await store.set(resumeFromRunAtom, firstRun.id);

        expect(connectMock).toHaveBeenCalledTimes(2);
        expect(connectMock.mock.calls[1][0].expected_tail_run_id).toBe(firstRun.id);
        expect(agentRunService.getThreadRuns).not.toHaveBeenCalled();
    });
    it("retains the server tail when a claimed follow-up was never saved", async () => {
        store.set(threadAdmissionAtom, { threadId: "t", tailRunId: "saved", activity: { state: "idle", run_id: null } });
        vi.mocked(agentRunService.getThreadRuns).mockResolvedValue({
            runs: [], tail_run_id: "saved", activity: { state: "idle", run_id: null },
        });
        let callbacks: any;
        connectMock.mockImplementation(async (_request, value) => { callbacks = value; });
        await store.set(sendWSMessageAtom, "hello");
        const run = store.get(activeRunAtom)!;
        callbacks.onRequestAck({ runId: run.id });
        callbacks.onThread("t");
        callbacks.onError({ event: "error", type: "setup_error", message: "Setup failed", run_id: run.id });

        await store.set(sendWSMessageAtom, "Try again");

        expect(connectMock).toHaveBeenCalledTimes(2);
        expect(connectMock.mock.calls[1][0].expected_tail_run_id).toBe("saved");
    });
    it.each(["foreign", "missing"])("preserves the draft when the tail snapshot is %s", async (snapshot) => {
        let callbacks: any;
        connectMock.mockImplementation(async (_request, value) => { callbacks = value; });
        await store.set(sendWSMessageAtom, "hello");
        const run = store.get(activeRunAtom)!;
        callbacks.onError({ event: "error", type: "setup_error", message: "Setup failed", run_id: run.id });
        store.set(threadAdmissionAtom, snapshot === "missing" ? null : {
            threadId: "other", tailRunId: "foreign", activity: { state: "idle", run_id: null },
        });
        store.set(currentMessageContentAtom, "my long draft");
        const collections = [{ library_id: 1, zotero_key: "COLLECT1", name: "Sources" }];
        const files = [{ extKey: "file", filename: "source.pdf", storedPath: "/source.pdf" }] as any;
        store.set(currentMessageCollectionsAtom, collections);
        store.set(currentMessageExternalFilesAtom, files);

        await store.set(sendWSMessageAtom, "my long draft");

        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(store.get(wsErrorAtom)?.message).toContain("Refresh the chat");
        expect(store.get(currentMessageContentAtom)).toBe("my long draft");
        expect(store.get(currentMessageCollectionsAtom)).toEqual(collections);
        expect(store.get(currentMessageExternalFilesAtom)).toEqual(files);
    });
    it("records run completion against the run's thread instead of the visible thread", async () => {
        let callbacks: any;
        connectMock.mockImplementation(async (_request, value) => { callbacks = value; });
        await store.set(sendWSMessageAtom, "hello");
        const run = store.get(activeRunAtom)!;
        store.set(currentThreadIdAtom, "different-view");

        await callbacks.onRunComplete({ run_id: run.id });

        expect(store.get(threadAdmissionAtom)).toMatchObject({ threadId: run.thread_id, tailRunId: run.id });
    });
    it("does not record an unrelated completion as the active run's tail", async () => {
        let callbacks: any;
        connectMock.mockImplementation(async (_request, value) => { callbacks = value; });
        await store.set(sendWSMessageAtom, "hello");
        const admission = store.get(threadAdmissionAtom);

        await callbacks.onRunComplete({ run_id: "unrelated" });

        expect(store.get(threadAdmissionAtom)).toBe(admission);
    });
    it("does not advance the saved tail on an acknowledgment rejected by admission", async () => {
        store.set(threadAdmissionAtom, { threadId: "t", tailRunId: "saved", activity: { state: "idle", run_id: null } });
        vi.mocked(agentRunService.getThreadRuns).mockResolvedValueOnce({
            runs: [], tail_run_id: "saved", activity: { state: "idle", run_id: null },
        });
        let callbacks: any;
        connectMock.mockImplementation(async (_request, value) => { callbacks = value; });
        await store.set(sendWSMessageAtom, "hello");
        const run = store.get(activeRunAtom)!;
        callbacks.onRequestAck({ runId: run.id });
        callbacks.onError({ event: "error", type: "thread_busy", message: "Busy", run_id: run.id });
        expect(store.get(threadAdmissionAtom)?.tailRunId).toBe("saved");
    });
    it.each(["changed", "busy", "offline"])("preserves the failed run when resume admission is %s", async (state) => {
        store.set(currentThreadIdAtom, null);
        store.set(selectedModelAtom, { name: "test-model", provider: "test" } as any);
        let callbacks: any;
        connectMock.mockImplementation(async (_request, value) => { callbacks = value; });
        await store.set(sendWSMessageAtom, "hello");
        const firstRun = store.get(activeRunAtom)!;
        callbacks.onRequestAck({ runId: firstRun.id });
        callbacks.onThread("new-thread");
        callbacks.onError({ event: "error", type: "llm_rate_limit", message: "Rate limited",
            run_id: firstRun.id, is_resumable: true });
        const failedRun = store.get(activeRunAtom);
        store.set(currentMessageContentAtom, "unsent draft");
        if (state === "offline") {
            vi.mocked(agentRunService.getThreadRuns).mockRejectedValueOnce(new Error("Offline"));
        } else {
            vi.mocked(agentRunService.getThreadRuns).mockResolvedValueOnce({
                runs: [], tail_run_id: state === "changed" ? "successor" : firstRun.id,
                activity: state === "busy" ? { state: "active", run_id: "other" } : { state: "idle", run_id: null },
            });
        }

        await store.set(resumeFromRunAtom, firstRun.id);

        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(store.get(activeRunAtom)).toBe(failedRun);
        expect(store.get(currentMessageContentAtom)).toBe("unsent draft");
        expect(presence.getSnapshot().claims).toHaveLength(0);
        if (state === "changed") expect(store.get(threadConflictAtom)).toBe("thread_tail_mismatch");
    });
    it("keeps unseen server history behind the send admission check after opening the menu", async () => {
        const admission = { threadId: "t", tailRunId: "displayed", activity: { state: "idle" as const, run_id: null } };
        store.set(threadAdmissionAtom, admission);
        const displayed = store.get(threadRunsAtom);
        const attachment = { key: "DRAFT", libraryID: 1 } as any;
        store.set(currentMessageItemsAtom, [attachment]);
        const unseen = { runs: [], agent_actions: [], tail_run_id: "unseen-successor", activity: { state: "idle" as const, run_id: null } };
        vi.mocked(agentRunService.getThreadRuns).mockResolvedValueOnce(unseen).mockResolvedValueOnce(unseen);

        await store.set(refreshFinishedChatAvailabilityAtom);
        expect(store.get(canOpenFinishedChatAtom)).toBe(true);
        expect(store.get(threadAdmissionAtom)).toBe(admission);
        expect(store.get(threadRunsAtom)).toBe(displayed);

        await store.set(sendWSMessageAtom, "hello");
        expect(connectMock).not.toHaveBeenCalled();
        expect(store.get(threadConflictAtom)).toBe("thread_tail_mismatch");
        expect(store.get(currentMessageContentAtom)).toBe("my draft");
        expect(store.get(currentMessageItemsAtom)).toEqual([attachment]);
        expect(store.get(threadRunsAtom)).toBe(displayed);
    });
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
