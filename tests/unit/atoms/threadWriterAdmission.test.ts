import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionFailureEvidence } from "@beaver/agent-core/transport/connectionFailure";

const {
    connectMock,
    closeMock,
    resolveClientIdentityMock,
    reportConnectionFailureMock,
} = vi.hoisted(() => ({
    connectMock: vi.fn(),
    closeMock: vi.fn(),
    resolveClientIdentityMock: vi.fn(),
    reportConnectionFailureMock: vi.fn().mockResolvedValue(undefined),
}));

// A stand-in for the service, and a stand-in class that the retry loop's
// `instanceof` check still narrows against: the mocked specifier and the loop's
// own relative import resolve to one module, so both see this same class.
vi.mock("@beaver/agent-core/transport/agentService", () => ({
    agentService: {
        connect: connectMock,
        close: closeMock,
        cancel: vi.fn(),
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
import { viewedHistoryRevisionAtom } from "../../../react/runtime/threadProjection";
import {
    clearClientShutDownLatch,
    closeWSConnectionForShutdownAtom,
    retryPendingRunIdAtom,
} from "../../../react/atoms/agentRunAtoms";
const runtime = { id: "a", status: "ready", hostWindow: {} } as any;
initializeWindowRuntime(runtime);
let presence: ThreadPresence;
beforeEach(() => {
    releaseWriter();
    vi.clearAllMocks();
    clearClientShutDownLatch();
    presence = new ThreadPresence();
    presence.reset(getCredentialGeneration());
    (Zotero as any).Beaver = {
        presence,
        threads: { invalidateViews: vi.fn(), patchThread: vi.fn() },
    };
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
        resolve();
        await sending;
        expect(presence.owns(successor)).toBe(true);
        expect(store.get(viewedHistoryRevisionAtom)).toBe(0);
    });
});
