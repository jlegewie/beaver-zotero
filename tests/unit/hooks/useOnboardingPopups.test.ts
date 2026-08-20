// @vitest-environment jsdom

/**
 * Onboarding tips are one-shot: each writes a preference that retires it
 * forever, so the write must not happen unless the tip is really displayed.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Keyed by the unprefixed name `getPref`/`setPref` take. */
const { prefs } = vi.hoisted(() => ({ prefs: new Map<string, unknown>() }));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => prefs.get(key),
    setPref: (key: string, value: unknown) => { prefs.set(key, value); },
    clearPref: (key: string) => { prefs.delete(key); },
}));
vi.mock('../../../react/utils/readerUtils', () => ({ getCurrentReader: vi.fn(() => null) }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { store } from '../../../react/store';
import { isSidebarVisibleAtom, isBeaverWindowOpenAtom, isLibraryTabAtom } from '../../../react/atoms/ui';
import { currentNoteItemAtom } from '../../../react/atoms/zoteroContext';
import { floatingPopupMessagesAtom } from '../../../react/atoms/floatingPopup';
import type { PopupMessage } from '../../../react/types/popupMessage';
import { useOnboardingPopups } from '../../../react/hooks/useOnboardingPopups';

const NOTE_TIP_POPUP_ID = 'onboarding-note-tip';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
    const Harness: React.FC = () => {
        useOnboardingPopups();
        return null;
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root!.render(React.createElement(Provider, { store }, React.createElement(Harness)));
    });
}

function noteTip(): PopupMessage | undefined {
    return store.get(floatingPopupMessagesAtom).find((msg) => msg.id === NOTE_TIP_POPUP_ID);
}

/** Advances past the tip's display delay and lets React flush. */
function passTheDelay() {
    act(() => { vi.advanceTimersByTime(1000); });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    prefs.clear();
    // Already onboarded except for the note tip, so only that effect can fire.
    prefs.set('onboardingWelcomeShown', true);
    prefs.set('onboardingReaderTipShownV2', true);
    store.set(floatingPopupMessagesAtom, []);
    store.set(currentNoteItemAtom, { id: 1 } as any);
    store.set(isSidebarVisibleAtom, false);
    store.set(isBeaverWindowOpenAtom, false);
    store.set(isLibraryTabAtom, false);
});

afterEach(() => {
    if (root) act(() => { root!.unmount(); });
    container?.remove();
    root = null;
    container = null;
    vi.useRealTimers();
});

describe('the note tip', () => {
    it('shows once a note tab is open', () => {
        mount();
        passTheDelay();

        expect(noteTip()).toMatchObject({ type: 'note_tip', expire: false });
        expect(prefs.get('onboardingNoteTipShown')).toBe(true);
    });

    it('is not retired before it is displayed', () => {
        mount();

        expect(noteTip()).toBeUndefined();
        expect(prefs.get('onboardingNoteTipShown')).toBeUndefined();
    });

    it('survives a popup change that cancels its pending display', () => {
        mount();

        // Any floating-popup change re-runs the effect and clears the pending
        // timer; the tip must still be owed, not silently spent.
        act(() => { store.set(floatingPopupMessagesAtom, []); });
        passTheDelay();

        expect(noteTip()).toBeDefined();
        expect(prefs.get('onboardingNoteTipShown')).toBe(true);
    });

    it('stands down while the interrupted-chat popup is up', () => {
        store.set(floatingPopupMessagesAtom, [
            { id: 'interrupted-thread-resume', type: 'info', expire: false } as PopupMessage,
        ]);
        mount();
        passTheDelay();

        expect(noteTip()).toBeUndefined();
        expect(prefs.get('onboardingNoteTipShown')).toBeUndefined();
    });

    it('does not show while Beaver is already open', () => {
        store.set(isSidebarVisibleAtom, true);
        mount();
        passTheDelay();

        expect(noteTip()).toBeUndefined();
        expect(prefs.get('onboardingNoteTipShown')).toBeUndefined();
    });

    it('does not show twice', () => {
        prefs.set('onboardingNoteTipShown', true);
        mount();
        passTheDelay();

        expect(noteTip()).toBeUndefined();
    });
});
