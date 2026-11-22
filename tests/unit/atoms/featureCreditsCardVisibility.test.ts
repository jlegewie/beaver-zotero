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
    return { ...original, profileWithPlanAtom: atom<unknown>(null) };
});
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: () => '' }));
vi.mock('../../../src/utils/libraryIdentity', () => ({ resolveLibraryRef: () => 1 }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    featureCreditsCardDismissedAtom,
    featureCreditsCardRequestedAtom,
    featureCreditsCardVisibleAtom,
} from '../../../react/atoms/featureCredits';
import { profileWithPlanAtom } from '../../../react/atoms/profile';

const profile = (firstRunDone: boolean) => ({
    first_run_completed_at: firstRunDone ? '2026-11-01T00:00:00Z' : null,
    feature_credits: { tasks: [{ key: 'organize', credits: 5, completed_at: null }] },
});

describe('featureCreditsCardVisibleAtom', () => {
    beforeEach(() => prefs.clear());

    it('shows before first run once the user asks for the card', () => {
        const store = createStore();
        store.set(profileWithPlanAtom as never, profile(false));
        expect(store.get(featureCreditsCardVisibleAtom)).toBe(false);
        store.set(featureCreditsCardRequestedAtom, true);
        expect(store.get(featureCreditsCardVisibleAtom)).toBe(true);
    });

    it('stops asking for the card when it is dismissed', () => {
        const store = createStore();
        store.set(profileWithPlanAtom as never, profile(true));
        store.set(featureCreditsCardRequestedAtom, true);
        store.set(featureCreditsCardDismissedAtom, true);
        expect(store.get(featureCreditsCardRequestedAtom)).toBe(false);
        expect(store.get(featureCreditsCardVisibleAtom)).toBe(false);
    });
});
