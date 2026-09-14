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

export interface AdmissionSnapshot {
    threadId: string;
    tailRunId: string | null;
    activity: ThreadActivity | { state: "unknown"; run_id: null };
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
    setAdmission(set, id, loaded.tailRunId, activity);
    if (activity.state === "active" || activity.state === "unknown")
        return false;
    set(threadRunsAtom, loaded.runs);
    set(activeRunAtom, null);
    set(threadAgentActionsAtom, loaded.agentActions ?? []);
    set(citationsAtom, loaded.citations);
    set(processCitationsAtom);
    set(
        viewedHistoryRevisionAtom,
        Zotero.Beaver?.presence?.getSnapshot().history[id] ?? 0,
    );
    return true;
}

/** Poll visible remote activity with bounded backoff; a failed read never means idle. */
export function attachThreadAdmission(runtime: WindowRuntime): void {
    let timer: number | undefined;
    let sequence = 0;
    let running = false;
    let delay = 500;
    const stop = () => {
        sequence++;
        if (timer !== undefined) runtime.hostWindow.clearTimeout(timer);
        timer = undefined;
    };
    const schedule = () => {
        if (
            timer !== undefined ||
            running ||
            !store.get(serverThreadBlockedAtom) ||
            runtime.status === "closing"
        )
            return;
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
        timer = runtime.hostWindow.setTimeout(async () => {
            timer = undefined;
            if (!current()) return;
            running = true;
            try {
                if (!currentWriter())
                    await reconcileThread(store.get, store.set, current);
            } catch {
                /* An unavailable server has not settled. */
            } finally {
                running = false;
                delay = Math.min(delay * 2, 5000);
                schedule();
            }
        }, delay);
    };
    const reset = () => {
        stop();
        delay = 500;
        store.set(threadAdmissionAtom, null);
        store.set(threadConflictAtom, null);
    };
    const removers = [
        store.sub(threadAdmissionAtom, schedule),
        store.sub(threadNavigationSeqAtom, reset),
        store.sub(accountGenerationAtom, reset),
    ];
    Zotero.Beaver.runtime.addWindowCleanup(runtime, () => {
        stop();
        removers.forEach((remove) => remove());
    });
}

/** Small admission updates share one shape; server activity retains its run id. */
export function setAdmission(
    set: Setter,
    threadId: string,
    tailRunId: string | null,
    activity: AdmissionSnapshot["activity"] | "idle" | "unknown",
): void {
    set(threadAdmissionAtom, {
        threadId,
        tailRunId,
        activity:
            typeof activity === "string"
                ? { state: activity, run_id: null }
                : activity,
    });
}

/** Validate raw capability metadata before normalizing history for presentation. */
export async function readAdmissionHistory(
    threadId: string,
    includeActions = false,
): Promise<
    ThreadRunsResponse & {
        tail_run_id: string | null;
        activity: ThreadActivity;
    }
> {
    const history = await agentRunService.getThreadRuns(
        threadId,
        includeActions,
    );
    if (history.tail_run_id === undefined || !history.activity) {
        throw new Error(
            "This server does not support safe concurrent chats. Update the server before continuing.",
        );
    }
    return {
        ...history,
        tail_run_id: history.tail_run_id,
        activity: history.activity,
    };
}

export async function readAdmission(
    threadId: string,
): Promise<AdmissionSnapshot> {
    const history = await readAdmissionHistory(threadId);
    return {
        threadId,
        tailRunId: history.tail_run_id,
        activity: history.activity,
    };
}
