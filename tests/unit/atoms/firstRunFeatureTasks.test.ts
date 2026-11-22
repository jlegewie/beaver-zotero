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
        allLibrariesExcludedAtom: atom(false),
    };
});
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: () => '' }));
vi.mock('../../../src/utils/libraryIdentity', () => ({ resolveLibraryRef: () => 1 }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { firstRunFeatureTasksAtom } from '../../../react/atoms/featureCredits';
import { allLibrariesExcludedAtom, profileWithPlanAtom } from '../../../react/atoms/profile';
import { firstRunOfferedTasks } from '../../../react/utils/featureCredits';

const DONE = '2026-11-01T00:00:00Z';

function storeWith(tasks: { key: string; done?: boolean }[] | null) {
    const store = createStore();
    store.set(profileWithPlanAtom as never, {
        first_run_completed_at: null,
        feature_credits: tasks === null ? null : {
            tasks: tasks.map(({ key, done }) => ({ key, credits: 5, completed_at: done ? DONE : null })),
        },
    });
    return store;
}

const keys = (store: ReturnType<typeof createStore>) =>
    store.get(firstRunFeatureTasksAtom)?.map(({ definition }) => definition.key);

describe('firstRunFeatureTasksAtom', () => {
    beforeEach(() => prefs.clear());

    it('offers the tasks while one is open', () => {
        const store = storeWith([{ key: 'annotate', done: true }, { key: 'start_project' }]);
        expect(keys(store)).toEqual(['annotate', 'start_project']);
    });

    it('has nothing to offer when the feature is off or the user is held out', () => {
        expect(storeWith(null).get(firstRunFeatureTasksAtom)).toBeNull();
    });

    it('has nothing to offer when every library is excluded', () => {
        const store = storeWith([{ key: 'start_project' }]);
        store.set(allLibrariesExcludedAtom as never, true);
        expect(store.get(firstRunFeatureTasksAtom)).toBeNull();
    });

    it('has nothing to offer when every task is done', () => {
        expect(storeWith([{ key: 'start_project', done: true }]).get(firstRunFeatureTasksAtom)).toBeNull();
    });
});

describe('firstRunOfferedTasks', () => {
    const entries = (done: string[] = []) => storeWith(
        ['annotate', 'start_project', 'organize'].map((key) => ({ key, done: done.includes(key) })),
    ).get(firstRunFeatureTasksAtom)!;
    const offered = (list: ReturnType<typeof entries>) => list.map(({ definition }) => definition.key);

    it('offers every task in a library of a useful size', () => {
        expect(offered(firstRunOfferedTasks(entries(), true))).toEqual(['annotate', 'start_project', 'organize']);
    });

    it('offers only tasks that need no papers in a small library', () => {
        expect(offered(firstRunOfferedTasks(entries(), false))).toEqual(['start_project']);
    });

    it('keeps a small library to those tasks after they are done', () => {
        expect(offered(firstRunOfferedTasks(entries(['start_project']), false))).toEqual(['start_project']);
    });
});
