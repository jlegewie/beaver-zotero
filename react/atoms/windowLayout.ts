import { atom } from 'jotai';
import { preferencesRevisionAtom } from './preferences';
import { getPref, setPref } from '../../src/utils/prefs';

/**
 * Whether the separate Beaver window's chat history sidebar is collapsed.
 *
 * Preference-backed so the choice survives closing and reopening the window.
 * Read through the preferences revision so every renderer sees a change made
 * by another one.
 */
export const windowNavCollapsedAtom = atom(
    (get) => { get(preferencesRevisionAtom); return getPref('windowSidebarCollapsed') === true; },
    (_get, _set, collapsed: boolean) => {
        setPref('windowSidebarCollapsed', collapsed);
    },
);

/** Flips the sidebar between collapsed and expanded. */
export const toggleWindowNavAtom = atom(null, (get, set) => {
    set(windowNavCollapsedAtom, !get(windowNavCollapsedAtom));
});
