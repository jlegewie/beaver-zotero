import { processToolReturnResults } from "../agents/toolResultProcessing";
import { upgradeToolReturn } from "../compat/legacyToolResults";
import { atom } from "jotai";
import type { Getter, Setter } from "jotai";
import {
    agentRunService,
    type ThreadActivity,
    type ThreadRunsResponse,
} from "@beaver/agent-core/transport/agentService";
import { loadThreadRuns } from "@beaver/agent-core/run-state/loadThreadRuns";
import type { AgentRun } from "@beaver/agent-core/agents/types";
import {
    currentThreadIdAtom,
    activeRunAtom,
    threadRunsAtom,
} from "@beaver/agent-core/run-state/atoms";
import {
    citationsAtom,
    processCitationsAtom,
} from "@beaver/agent-core/citations/atoms";
import { getCredentialGeneration } from "@beaver/agent-core/transport/credentials";
import { threadAgentActionsAtom } from "../agents/agentActions";
import { threadNavigationSeqAtom } from "../atoms/threads";
import { accountGenerationAtom } from "../atoms/profile";
import { store } from "../store";
import type { WindowRuntime } from "../../src/runtime/instance";
import { currentWriter } from "./threadWriter";
import { viewedHistoryRevisionAtom } from "./threadProjection";
import {
    REATTACH_RESOLUTION_WINDOW_MS,
    reattachResolutionAtom,
    replacementNotes,
    runReplacementNotesAtom,
} from "@beaver/agent-core/run-state/runResolution";

/**
 * Why this window is waiting for the server to settle a chat, when it knows:
 *
 * - `reattach_failed`: a run lost its connection and could not be picked up
 *   again, so its outcome is the server's to report.
 * - `stop_unconfirmed`: the user stopped a run while it was reconnecting, and
 *   the server has not confirmed the stop.
 * - `stopping_previous`: a retry stopped the running response and waits for
 *   the server to end it.
 */
export type AdmissionWaitReason =
    | "reattach_failed"
    | "stop_unconfirmed"
    | "stopping_previous";

export interface AdmissionSnapshot {
    threadId: string;
    tailRunId: string | null;
    /** A claimed run whose persistence has not been confirmed. */
    unconfirmedRunId?: string;
    activity: ThreadActivity | { state: "unknown"; run_id: null };
    /** Kept while the chat stays blocked; dropped once it is idle. */
    reason?: AdmissionWaitReason;
}
export const threadAdmissionAtom = atom<AdmissionSnapshot | null>(null);
export const threadConflictAtom = atom<string | null>(null);
export const serverThreadBlockedAtom = atom((get) => {
    const snapshot = get(threadAdmissionAtom);
    return (
        snapshot?.threadId === get(currentThreadIdAtom) &&
        (snapshot.activity.state === "active" ||
            snapshot.activity.state === "unknown")
    );
});

/** Consecutive failed activity reads before the chat reports the server unreachable. */
export const UNREACHABLE_AFTER_FAILURES = 5;
/**
 * Bound on each polled activity read, so a server that hangs rather than
 * refusing is reported unreachable within about 40 s.
 */
const POLL_TIMEOUT_MS = 5000;

/**
 * The chat whose activity reads have failed `UNREACHABLE_AFTER_FAILURES`
 * times in a row. The first successful read clears it.
 */
const admissionUnreachableThreadAtom = atom<string | null>(null);

/** The open chat is blocked and the server could not be reached to settle it. */
export const admissionUnreachableAtom = atom(
    (get) =>
        get(serverThreadBlockedAtom) &&
        get(admissionUnreachableThreadAtom) === get(currentThreadIdAtom),
);

/**
 * What the presence bar says while the open chat waits for the server.
 * "Still running" is only claimed once the server reported the run active.
 */
export function describeAdmissionWait(
    snapshot: Pick<AdmissionSnapshot, "activity" | "reason">,
    unreachable = false,
): string {
    if (unreachable) return "Beaver can't be reached. Check your connection.";
    switch (snapshot.reason) {
        case "stop_unconfirmed":
            return "Confirming the stop with Beaver…";
        case "stopping_previous":
            return "Stopping the previous response…";
        case "reattach_failed":
            if (snapshot.activity.state !== "active")
                return "Checking what happened to this response…";
    }
    return snapshot.activity.state === "active"
        ? "A response is still running in this chat"
        : "Checking whether a response is still running…";
}

/** The reason recorded for `threadId`, so a fresh server read does not drop it. */
function currentReason(
    get: Getter,
    threadId: string,
): AdmissionWaitReason | undefined {
    const snapshot = get(threadAdmissionAtom);
    return snapshot?.threadId === threadId ? snapshot.reason : undefined;
}

/**
 * A failed reattach in `threadId` that has shown "checking" for its whole
 * window: its card is back to the connection error, so the next failed read
 * already reports the server unreachable rather than "checking".
 */
function resolutionOverdue(threadId: string | null): boolean {
    const resolution = store.get(reattachResolutionAtom);
    return (
        resolution?.threadId === threadId &&
        Date.now() - resolution.since >= REATTACH_RESOLUTION_WINDOW_MS
    );
}

/** Poll the open chat's activity now, set by `attachThreadAdmission`. */
let pollAdmissionNow: (() => Promise<void>) | null = null;

/**
 * Re-read the open chat's activity immediately and restart the backoff.
 * Resolves once that read has finished.
 */
export function refreshThreadAdmission(): Promise<void> {
    return pollAdmissionNow?.() ?? Promise.resolve();
}

/**
 * Chats whose next reconcile settles a run this window lost track of. Their
 * local history may hold failed or stopped runs the server never saved.
 */
const settlingThreads = new Set<string>();

/**
 * Keep this window's unsaved failed and stopped runs in a chat through its
 * next reconcile, e.g. one stopped while it was reconnecting.
 */
export function keepLocalFailuresOnSettle(threadId: string): void {
    settlingThreads.add(threadId);
}

/**
 * Saved history with the local failed and stopped runs the server does not
 * have kept where they sit. Runs present in both take the saved copy.
 */
function mergeLocalFailures(local: AgentRun[], saved: AgentRun[]): AgentRun[] {
    const savedIds = new Set(saved.map((run) => run.id));
    const merged: AgentRun[] = [];
    let next = 0;
    for (const run of local) {
        if (savedIds.has(run.id)) {
            while (next < saved.length) {
                const savedRun = saved[next++];
                merged.push(savedRun);
                if (savedRun.id === run.id) break;
            }
        } else if (run.status === "error" || run.status === "canceled") {
            merged.push(run);
        }
    }
    return [...merged, ...saved.slice(next)];
}

/** Refresh only persisted history. Composer state and navigation are untouched. */
export async function reconcileThread(
    get: Getter,
    set: Setter,
    isCurrent: () => boolean,
    history?: ThreadRunsResponse,
): Promise<boolean> {
    const id = get(currentThreadIdAtom);
    if (!id) return false;
    const guardedSet = ((...args: any[]) =>
        isCurrent() ? (set as any)(...args) : undefined) as Setter;
    const loaded = await loadThreadRuns(id, {
        history,
        onToolReturn: async (part, args) => {
            if (!isCurrent()) return;
            await processToolReturnResults(part, guardedSet);
            if (isCurrent()) await upgradeToolReturn(part, args);
        },
    });
    if (!isCurrent() || get(currentThreadIdAtom) !== id) return false;
    const { activity } = loaded;
    setAdmission(
        set,
        id,
        loaded.tailRunId,
        activity,
        undefined,
        currentReason(get, id),
    );
    if (activity.state === "active" || activity.state === "unknown")
        return false;
    // A request whose connection failed before the server saved it exists
    // only here, and keeps its error card and Retry.
    const local = get(activeRunAtom);
    const keepLocal =
        local?.status === "error" &&
        local.error?.type === "connection_error" &&
        !loaded.runs.some((run) => run.id === local.id);
    const settling = settlingThreads.delete(id);
    if (settling) {
        // Say so where the server's copy replaces a run this window showed
        // as failed or stopped with a completed one.
        const shown = local
            ? [...get(threadRunsAtom), local]
            : get(threadRunsAtom);
        const notes = replacementNotes(shown, loaded.runs);
        if (notes.size > 0)
            set(
                runReplacementNotesAtom,
                (previous) => new Map([...previous, ...notes]),
            );
    }
    if (get(reattachResolutionAtom)?.threadId === id)
        set(reattachResolutionAtom, null);
    set(
        threadRunsAtom,
        settling
            ? mergeLocalFailures(get(threadRunsAtom), loaded.runs)
            : loaded.runs,
    );
    if (!keepLocal) set(activeRunAtom, null);
    set(threadAgentActionsAtom, loaded.agentActions ?? []);
    set(citationsAtom, loaded.citations);
    set(processCitationsAtom);
    set(
        viewedHistoryRevisionAtom,
        Zotero.Beaver?.presence?.getSnapshot().history[id] ?? 0,
    );
    return true;
}

/**
 * Poll visible remote activity with bounded backoff; a failed read never means
 * idle. After `UNREACHABLE_AFTER_FAILURES` failed reads in a row the chat is
 * reported unreachable, and polling goes on until a read succeeds.
 */
export function attachThreadAdmission(runtime: WindowRuntime): void {
    let timer: number | undefined;
    let sequence = 0;
    let inFlight: Promise<void> | null = null;
    let delay = 500;
    let failures = 0;
    const stop = () => {
        sequence++;
        if (timer !== undefined) runtime.hostWindow.clearTimeout(timer);
        timer = undefined;
    };
    const blocked = () =>
        store.get(serverThreadBlockedAtom) && runtime.status !== "closing";
    /** Whether a poll started now still speaks for the open chat when it ends. */
    const capture = () => {
        const token = sequence;
        const generation = getCredentialGeneration();
        const navigation = store.get(threadNavigationSeqAtom);
        const id = store.get(currentThreadIdAtom);
        const current = () =>
            token === sequence &&
            runtime.status !== "closing" &&
            generation === getCredentialGeneration() &&
            navigation === store.get(threadNavigationSeqAtom) &&
            id === store.get(currentThreadIdAtom);
        return { id, current };
    };
    const poll = ({ id, current }: ReturnType<typeof capture>) => {
        const read = async () => {
            try {
                // Poll the cheap activity read, and load the history only
                // once the server no longer reports the thread active.
                if (!currentWriter() && id) {
                    const snapshot = await readAdmission(id, POLL_TIMEOUT_MS);
                    if (current() && !currentWriter()) {
                        if (snapshot.activity.state === "active")
                            setAdmission(
                                store.set,
                                id,
                                snapshot.tailRunId,
                                snapshot.activity,
                                undefined,
                                currentReason(store.get, id),
                            );
                        else
                            await reconcileThread(store.get, store.set, current);
                    }
                    if (current()) {
                        failures = 0;
                        if (store.get(admissionUnreachableThreadAtom) !== null)
                            store.set(admissionUnreachableThreadAtom, null);
                    }
                }
            } catch {
                /* An unavailable server has not settled. */
                if (
                    current() &&
                    (++failures >= UNREACHABLE_AFTER_FAILURES ||
                        resolutionOverdue(id))
                )
                    store.set(admissionUnreachableThreadAtom, id);
            }
        };
        // Settled in a later microtask, so `inFlight` is assigned first even
        // when the read returns without awaiting (e.g. while this window
        // writes to the chat).
        const pending: Promise<void> = read().finally(() => {
            if (inFlight === pending) inFlight = null;
            delay = Math.min(delay * 2, 5000);
            schedule();
        });
        inFlight = pending;
        return pending;
    };
    const schedule = () => {
        if (!blocked() && !inFlight) {
            // Each wait starts from a quick first read and a clean count.
            delay = 500;
            failures = 0;
            if (store.get(admissionUnreachableThreadAtom) !== null)
                store.set(admissionUnreachableThreadAtom, null);
        }
        if (timer !== undefined || inFlight || !blocked()) return;
        const context = capture();
        timer = runtime.hostWindow.setTimeout(() => {
            timer = undefined;
            if (!context.current()) return;
            void poll(context);
        }, delay);
    };
    pollAdmissionNow = () => {
        if (inFlight) return inFlight;
        if (!blocked()) return Promise.resolve();
        stop();
        delay = 500;
        return poll(capture());
    };
    const reset = () => {
        stop();
        delay = 500;
        failures = 0;
        settlingThreads.clear();
        store.set(threadAdmissionAtom, null);
        store.set(threadConflictAtom, null);
        store.set(admissionUnreachableThreadAtom, null);
        store.set(reattachResolutionAtom, null);
        store.set(runReplacementNotesAtom, new Map());
    };
    const removers = [
        store.sub(threadAdmissionAtom, schedule),
        store.sub(threadNavigationSeqAtom, reset),
        store.sub(accountGenerationAtom, reset),
    ];
    Zotero.Beaver.runtime.addWindowCleanup(runtime, () => {
        stop();
        pollAdmissionNow = null;
        removers.forEach((remove) => remove());
    });
}

/** Small admission updates share one shape; server activity retains its run id. */
export function setAdmission(
    set: Setter,
    threadId: string,
    tailRunId: string | null,
    activity: AdmissionSnapshot["activity"] | "idle" | "unknown",
    unconfirmedRunId?: string,
    reason?: AdmissionWaitReason,
): void {
    const state = typeof activity === "string" ? activity : activity.state;
    set(threadAdmissionAtom, {
        threadId,
        tailRunId,
        ...(unconfirmedRunId ? { unconfirmedRunId } : {}),
        activity:
            typeof activity === "string"
                ? { state: activity, run_id: null }
                : activity,
        ...(reason && (state === "active" || state === "unknown")
            ? { reason }
            : {}),
    });
}

type AdmissionHistory = ThreadRunsResponse & {
    tail_run_id: string | null;
    activity: ThreadActivity;
};

const ADMISSION_UNSUPPORTED_MESSAGE =
    "This server does not support safe concurrent chats. Update the server before continuing.";

/** Validate raw capability metadata before normalizing history for presentation. */
export async function readAdmissionHistory(
    threadId: string,
    includeActions = false,
): Promise<AdmissionHistory> {
    const history = await agentRunService.getThreadRuns(
        threadId,
        includeActions,
    );
    if (history.tail_run_id === undefined || !history.activity) {
        throw new Error(ADMISSION_UNSUPPORTED_MESSAGE);
    }
    return history as AdmissionHistory;
}

/** Read a thread's tail and activity without loading its history. */
export async function readAdmission(
    threadId: string,
    timeoutMs?: number,
): Promise<AdmissionSnapshot> {
    const snapshot = await agentRunService.getThreadActivity(threadId, timeoutMs);
    if (snapshot.tail_run_id === undefined || !snapshot.activity) {
        throw new Error(ADMISSION_UNSUPPORTED_MESSAGE);
    }
    return {
        threadId,
        tailRunId: snapshot.tail_run_id,
        activity: snapshot.activity,
    };
}
