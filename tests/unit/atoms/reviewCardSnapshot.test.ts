import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';

import {
    clearRetainedReviewActionsForRunAtom,
    retainedReviewActionsAtom,
    retainReviewActionsAtom,
} from '../../../react/atoms/messageUIState';

describe('review card snapshot retention', () => {
    it('clears only the dismissed run so resolved cards cannot replay on remount', () => {
        const store = createStore();
        store.set(retainReviewActionsAtom, { runId: 'run-1', actionIds: ['a1', 'a2'] });
        store.set(retainReviewActionsAtom, { runId: 'run-2', actionIds: ['b1'] });

        store.set(clearRetainedReviewActionsForRunAtom, 'run-1');

        expect(store.get(retainedReviewActionsAtom)).toEqual({
            'run-2:b1': true,
        });
    });
});
