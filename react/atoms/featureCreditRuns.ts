/**
 * Feature credits in one window's chat: the task whose setup card is open,
 * the task a sent message starts, and the credits a request earned until its
 * run ends.
 *
 * Kept free of the action and agent-run atoms so both can import it.
 */
import { atom, type createStore } from 'jotai';
import type { PromptAction } from '@beaver/agent-core/agents/types';
import type { FeatureCreditGrant } from '@beaver/agent-core/protocol/agentProtocol';
import { activeRunIdAtom } from '@beaver/agent-core/run-state/tableChatFills';
import { composerResetTokenAtom } from './messageComposition';
import { accountGenerationAtom } from './profile';
import { removePopupMessagesByTypeAtom } from './ui';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { getFeatureCreditTask } from '../constants/featureCreditTasks';

type Store = ReturnType<typeof createStore>;

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
 * Shows the completion card in this window once the run behind each earned
 * grant ends (finished, failed or stopped: the credits were granted when the
 * request was accepted), and refreshes the profile so the task shows as done
 * and the balance includes the credits. Mount once per renderer; returns the
 * unsubscribe function.
 */
export function watchFeatureCreditGrants(store: Store): () => void {
    const showEnded = () => {
        const pending = store.get(pendingFeatureCreditsAtom);
        if (pending.size === 0) return;
        const activeRunId = store.get(activeRunIdAtom);
        const ended: PendingFeatureCredit[] = [];
        const remaining = new Map<string, PendingFeatureCredit>();
        for (const [runId, grant] of pending) {
            if (runId === activeRunId) remaining.set(runId, grant);
            else ended.push(grant);
        }
        if (ended.length === 0) return;
        store.set(pendingFeatureCreditsAtom, remaining);
        for (const grant of ended) {
            store.set(addPopupMessageAtom, {
                id: `feature-credit-${grant.key}`,
                type: 'feature_credit',
                expire: false,
                featureCredit: { key: grant.key, credits: grant.credits, runId: grant.runId },
            });
        }
        void Zotero.Beaver?.account?.refresh(true).catch(() => {});
    };

    showEnded();
    const unsubscribers = [
        // The active run's id, not the run: it changes only when a run
        // starts or ends, not on every streamed update.
        store.sub(activeRunIdAtom, showEnded),
        store.sub(pendingFeatureCreditsAtom, showEnded),
        // A reward card belongs to the account that earned it.
        store.sub(accountGenerationAtom, () => {
            store.set(pendingFeatureCreditsAtom, new Map());
            store.set(removePopupMessagesByTypeAtom, ['feature_credit']);
        }),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}
