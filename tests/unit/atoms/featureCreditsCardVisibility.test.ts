import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs.get(key),
    setPref: (key: string, value: unknown) => prefs.set(key, value),
}));
vi.mock('../../../react/atoms/profile', async (importOriginal) => {
    const { atom } = await import('jotai');
    const original = await importOriginal<object>();
    return {
        ...original,
        profileWithPlanAtom: atom<unknown>(null),
        isDeviceAuthorizedAtom: atom(true),
        allLibrariesExcludedAtom: atom(false),
    };
});
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: () => '' }));
vi.mock('../../../src/utils/libraryIdentity', () => ({ resolveLibraryRef: () => 1 }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    featureCreditsCardDismissedAtom,
    featureCreditsCardVisibleAtom,
    featureTaskUnavailableAtom,
} from '../../../react/atoms/featureCredits';
import { profileWithPlanAtom } from '../../../react/atoms/profile';
import { libraryItemCountAtom } from '../../../react/atoms/zoteroContext';
import { getFeatureCreditTask } from '../../../react/constants/featureCreditTasks';

const DONE = '2026-11-01T00:00:00Z';

const profile = (tasks: { key: string; done?: boolean }[] | null, firstRunDone = false) => ({
    has_authorized_free_access: true,
    first_run_completed_at: firstRunDone ? DONE : null,
    feature_credits: tasks === null ? null : {
        tasks: tasks.map(({ key, done }) => ({ key, credits: 5, completed_at: done ? DONE : null, source: null })),
    },
});

describe('featureCreditsCardVisibleAtom', () => {
    beforeEach(() => prefs.clear());

    it('shows while a task is open, in first run and after it', () => {
        for (const firstRunDone of [false, true]) {
            const store = createStore();
            store.set(profileWithPlanAtom as never, profile([{ key: 'organize' }], firstRunDone));
            expect(store.get(featureCreditsCardVisibleAtom)).toBe(true);
        }
    });

    it('hides for an account that cannot earn credits or has earned every task', () => {
        const store = createStore();
        store.set(profileWithPlanAtom as never, profile(null));
        expect(store.get(featureCreditsCardVisibleAtom)).toBe(false);
        store.set(profileWithPlanAtom as never, profile([{ key: 'organize', done: true }]));
        expect(store.get(featureCreditsCardVisibleAtom)).toBe(false);
    });

    it('ignores tasks this client does not know', () => {
        const store = createStore();
        store.set(profileWithPlanAtom as never, profile([{ key: 'future_task' }]));
        expect(store.get(featureCreditsCardVisibleAtom)).toBe(false);
    });

    it('hides once dismissed, except as the first screen of a first run', () => {
        const store = createStore();
        store.set(featureCreditsCardDismissedAtom, true);
        store.set(profileWithPlanAtom as never, profile([{ key: 'organize' }]));
        expect(store.get(featureCreditsCardVisibleAtom)).toBe(true);
        store.set(profileWithPlanAtom as never, profile([{ key: 'organize' }], true));
        expect(store.get(featureCreditsCardVisibleAtom)).toBe(false);
    });
});

describe('featureTaskUnavailableAtom', () => {
    const reasons = (count: number | null) => {
        const store = createStore();
        store.set(libraryItemCountAtom, count);
        const reason = store.get(featureTaskUnavailableAtom);
        return Object.fromEntries(
            ['annotate', 'start_project', 'research_table', 'literature_review', 'organize']
                .map((key) => [key, reason(getFeatureCreditTask(key)!)]),
        );
    };

    it('holds the tasks that work on papers in the library in a small library', () => {
        expect(reasons(3)).toEqual({
            annotate: 'Needs 10 or more items in your library',
            start_project: null,
            research_table: 'Needs 10 or more items in your library',
            literature_review: null,
            organize: 'Needs 10 or more items in your library',
        });
    });

    it('lets every task start in a library of a useful size, or before it is counted', () => {
        for (const count of [10, null]) {
            expect(Object.values(reasons(count)).every((reason) => reason === null)).toBe(true);
        }
    });
});
