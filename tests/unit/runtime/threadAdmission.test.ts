import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStore } from "jotai";
const state = vi.hoisted(() => ({
    store: undefined as any,
    cleanup: undefined as any,
    history: vi.fn(),
    generation: 0,
}));
vi.mock("../../../react/store", () => ({
    store: {
        get: (...a: any[]) => state.store.get(...a),
        set: (...a: any[]) => state.store.set(...a),
        sub: (...a: any[]) => state.store.sub(...a),
    },
}));
vi.mock("../../../react/atoms/threads", async () => ({
    threadNavigationSeqAtom: (await import("jotai")).atom(0),
}));
vi.mock("../../../react/atoms/profile", async () => ({
    accountGenerationAtom: (await import("jotai")).atom(0),
}));
vi.mock("../../../react/runtime/threadProjection", async () => ({
    viewedHistoryRevisionAtom: (await import("jotai")).atom(0),
}));
vi.mock("../../../react/runtime/threadWriter", () => ({
    currentWriter: () => undefined,
}));
vi.mock("../../../react/agents/agentActions", async () => ({
    threadAgentActionsAtom: (await import("jotai")).atom([]),
}));
vi.mock("../../../react/agents/toolResultProcessing", () => ({
    processToolReturnResults: vi.fn(),
}));
vi.mock("../../../react/compat/legacyToolResults", () => ({
    upgradeToolReturn: vi.fn(),
}));
vi.mock("@beaver/agent-core/transport/credentials", () => ({
    getCredentialGeneration: () => state.generation,
}));
vi.mock("@beaver/agent-core/run-state/loadThreadRuns", () => ({
    loadThreadRuns: state.history,
}));
vi.mock("@beaver/agent-core/transport/agentService", () => ({
    agentRunService: { getThreadRuns: state.history },
}));
import {
    attachThreadAdmission,
    threadAdmissionAtom,
    serverThreadBlockedAtom,
} from "../../../react/runtime/threadAdmission";
import {
    currentThreadIdAtom,
    threadRunsAtom,
} from "@beaver/agent-core/run-state/atoms";
import { threadNavigationSeqAtom } from "../../../react/atoms/threads";

beforeEach(() => {
    vi.useFakeTimers();
    state.store = createStore();
    state.generation = 0;
    state.history.mockReset();
    (Zotero as any).Beaver = {
        runtime: {
            addWindowCleanup: (_r: any, fn: any) => {
                state.cleanup = fn;
            },
        },
        presence: { getSnapshot: () => ({ history: {} }) },
    };
    attachThreadAdmission({
        id: "test",
        status: "ready",
        hostWindow: { setTimeout, clearTimeout },
    } as any);
    state.store.set(currentThreadIdAtom, "thread");
    state.store.set(threadAdmissionAtom, {
        threadId: "thread",
        tailRunId: "old",
        activity: { state: "active", run_id: "reserved" },
    });
});
afterEach(() => {
    state.cleanup();
    vi.useRealTimers();
});
it("backs off through busy activity and reconciles only after settlement", async () => {
    state.history.mockResolvedValueOnce({
        runs: [],
        citations: [],
        agentActions: [],
        tailRunId: "old",
        activity: { state: "active", run_id: "reserved" },
    });
    state.history.mockResolvedValueOnce({
        runs: [],
        citations: [],
        agentActions: [],
        tailRunId: "new",
        activity: { state: "idle", run_id: null },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(state.store.get(serverThreadBlockedAtom)).toBe(true);
    expect(state.history).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(state.history).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.store.get(serverThreadBlockedAtom)).toBe(false);
    expect(state.store.get(threadAdmissionAtom).tailRunId).toBe("new");
    await vi.advanceTimersByTimeAsync(10000);
    expect(state.history).toHaveBeenCalledTimes(2);
});
it("does not treat a failed read as idle and stops all timers on detach", async () => {
    state.history.mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(500);
    expect(state.store.get(serverThreadBlockedAtom)).toBe(true);
    state.cleanup();
    await vi.advanceTimersByTimeAsync(20000);
    expect(state.history).toHaveBeenCalledTimes(1);
});
it.each(["navigation", "account"])(
    "rejects a late response after %s changes",
    async (change) => {
        let finish!: (data: any) => void;
        state.history.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        await vi.advanceTimersByTimeAsync(500);
        if (change === "navigation")
            state.store.set(threadNavigationSeqAtom, 1);
        else state.generation++;
        finish({
            runs: [{ id: "late" }],
            citations: [],
            agentActions: [],
            tailRunId: "late",
            activity: { state: "idle", run_id: null },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(state.store.get(threadRunsAtom)).toEqual([]);
        expect(state.store.get(threadAdmissionAtom)?.tailRunId).not.toBe(
            "late",
        );
    },
);
