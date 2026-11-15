import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atom, createStore } from 'jotai';

// messageComposition and the popup helpers pull in Zotero UI modules; this
// file only needs the atoms featureCreditRuns reads and writes.
vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    return { composerResetTokenAtom: atom(0) };
});
vi.mock('../../../react/utils/popupMessageUtils', async () => {
    const { atom } = await import('jotai');
    const popups = atom<any[]>([]);
    return {
        __popupsAtom: popups,
        addPopupMessageAtom: atom(null, (get, set, message: any) => set(popups, [...get(popups), message])),
    };
});
vi.mock('../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    const { __popupsAtom } = await import('../../../react/utils/popupMessageUtils') as any;
    return {
        removePopupMessagesByTypeAtom: atom(null, (get, set, types: string[]) =>
            set(__popupsAtom, get(__popupsAtom).filter((message: any) => !types.includes(message.type)))),
    };
});

import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { composerResetTokenAtom } from '../../../react/atoms/messageComposition';
import { accountGenerationAtom } from '../../../react/atoms/profile';
import {
    activeFeatureTaskAtom,
    featureTaskForMessage,
    pendingFeatureCreditsAtom,
    recordFeatureCreditGrantAtom,
    watchFeatureCreditGrants,
} from '../../../react/atoms/featureCreditRuns';

const popupsAtom = (await import('../../../react/utils/popupMessageUtils') as any).__popupsAtom as ReturnType<typeof atom<any[]>>;

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
        expect(featureTaskForMessage('annotate', [action('builtin-annotate')])).toBe('annotate');
        expect(featureTaskForMessage('literature_review', [action('custom-1'), action('builtin-collection-literature-review')]))
            .toBe('literature_review');
    });

    it('is none without the task action, without a setup card, or for an unknown task', () => {
        expect(featureTaskForMessage('annotate', [])).toBeUndefined();
        expect(featureTaskForMessage('annotate', [action('builtin-tidy-up')])).toBeUndefined();
        expect(featureTaskForMessage(null, [action('builtin-annotate')])).toBeUndefined();
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

describe('completion cards for earned credits', () => {
    function setup() {
        const store = createStore();
        store.set(activeRunAtom, run('r1', 'in_progress'));
        const stop = watchFeatureCreditGrants(store);
        return { store, stop, popups: () => store.get(popupsAtom) };
    }

    it('shows the card when the run that earned the credits finishes, and refreshes the profile', () => {
        const { store, popups } = setup();
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'annotate', credits: 5 });
        expect(popups()).toEqual([]);
        expect(refresh).not.toHaveBeenCalled();

        store.set(activeRunAtom, run('r1', 'completed'));
        expect(popups()).toEqual([{
            id: 'feature-credit-annotate',
            type: 'feature_credit',
            expire: false,
            featureCredit: { key: 'annotate', credits: 5, runId: 'r1' },
        }]);
        expect(refresh).toHaveBeenCalledWith(true);
        expect(store.get(pendingFeatureCreditsAtom).size).toBe(0);

        // Once per grant.
        store.set(activeRunAtom, null);
        expect(popups()).toHaveLength(1);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it.each(['error', 'canceled', 'parked'])('shows the card when the run ends as %s', (status) => {
        const { store, popups } = setup();
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'organize', credits: 5 });
        store.set(activeRunAtom, run('r1', status));
        expect(popups().map((message: any) => message.featureCredit.key)).toEqual(['organize']);
    });

    it('waits while the run awaits a decision', () => {
        const { store, popups } = setup();
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'annotate', credits: 5 });
        store.set(activeRunAtom, run('r1', 'awaiting_deferred'));
        expect(popups()).toEqual([]);
    });

    it('shows the card when the run leaves this window', () => {
        const { store, popups } = setup();
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'annotate', credits: 5 });
        store.set(activeRunAtom, run('r2', 'in_progress'));
        expect(popups()).toHaveLength(1);
    });

    it('shows nothing for runs without a grant', () => {
        const { store, popups } = setup();
        store.set(activeRunAtom, run('r1', 'completed'));
        store.set(activeRunAtom, null);
        expect(popups()).toEqual([]);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('drops grants and cards when the account changes', () => {
        const { store, popups } = setup();
        store.set(recordFeatureCreditGrantAtom, { runId: 'r0', key: 'organize', credits: 5 });
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'annotate', credits: 5 });
        expect(popups()).toHaveLength(1);
        store.set(accountGenerationAtom, 2);
        expect(popups()).toEqual([]);
        store.set(activeRunAtom, run('r1', 'completed'));
        expect(popups()).toEqual([]);
    });

    it('stops watching when unsubscribed', () => {
        const { store, stop, popups } = setup();
        store.set(recordFeatureCreditGrantAtom, { runId: 'r1', key: 'annotate', credits: 5 });
        stop();
        store.set(activeRunAtom, run('r1', 'completed'));
        expect(popups()).toEqual([]);
    });
});
