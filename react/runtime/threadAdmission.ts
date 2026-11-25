/**
 * The window's side of admission: it polls a blocked chat's activity until
 * the server settles it, and words the wait for the presence bar.
 */

import { atom } from "jotai";
import { getCredentialGeneration } from "@beaver/agent-core/transport/credentials";
import { currentThreadIdAtom } from "@beaver/agent-core/run-state/atoms";
import {
    REATTACH_RESOLUTION_WINDOW_MS,
    reattachResolutionAtom,
    runReplacementNotesAtom,
} from "@beaver/agent-core/run-state/runResolution";
import { threadNavigationSeqAtom } from "../atoms/threads";
import { accountGenerationAtom } from "../atoms/profile";
import { store } from "../store";
import type { WindowRuntime } from "../../src/runtime/instance";
import { currentWriter } from "../../src/services/agentRuns/threadWriter";
import { getRunSession } from "../../src/services/agentRuns/runSession";
import {
    admissionUnreachableThreadAtom,
    currentReason,
    readAdmission,
    reconcileThread,
    serverThreadBlockedAtom,
    setAdmission,
    threadAdmissionAtom,
    threadConflictAtom,
    type AdmissionSnapshot,
} from "../../src/services/agentRuns/threadAdmission";

/** Consecutive failed activity reads before the chat reports the server unreachable. */
export const UNREACHABLE_AFTER_FAILURES = 5;
/**
 * Bound on each polled activity read, so a server that hangs rather than
 * refusing is reported unreachable within about 40 s.
 */
const POLL_TIMEOUT_MS = 5000;

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
                if (!currentWriter(getRunSession()) && id) {
                    const snapshot = await readAdmission(id, POLL_TIMEOUT_MS);
                    const session = getRunSession();
                    if (current() && !currentWriter(session)) {
                        if (snapshot.activity.state === "active")
                            setAdmission(
                                session.store.set,
                                id,
                                snapshot.tailRunId,
                                snapshot.activity,
                                undefined,
                                currentReason(session.store.get, id),
                            );
                        else
                            await reconcileThread(session, session.store.get, session.store.set, current);
                    }
                    if (current()) {
                        failures = 0;
                        if (session.store.get(admissionUnreachableThreadAtom) !== null)
                            session.store.set(admissionUnreachableThreadAtom, null);
                    }
                }
            } catch {
                /* An unavailable server has not settled. */
                if (
                    current() &&
                    (++failures >= UNREACHABLE_AFTER_FAILURES ||
                        resolutionOverdue(id))
                )
                    getRunSession().store.set(admissionUnreachableThreadAtom, id);
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
            const chat = getRunSession().store;
            if (chat.get(admissionUnreachableThreadAtom) !== null)
                chat.set(admissionUnreachableThreadAtom, null);
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
        getRunSession().settlingThreads.clear();
        const chat = getRunSession().store;
        chat.set(threadAdmissionAtom, null);
        chat.set(threadConflictAtom, null);
        chat.set(admissionUnreachableThreadAtom, null);
        chat.set(reattachResolutionAtom, null);
        chat.set(runReplacementNotesAtom, new Map());
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

