import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobResult } from "@beaver/agent-core/protocol/jobCallProtocol";
import {
    InstanceJobCalls,
    RETRY_FIRST_MS,
    type JobCallDeps,
    type JobCallEntry,
    type PostOutcome,
} from "../../../src/services/jobCalls/service";

function fillResult(jobId = "job-1"): JobResult {
    return {
        kind: "table_fill",
        job_id: jobId,
        status: "done",
        progress: { state: "done", rows_total: 2, rows_done: 2, rows_failed: 0, in_flight: 0, credits_charged: 0.4, credits_planned: 0.4, seconds_left: null },
        result: {
            rows_answered: 2, answered: 4, not_reported: 0, from_title_abstract: 0, documents_read: 2, credits_charged: 0.4,
            row_failures: {}, failed_row_ids: [], not_started: {}, not_written: 0, skipped_cells: {}, pending: null,
        },
    };
}

function harness(options: { stored?: JobCallEntry[]; live?: Set<string>; userId?: string | null; unsendable?: boolean; ready?: boolean } = {}) {
    let ready = options.ready ?? true;
    const rows = new Map<string, JobCallEntry>();
    for (const entry of options.stored ?? []) rows.set(`${entry.threadId}/${entry.toolCallId}`, entry);
    const outcomes: PostOutcome[] = [];
    const posted: { entry: JobCallEntry; result: JobResult }[] = [];
    const stored = vi.fn();
    let user: string | null = options.userId === undefined ? "user-1" : options.userId;
    let accountListener: (() => void) | undefined;
    let now = Date.parse("2026-11-15T12:00:00Z");
    const deps: JobCallDeps = {
        storage: {
            upsert: async (entry) => void rows.set(`${entry.threadId}/${entry.toolCallId}`, entry),
            setResult: async (entry, result) => void rows.set(`${entry.threadId}/${entry.toolCallId}`, { ...entry, result }),
            delete: async (entry) => void rows.delete(`${entry.threadId}/${entry.toolCallId}`),
            list: async () => [...rows.values()],
        },
        post: async (entry, result) => {
            posted.push({ entry, result });
            const next = outcomes.shift() ?? "stored";
            if (next === ("throw" as PostOutcome)) throw new Error("network");
            return next;
        },
        userId: () => user,
        ready: () => ready,
        subscribeAccount: (listener) => {
            accountListener = listener;
            return () => (accountListener = undefined);
        },
        isLive: (_kind, jobId) => options.live?.has(jobId) ?? false,
        deriveInterrupted: async (entry) => ({ ...fillResult(entry.jobId), interrupted: true }),
        sendable: (_entry, result) => (options.unsendable ? null : result),
        onStored: stored,
        shuttingDown: () => false,
        setTimer: (callback, ms) => setTimeout(callback, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        now: () => now,
        log: () => {},
    };
    const service = new InstanceJobCalls(deps);
    return {
        service,
        rows,
        outcomes,
        posted,
        stored,
        signIn: (id: string | null) => {
            user = id;
            accountListener?.();
        },
        scopeReady: () => {
            ready = true;
            accountListener?.();
        },
        advance: (ms: number) => (now += ms),
    };
}

function entry(overrides: Partial<JobCallEntry> = {}): JobCallEntry {
    return {
        threadId: "thread-1",
        toolCallId: "call-1",
        userId: "user-1",
        kind: "table_fill",
        jobId: "job-1",
        coverage: { title: "Trials" },
        result: null,
        createdAt: "2026-11-15T11:00:00Z",
        ...overrides,
    };
}

describe("the job-call list", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it("keeps a job call, stores its result when the job ends, and announces it", async () => {
        const h = harness();
        await h.service.start();
        await h.service.register({ threadId: "thread-1", toolCallId: "call-1", kind: "table_fill", jobId: "job-1", coverage: { title: "Trials" } });
        expect(h.rows.size).toBe(1);
        await h.service.jobEnded("table_fill", "job-1", fillResult());
        await vi.runAllTimersAsync();
        expect(h.posted).toHaveLength(1);
        expect(h.posted[0].entry).toMatchObject({ threadId: "thread-1", toolCallId: "call-1" });
        expect(h.stored).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-1", toolCallId: "call-1", jobId: "job-1", kind: "table_fill" }));
        expect(h.rows.size).toBe(0);
    });

    it("retries a busy result with backoff, then drops it when the call is gone", async () => {
        const h = harness();
        await h.service.start();
        await h.service.register({ threadId: "thread-1", toolCallId: "call-1", kind: "table_fill", jobId: "job-1", coverage: {} });
        h.outcomes.push("busy", "gone");
        await h.service.jobEnded("table_fill", "job-1", fillResult());
        await vi.advanceTimersByTimeAsync(0);
        expect(h.posted).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS - 1);
        expect(h.posted).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.posted).toHaveLength(2);
        expect(h.stored).not.toHaveBeenCalled();
        expect(h.rows.size).toBe(0);
    });

    it("retries a network failure", async () => {
        const h = harness();
        await h.service.start();
        await h.service.register({ threadId: "thread-1", toolCallId: "call-1", kind: "table_fill", jobId: "job-1", coverage: {} });
        h.outcomes.push("throw" as PostOutcome, "stored");
        await h.service.jobEnded("table_fill", "job-1", fillResult());
        await vi.advanceTimersByTimeAsync(RETRY_FIRST_MS);
        expect(h.posted).toHaveLength(2);
        expect(h.stored).toHaveBeenCalledTimes(1);
    });

    it("a run that ends on the thread retries a busy result at once", async () => {
        const h = harness();
        await h.service.start();
        await h.service.register({ threadId: "thread-1", toolCallId: "call-1", kind: "table_fill", jobId: "job-1", coverage: {} });
        h.outcomes.push("busy", "stored");
        await h.service.jobEnded("table_fill", "job-1", fillResult());
        await vi.advanceTimersByTimeAsync(0);
        h.service.retryThread("thread-1");
        await vi.advanceTimersByTimeAsync(0);
        expect(h.posted).toHaveLength(2);
        expect(h.stored).toHaveBeenCalledTimes(1);
    });

    it("drops a call whose result reached its run live, without posting", async () => {
        const h = harness();
        await h.service.start();
        await h.service.register({ threadId: "thread-1", toolCallId: "call-1", kind: "table_fill", jobId: "job-1", coverage: {} });
        h.service.delivered("thread-1", "call-1");
        await h.service.jobEnded("table_fill", "job-1", fillResult());
        await vi.runAllTimersAsync();
        expect(h.posted).toHaveLength(0);
        expect(h.rows.size).toBe(0);
    });

    it("at startup, posts a result kept from before a quit", async () => {
        const h = harness({ stored: [entry({ result: fillResult() })] });
        await h.service.start();
        await vi.runAllTimersAsync();
        expect(h.posted).toHaveLength(1);
        expect(h.stored).toHaveBeenCalledTimes(1);
    });

    it("at startup, derives an interrupted result for a job no longer running", async () => {
        const h = harness({ stored: [entry()] });
        await h.service.start();
        await vi.runAllTimersAsync();
        expect(h.posted[0].result).toMatchObject({ interrupted: true, job_id: "job-1" });
    });

    it("at startup, waits for the library scope before deriving and posting", async () => {
        const h = harness({ stored: [entry()], ready: false });
        await h.service.start();
        await vi.runAllTimersAsync();
        expect(h.posted).toHaveLength(0);
        expect(h.rows.size).toBe(1);
        h.scopeReady();
        await vi.runAllTimersAsync();
        expect(h.posted[0].result).toMatchObject({ interrupted: true, job_id: "job-1" });
    });

    it("at startup, leaves a job that is still running alone", async () => {
        const h = harness({ stored: [entry()], live: new Set(["job-1"]) });
        await h.service.start();
        await vi.runAllTimersAsync();
        expect(h.posted).toHaveLength(0);
        expect(h.rows.size).toBe(1);
    });

    it("keeps an old entry until the endpoint answers for it", async () => {
        const h = harness({ stored: [entry({ createdAt: "2026-10-01T00:00:00Z", result: fillResult() })] });
        await h.service.start();
        await vi.runAllTimersAsync();
        expect(h.posted).toHaveLength(1);
    });

    it("drops, unposted, a kept result that may no longer leave the device", async () => {
        const h = harness({ stored: [entry({ result: fillResult() })], unsendable: true });
        await h.service.start();
        await vi.runAllTimersAsync();
        expect(h.posted).toHaveLength(0);
        expect(h.rows.size).toBe(0);
    });

    it("posts another account's result only once that account signs in again", async () => {
        const h = harness({ stored: [entry({ userId: "user-2", result: fillResult() })] });
        await h.service.start();
        await vi.runAllTimersAsync();
        expect(h.posted).toHaveLength(0);
        h.signIn("user-2");
        await vi.runAllTimersAsync();
        expect(h.posted).toHaveLength(1);
    });

    it("keeps a result at shutdown instead of posting it", async () => {
        const h = harness();
        await h.service.start();
        await h.service.register({ threadId: "thread-1", toolCallId: "call-1", kind: "table_fill", jobId: "job-1", coverage: {} });
        await h.service.dispose();
        await h.service.jobEnded("table_fill", "job-1", fillResult());
        await vi.runAllTimersAsync();
        expect(h.posted).toHaveLength(0);
        expect(h.rows.get("thread-1/call-1")?.result).toMatchObject({ job_id: "job-1" });
    });
});

describe("the windows waiting on a job", () => {
    it("tells every window which jobs some window waits on, until it stops or closes", () => {
        const waiters = vi.fn();
        const service = new InstanceJobCalls({ onWaitersChanged: waiters } as unknown as JobCallDeps);
        service.setWaiting("window-1", "job-1");
        service.setWaiting("window-2", "job-1");
        expect(service.waitedJobs()).toEqual(["job-1"]);
        service.setWaiting("window-1", null);
        expect(service.waitedJobs()).toEqual(["job-1"]);
        service.setWaiting("window-2", null);
        expect(service.waitedJobs()).toEqual([]);
        expect(waiters.mock.calls.map(([ids]) => ids)).toEqual([["job-1"], ["job-1"], ["job-1"], []]);
        // An unchanged wait tells nobody.
        service.setWaiting("window-2", null);
        expect(waiters).toHaveBeenCalledTimes(4);
    });
});
