import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

// messageComposition pulls in Zotero UI modules; this file only needs the
// atom featureCreditRuns reads from it.
vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    return { composerResetTokenAtom: atom(0) };
});

import { activeRunAtom, currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { composerResetTokenAtom } from '../../../react/atoms/messageComposition';
import { accountGenerationAtom } from '../../../react/atoms/profile';
import {
    activeFeatureTaskAtom,
    dismissEarnedFeatureCreditAtom,
    earnedFeatureCreditsAtom,
    featureTaskForMessage,
    pendingFeatureCreditsAtom,
    recordFeatureCreditGrantAtom,
    watchFeatureCreditGrants,
} from '../../../react/atoms/featureCreditRuns';

const refresh = vi.fn(async () => {});
const run = (id: string, status: string) => ({ id, status } as any);
const action = (actionId: string) => ({ command: 'x', action_id: actionId, title: 'X', prompt: 'p' } as any);

beforeEach(() => {
    vi.clearAllMocks();
    (Zotero as any).Beaver = { account: { refresh } };
});
afterEach(() => {
    delete (Zotero as any).Beaver;
});

describe('the feature task a message starts', () => {
    it('is the open setup card task when the message runs its action', () => {
        expect(featureTaskForMessage('annotate', [action('builtin-color-code')])).toBe('annotate');
        expect(featureTaskForMessage('literature_review', [action('custom-1'), action('builtin-collection-literature-review')]))
            .toBe('literature_review');
    });

    it('is none without the task action, without a setup card, or for an unknown task', () => {
        expect(featureTaskForMessage('annotate', [])).toBeUndefined();
        expect(featureTaskForMessage('annotate', [action('builtin-tidy-up')])).toBeUndefined();
        // General /annotate is not the task's action.
        expect(featureTaskForMessage('annotate', [action('builtin-annotate')])).toBeUndefined();
        expect(featureTaskForMessage(null, [action('builtin-color-code')])).toBeUndefined();
        expect(featureTaskForMessage('note', [action('builtin-create-note')])).toBeUndefined();
    });

    it('ends with the chat input it was started in', () => {
        const store = createStore();
        store.set(activeFeatureTaskAtom, 'annotate');
        expect(store.get(activeFeatureTaskAtom)).toBe('annotate');
        store.set(composerResetTokenAtom, 1);
        expect(store.get(activeFeatureTaskAtom)).toBeNull();
    });
});

describe('reward cards for earned credits', () => {
    function setup() {
        const store = createStore();
        store.set(activeRunAtom, run('r1', 'in_progress'));
        const stop = watchFeatureCreditGrants(store);
        return { store, stop, cards: () => [...store.get(earnedFeatureCreditsAtom).values()] };
    }

    it('adds the card under the run that earned the credits when it finishes, and refreshes the profile', () => {
        const { store, cards } = setup();
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'annotate', credits: 5 });
        expect(cards()).toEqual([]);
        expect(refresh).not.toHaveBeenCalled();

        store.set(activeRunAtom, run('r1', 'completed'));
        expect(cards()).toEqual([{ key: 'annotate', credits: 5, runId: 'r1' }]);
        expect(store.get(earnedFeatureCreditsAtom).get('r1')?.key).toBe('annotate');
        expect(refresh).toHaveBeenCalledWith(true);
        expect(store.get(pendingFeatureCreditsAtom).size).toBe(0);

        // Once per grant.
        store.set(activeRunAtom, null);
        expect(cards()).toHaveLength(1);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it.each(['error', 'canceled', 'parked'])('adds the card when the run ends as %s', (status) => {
        const { store, cards } = setup();
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'organize', credits: 5 });
        store.set(activeRunAtom, run('r1', status));
        expect(cards().map((card) => card.key)).toEqual(['organize']);
    });

    it('waits while the run awaits a decision', () => {
        const { store, cards } = setup();
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'annotate', credits: 5 });
        store.set(activeRunAtom, run('r1', 'awaiting_deferred'));
        expect(cards()).toEqual([]);
    });

    it('adds the card when the run leaves this window', () => {
        const { store, cards } = setup();
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'annotate', credits: 5 });
        store.set(activeRunAtom, run('r2', 'in_progress'));
        expect(cards()).toHaveLength(1);
    });

    it('keeps a card per run until it is closed', () => {
        const { store, cards } = setup();
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'annotate', credits: 5 });
        store.set(activeRunAtom, run('r2', 'in_progress'));
        store.set(recordFeatureCreditGrantAtom, { runId: 'r2', key: 'organize', credits: 5 });
        store.set(activeRunAtom, run('r2', 'completed'));
        expect(cards().map((card) => card.runId)).toEqual(['r1', 'r2']);

        store.set(dismissEarnedFeatureCreditAtom, 'r1');
        expect(cards().map((card) => card.runId)).toEqual(['r2']);
        store.set(dismissEarnedFeatureCreditAtom, 'r1');
        expect(cards()).toHaveLength(1);
    });

    it('keeps the cards when a new chat gets its id, and drops them when the window leaves the chat', () => {
        const { store, cards } = setup();
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'annotate', credits: 5 });
        store.set(currentThreadIdAtom, 't1');
        store.set(activeRunAtom, run('r1', 'completed'));
        expect(cards()).toHaveLength(1);

        store.set(currentThreadIdAtom, null);
        expect(cards()).toEqual([]);
        store.set(currentThreadIdAtom, 't1');
        expect(cards()).toEqual([]);
    });

    it('refreshes the profile, without a card, when the window leaves the chat during the run', () => {
        const { store, cards } = setup();
        store.set(currentThreadIdAtom, 't1');
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'annotate', credits: 5 });
        store.set(activeRunAtom, null);
        store.set(currentThreadIdAtom, 't2');
        expect(cards()).toEqual([]);
        expect(store.get(pendingFeatureCreditsAtom).size).toBe(0);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('shows nothing for runs without a grant', () => {
        const { store, cards } = setup();
        store.set(activeRunAtom, run('r1', 'completed'));
        store.set(activeRunAtom, null);
        expect(cards()).toEqual([]);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('drops grants and cards when the account changes', () => {
        const { store, cards } = setup();
        store.set(recordFeatureCreditGrantAtom, { runId: 'r0', key: 'organize', credits: 5 });
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'annotate', credits: 5 });
        expect(cards()).toHaveLength(1);
        store.set(accountGenerationAtom, 2);
        expect(cards()).toEqual([]);
        store.set(activeRunAtom, run('r1', 'completed'));
        expect(cards()).toEqual([]);
    });

    it('stops watching when unsubscribed', () => {
        const { store, stop, cards } = setup();
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'annotate', credits: 5 });
        stop();
        store.set(activeRunAtom, run('r1', 'completed'));
        expect(cards()).toEqual([]);
    });
});
