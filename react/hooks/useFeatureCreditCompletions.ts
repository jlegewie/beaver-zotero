import { useEffect } from 'react';
import { useStore } from 'jotai';
import { activeRunIdAtom, chatFillsAtom } from '@beaver/agent-core/run-state/tableChatFills';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { accountGenerationAtom, profileWithPlanAtom } from '../atoms/profile';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { removePopupMessagesByTypeAtom } from '../atoms/ui';
import { getFeatureCreditTask } from '../constants/featureCreditTasks';
import { FeatureCreditCompletionTracker } from '../utils/featureCredits';

/**
 * Shows a feature-credit completion card in this window when a task is
 * earned in the chat open here (or left within the last minute). The card
 * waits until that chat is idle: no response running and no table fill.
 * Mount once per renderer.
 */
export function useFeatureCreditCompletions(): void {
    const store = useStore();
    useEffect(() => {
        const tracker = new FeatureCreditCompletionTracker((key) => !!getFeatureCreditTask(key));

        const isIdle = () => {
            if (store.get(activeRunIdAtom)) return false;
            const threadId = store.get(currentThreadIdAtom);
            if (!threadId) return true;
            for (const fill of store.get(chatFillsAtom).values()) {
                if (fill.threadId === threadId && fill.snapshot.state !== 'done') return false;
            }
            return true;
        };

        const showReady = () => {
            for (const { task } of tracker.takeReady(isIdle())) {
                store.set(addPopupMessageAtom, {
                    id: `feature-credit-${task.key}`,
                    type: 'feature_credit',
                    expire: false,
                    featureCredit: { key: task.key, credits: task.credits },
                });
            }
        };

        const syncThread = () => tracker.setOpenThread(store.get(currentThreadIdAtom));
        const syncProfile = () => {
            tracker.updateTasks(store.get(profileWithPlanAtom)?.feature_credits?.tasks, store.get(accountGenerationAtom));
            showReady();
        };

        syncThread();
        syncProfile();
        const unsubscribers = [
            store.sub(currentThreadIdAtom, () => {
                syncThread();
                showReady();
            }),
            store.sub(profileWithPlanAtom, syncProfile),
            // The projection publishes the new generation before the new
            // account's profile: start over without reading the old one.
            store.sub(accountGenerationAtom, () => {
                tracker.updateTasks(null, store.get(accountGenerationAtom));
                // A reward card belongs to the account that earned it.
                store.set(removePopupMessagesByTypeAtom, ['feature_credit']);
            }),
            store.sub(activeRunIdAtom, showReady),
            store.sub(chatFillsAtom, showReady),
        ];
        return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    }, [store]);
}
