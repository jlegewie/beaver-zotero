/**
 * What the run engine knows of the server's admission for the open chat: its
 * saved tail, whether a response is still running there, and why the chat
 * waits. A send asserts the tail; settlement reconciles saved history.
 *
 * The window polls a blocked chat's activity and words the wait
 * (`react/runtime/threadAdmission.ts`); both read and write this state in the
 * run session's store.
 */

import { atom } from "jotai/vanilla";
import type { Getter, Setter } from "jotai/vanilla";
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
import { citationsAtom } from "@beaver/agent-core/citations/atoms";
import {
    reattachResolutionAtom,
    replacementNotes,
    runReplacementNotesAtom,
} from "@beaver/agent-core/run-state/runResolution";
import { syncParkedCardsAtom } from "./parkedRuns";
import type { RunSession } from "./runSession";

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

/**
 * The chat whose activity reads have failed `UNREACHABLE_AFTER_FAILURES`
 * times in a row. The first successful read clears it.
 */
export const admissionUnreachableThreadAtom = atom<string | null>(null);

/** The revision of the chat's saved history that the session's runs reflect. */
export const viewedHistoryRevisionAtom = atom(0);

/** The reason recorded for `threadId`, so a fresh server read does not drop it. */
export function currentReason(
    get: Getter,
    threadId: string,
): AdmissionWaitReason | undefined {
    const snapshot = get(threadAdmissionAtom);
    return snapshot?.threadId === threadId ? snapshot.reason : undefined;
}

/**
 * Keep this window's unsaved failed and stopped runs in a chat through its
 * next reconcile, e.g. one stopped while it was reconnecting.
 */
export function keepLocalFailuresOnSettle(session: RunSession, threadId: string): void {
    session.settlingThreads.add(threadId);
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

/**
 * Refresh only persisted history. Composer state and navigation are untouched.
 * `get` and `set` are the session's store; the window's agent actions and
 * tool-return display are updated through its host.
 */
export async function reconcileThread(
    session: RunSession,
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
            await session.host.processToolReturn(part, guardedSet);
            if (isCurrent()) return session.host.upgradeToolReturn(part, args ?? null);
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
    const settling = session.settlingThreads.delete(id);
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
    // The saved history may end on a parked run, or no longer does.
    set(syncParkedCardsAtom);
    session.host.replaceAgentActions(
        set,
        loaded.agentActions ?? [],
        new Set([
            ...loaded.runs.map((run) => run.id),
            ...(keepLocal && local ? [local.id] : []),
        ]),
    );
    set(citationsAtom, loaded.citations);
    set(
        viewedHistoryRevisionAtom,
        Zotero.Beaver?.presence?.getSnapshot().history[id] ?? 0,
    );
    return true;
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
