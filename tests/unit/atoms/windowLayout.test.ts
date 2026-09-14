import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

const prefs: Record<string, unknown> = {};
vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn((key: string) => prefs[key]),
    setPref: vi.fn((key: string, value: unknown) => { prefs[key] = value; }),
}));

import { toggleWindowNavAtom, windowNavCollapsedAtom } from '../../../react/atoms/windowLayout';
import { preferencesRevisionAtom } from '../../../react/atoms/preferences';

describe('windowNavCollapsedAtom', () => {
    beforeEach(() => {
        for (const key of Object.keys(prefs)) delete prefs[key];
    });

    it('is expanded until the preference says otherwise', () => {
        const store = createStore();
        expect(store.get(windowNavCollapsedAtom)).toBe(false);
        prefs.windowSidebarCollapsed = true;
        store.set(preferencesRevisionAtom, 1);
        expect(store.get(windowNavCollapsedAtom)).toBe(true);
    });

    it('persists a toggle to the preference so the next window opening keeps it', () => {
        const store = createStore();
        store.set(toggleWindowNavAtom);
        expect(prefs.windowSidebarCollapsed).toBe(true);
        store.set(preferencesRevisionAtom, 1);
        expect(store.get(windowNavCollapsedAtom)).toBe(true);
        store.set(toggleWindowNavAtom);
        expect(prefs.windowSidebarCollapsed).toBe(false);
    });
});
