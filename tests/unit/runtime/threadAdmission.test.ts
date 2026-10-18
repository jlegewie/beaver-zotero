import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStore } from "jotai";
const state = vi.hoisted(() => ({
    store: undefined as any,
    cleanup: undefined as any,
    history: vi.fn(),
    activity: vi.fn(),
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
    agentRunService: { getThreadActivity: state.activity },
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
    state.activity.mockReset();
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
const busy = { tail_run_id: "old", activity: { state: "active", run_id: "reserved" } };
const settled = {
    runs: [],
    citations: [],
    agentActions: [],
    tailRunId: "new",
    activity: { state: "idle", run_id: null },
};
it("polls activity with backoff and loads the history once after settlement", async () => {
    state.activity
        .mockResolvedValueOnce(busy)
        .mockResolvedValueOnce({ tail_run_id: "new", activity: { state: "idle", run_id: null } });
    state.history.mockResolvedValueOnce(settled);
    await vi.advanceTimersByTimeAsync(500);
    expect(state.activity).toHaveBeenCalledWith("thread");
    expect(state.store.get(serverThreadBlockedAtom)).toBe(true);
    expect(state.history).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(state.activity).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.activity).toHaveBeenCalledTimes(2);
    expect(state.history).toHaveBeenCalledTimes(1);
    expect(state.store.get(serverThreadBlockedAtom)).toBe(false);
    expect(state.store.get(threadAdmissionAtom).tailRunId).toBe("new");
    await vi.advanceTimersByTimeAsync(10000);
    expect(state.activity).toHaveBeenCalledTimes(2);
    expect(state.history).toHaveBeenCalledTimes(1);
});
it("records the busy tail without loading history", async () => {
    state.activity.mockResolvedValueOnce({ ...busy, tail_run_id: "running" });
    await vi.advanceTimersByTimeAsync(500);
    expect(state.store.get(threadAdmissionAtom)).toMatchObject({
        threadId: "thread",
        tailRunId: "running",
        activity: { state: "active", run_id: "reserved" },
    });
    expect(state.history).not.toHaveBeenCalled();
});
it("keeps polling when the history load finds the thread active again", async () => {
    state.activity.mockResolvedValue({ tail_run_id: "old", activity: { state: "idle", run_id: null } });
    state.history
        .mockResolvedValueOnce({ ...settled, tailRunId: "old", activity: { state: "active", run_id: "next" } })
        .mockResolvedValueOnce(settled);
    await vi.advanceTimersByTimeAsync(500);
    expect(state.store.get(serverThreadBlockedAtom)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.history).toHaveBeenCalledTimes(2);
    expect(state.store.get(serverThreadBlockedAtom)).toBe(false);
});
it("does not treat a failed read as idle and stops all timers on detach", async () => {
    state.activity.mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(500);
    expect(state.store.get(serverThreadBlockedAtom)).toBe(true);
    expect(state.history).not.toHaveBeenCalled();
    state.cleanup();
    await vi.advanceTimersByTimeAsync(20000);
    expect(state.activity).toHaveBeenCalledTimes(1);
});
it("treats a server without admission metadata as unsettled", async () => {
    state.activity.mockResolvedValue({});
    await vi.advanceTimersByTimeAsync(500);
    expect(state.store.get(serverThreadBlockedAtom)).toBe(true);
    expect(state.history).not.toHaveBeenCalled();
});
it.each(["navigation", "account"])(
    "ignores a late activity read after %s changes",
    async (change) => {
        let finish!: (data: any) => void;
        state.activity.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        await vi.advanceTimersByTimeAsync(500);
        if (change === "navigation")
            state.store.set(threadNavigationSeqAtom, 1);
        else state.generation++;
        finish({ tail_run_id: "late", activity: { state: "active", run_id: "late" } });
        await vi.advanceTimersByTimeAsync(0);
        expect(state.history).not.toHaveBeenCalled();
        expect(state.store.get(threadAdmissionAtom)?.tailRunId).not.toBe(
            "late",
        );
    },
);
it.each(["navigation", "account"])(
    "rejects a late history response after %s changes",
    async (change) => {
        state.activity.mockResolvedValue({ tail_run_id: "old", activity: { state: "idle", run_id: null } });
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
