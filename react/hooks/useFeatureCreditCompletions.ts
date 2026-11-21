import { useEffect } from 'react';
import { useStore } from 'jotai';
import { watchFeatureCreditGrants } from '../atoms/featureCreditRuns';

/**
 * Shows a feature-credit reward card under a run that earned a task's credits
 * once it ends (see `watchFeatureCreditGrants`). Mount once per renderer.
 */
export function useFeatureCreditCompletions(): void {
    const store = useStore();
    useEffect(() => watchFeatureCreditGrants(store), [store]);
}
