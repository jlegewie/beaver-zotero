/**
 * Feature credits in one window's chat: the task whose setup card is open,
 * the task a sent message starts, the credits a request earned until its run
 * ends, and the reward cards shown under ended runs.
 *
 * Kept free of the action and agent-run atoms so both can import it.
 */
import { atom, type createStore } from 'jotai';
import { isRunActive, type PromptAction } from '@beaver/agent-core/agents/types';
import type { FeatureCreditGrant } from '@beaver/agent-core/protocol/agentProtocol';
import { activeRunAtom, currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { composerResetTokenAtom } from './messageComposition';
import { accountGenerationAtom } from './profile';
import { getFeatureCreditTask } from '../constants/featureCreditTasks';

type Store = ReturnType<typeof createStore>;

/** The id of the thread's run while it is active; changes only when that run starts or ends. */
const activeRunIdAtom = atom((get) => {
    const run = get(activeRunAtom);
    return isRunActive(run) ? run!.id : null;
});

const activeFeatureTaskStateAtom = atom<{ key: string; composerResetToken: number } | null>(null);

/**
 * The task whose setup card the home card shows in this window, or null for
 * the list. A setup belongs to the chat input it was started in: sending or
 * starting a new chat resets the input, which ends it.
 */
export const activeFeatureTaskAtom = atom(
    (get) => {
        const state = get(activeFeatureTaskStateAtom);
        return state && state.composerResetToken === get(composerResetTokenAtom) ? state.key : null;
    },
    (get, set, key: string | null) => {
        set(activeFeatureTaskStateAtom, key ? { key, composerResetToken: get(composerResetTokenAtom) } : null);
    },
);

/**
 * The feature task a message starts: the task whose setup card was open
 * (`setupTask`, read before the send resets the chat input, which ends the
 * setup), when the message runs that task's own action.
 */
export function featureTaskForMessage(setupTask: string | null, actions: PromptAction[]): string | undefined {
    const definition = setupTask ? getFeatureCreditTask(setupTask) : undefined;
    if (!definition) return undefined;
    return actions.some((action) => action.action_id === definition.actionId) ? definition.key : undefined;
}

/** Credits a request earned, kept until its run ends. */
export interface PendingFeatureCredit extends FeatureCreditGrant {
    runId: string;
}

/** Credits earned by requests this window sent whose runs have not ended, by run id. */
export const pendingFeatureCreditsAtom = atom<ReadonlyMap<string, PendingFeatureCredit>>(new Map());

/** A request acknowledgement said the request earned feature credits. */
export const recordFeatureCreditGrantAtom = atom(null, (get, set, grant: PendingFeatureCredit) => {
    const next = new Map(get(pendingFeatureCreditsAtom));
    next.set(grant.runId, grant);
    set(pendingFeatureCreditsAtom, next);
});

/**
 * Rewards to show under their runs, by run id: added when a run that earned
 * credits ends, removed when the user closes the card or leaves the chat. Kept
 * in memory only, so a chat loaded later shows none.
 */
export const earnedFeatureCreditsAtom = atom<ReadonlyMap<string, PendingFeatureCredit>>(new Map());

/** The user closed the reward card under a run. */
export const dismissEarnedFeatureCreditAtom = atom(null, (get, set, runId: string) => {
    const earned = get(earnedFeatureCreditsAtom);
    if (!earned.has(runId)) return;
    const next = new Map(earned);
    next.delete(runId);
    set(earnedFeatureCreditsAtom, next);
});

/**
 * Moves each earned grant to the reward cards once its run ends (finished,
 * failed or stopped: the credits were granted when the request was accepted),
 * and refreshes the profile so the task shows as done and the balance includes
 * the credits. Drops the cards when the window leaves the chat they are in.
 * Mount once per renderer; returns the unsubscribe function.
 */
export function watchFeatureCreditGrants(store: Store): () => void {
    let threadId = store.get(currentThreadIdAtom);
    const showEnded = () => {
        const pending = store.get(pendingFeatureCreditsAtom);
        if (pending.size === 0) return;
        const activeRunId = store.get(activeRunIdAtom);
        const earned = new Map(store.get(earnedFeatureCreditsAtom));
        const remaining = new Map<string, PendingFeatureCredit>();
        for (const [runId, grant] of pending) {
            if (runId === activeRunId) remaining.set(runId, grant);
            else earned.set(runId, grant);
        }
        if (remaining.size === pending.size) return;
        store.set(pendingFeatureCreditsAtom, remaining);
        store.set(earnedFeatureCreditsAtom, earned);
        void Zotero.Beaver?.account?.refresh(true).catch(() => {});
    };

    showEnded();
    const unsubscribers = [
        // The active run's id, not the run: it changes only when a run
        // starts or ends, not on every streamed update.
        store.sub(activeRunIdAtom, showEnded),
        store.sub(pendingFeatureCreditsAtom, showEnded),
        // A new chat gets its id during its first run, which keeps its cards;
        // leaving a chat for another (or a new one) drops them.
        store.sub(currentThreadIdAtom, () => {
            const previous = threadId;
            threadId = store.get(currentThreadIdAtom);
            if (previous === null || previous === threadId) return;
            showEnded();
            store.set(earnedFeatureCreditsAtom, new Map());
        }),
        // A reward card belongs to the account that earned it.
        store.sub(accountGenerationAtom, () => {
            store.set(pendingFeatureCreditsAtom, new Map());
            store.set(earnedFeatureCreditsAtom, new Map());
        }),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}
