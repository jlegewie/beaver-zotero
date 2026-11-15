import { useEffect } from 'react';
import { useStore } from 'jotai';
import { watchFeatureCreditGrants } from '../atoms/featureCreditRuns';

/**
 * Shows a feature-credit completion card in this window when a run that
 * earned a task's credits ends (see `watchFeatureCreditGrants`). Mount once
 * per renderer.
 */
export function useFeatureCreditCompletions(): void {
    const store = useStore();
    useEffect(() => watchFeatureCreditGrants(store), [store]);
}
