import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

const mocks = vi.hoisted(() => ({
    completeFirstRun: vi.fn(),
    invalidateProfile: vi.fn(),
}));
vi.mock('@beaver/agent-core/transport/clients/accountService', () => ({
    accountService: { completeFirstRun: mocks.completeFirstRun },
}));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return {
        profileWithPlanAtom: atom<unknown>(null),
        isDeviceAuthorizedAtom: atom(true),
        allLibrariesExcludedAtom: atom(false),
    };
});

import {
    completeCreditsFirstRunAtom,
    firstRunPreviewAtom,
    isCreditsFirstRunAtom,
    isFirstRunVisibleAtom,
} from '../../../react/atoms/firstRun';
import { allLibrariesExcludedAtom, profileWithPlanAtom } from '../../../react/atoms/profile';

const DONE = '2026-11-01T00:00:00Z';

function storeWith(tasks: { key: string; done?: boolean }[] | null, firstRunDone = false) {
    const store = createStore();
    store.set(profileWithPlanAtom as never, {
        has_authorized_free_access: true,
        first_run_completed_at: firstRunDone ? DONE : null,
        feature_credits: tasks === null ? null : {
            tasks: tasks.map(({ key, done }) => ({ key, credits: 5, completed_at: done ? DONE : null, source: null })),
        },
    });
    return store;
}

const firstRun = (store: ReturnType<typeof createStore>) => ({
    credits: store.get(isCreditsFirstRunAtom),
    page: store.get(isFirstRunVisibleAtom),
});

describe('first run', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.completeFirstRun.mockResolvedValue(undefined);
        mocks.invalidateProfile.mockResolvedValue(undefined);
        (globalThis as any).Zotero = { Beaver: { account: { invalidateProfile: mocks.invalidateProfile } } };
    });

    it('starts on the home screen with the task list for an account that can earn credits', () => {
        expect(firstRun(storeWith([{ key: 'annotate' }]))).toEqual({ credits: true, page: false });
    });

    it('shows the first-run page to an account that cannot earn credits', () => {
        expect(firstRun(storeWith(null))).toEqual({ credits: false, page: true });
    });

    it('shows the first-run page when every task is earned or every library is excluded', () => {
        expect(firstRun(storeWith([{ key: 'annotate', done: true }]))).toEqual({ credits: false, page: true });
        const excluded = storeWith([{ key: 'annotate' }]);
        excluded.set(allLibrariesExcludedAtom as never, true);
        expect(firstRun(excluded)).toEqual({ credits: false, page: true });
    });

    it('is over once completed, except for a Dev Tools preview of the page', () => {
        const store = storeWith([{ key: 'annotate' }], true);
        expect(firstRun(store)).toEqual({ credits: false, page: false });
        store.set(firstRunPreviewAtom, true);
        expect(store.get(isFirstRunVisibleAtom)).toBe(true);
    });

    it('records the first choice of a credits first run', async () => {
        const store = storeWith([{ key: 'annotate' }]);
        await store.set(completeCreditsFirstRunAtom, 'annotate');
        expect(mocks.completeFirstRun).toHaveBeenCalledWith('feature_credits_annotate');
        expect(mocks.invalidateProfile).toHaveBeenCalledTimes(1);
    });

    it('keeps the first choice while it is being recorded', async () => {
        let release!: () => void;
        mocks.completeFirstRun.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
        const store = storeWith([{ key: 'annotate' }]);
        const first = store.set(completeCreditsFirstRunAtom, 'annotate');
        await store.set(completeCreditsFirstRunAtom, 'chat');
        release();
        await first;
        expect(mocks.completeFirstRun).toHaveBeenCalledTimes(1);
        expect(mocks.completeFirstRun).toHaveBeenCalledWith('feature_credits_annotate');
    });

    it('records nothing outside a credits first run', async () => {
        await storeWith(null).set(completeCreditsFirstRunAtom, 'chat');
        await storeWith([{ key: 'annotate' }], true).set(completeCreditsFirstRunAtom, 'chat');
        expect(mocks.completeFirstRun).not.toHaveBeenCalled();
    });
});
