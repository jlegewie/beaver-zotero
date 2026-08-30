// @vitest-environment jsdom

/**
 * What useAutoScroll remembers about the reader's place in a thread, and when.
 *
 * The remembered position is what ThreadView restores when a thread is shown
 * again — after a thread switch, or after the pane was closed and reopened,
 * which unmounts and remounts the whole surface. A reader who was following a
 * streaming response must come back to the live bottom and keep following; a
 * reader who had scrolled back must come back to where they were.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/atoms/ui', async () => {
    const { atom } = await import('jotai');
    return {
        userScrolledAtom: atom(false),
        windowUserScrolledAtom: atom(false),
        isAtBottomAtom: atom(true),
        windowIsAtBottomAtom: atom(true),
    };
});

vi.mock('../../../react/atoms/threads', async () => {
    const { atom } = await import('jotai');
    const rememberedPosition = () => {
        const base = atom<number | undefined>(undefined);
        return atom(
            (get) => get(base),
            (_get, set, scrollTop: number | null) => set(base, scrollTop === null ? undefined : scrollTop),
        );
    };
    return {
        currentThreadScrollPositionAtom: rememberedPosition(),
        windowScrollPositionAtom: rememberedPosition(),
    };
});

import { store } from '../../../react/store';
import { getScrollAtoms, latchIntentFromDistance, resumeFollowing } from '../../../react/utils/scrollPosition';
import { useAutoScroll } from '../../../react/hooks/useAutoScroll';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const atoms = getScrollAtoms(false);

type Hook = ReturnType<typeof useAutoScroll>;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let hook: Hook | null = null;
let container: HTMLDivElement | null = null;

function Harness() {
    hook = useAutoScroll(undefined, { isWindow: false });
    return React.createElement('div', { ref: hook.setScrollContainerRef });
}

/** Fake the geometry jsdom does not lay out. `scrollTop` stays writable. */
function setGeometry(el: HTMLElement, { scrollTop, scrollHeight, clientHeight }: {
    scrollTop: number; scrollHeight: number; clientHeight: number;
}) {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
}

/** A scroll event reporting the container at `scrollTop` with content `scrollHeight` tall. */
function scrollEvent(scrollTop: number, scrollHeight: number) {
    setGeometry(container!, { scrollTop, scrollHeight, clientHeight: 500 });
    hook!.handleScroll();
}

beforeEach(() => {
    store.set(atoms.userScrolled, false);
    store.set(atoms.isAtBottom, true);
    store.set(atoms.position, null);

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(React.createElement(Harness));
    });
    container = host.firstElementChild as HTMLDivElement;
    setGeometry(container, { scrollTop: 0, scrollHeight: 500, clientHeight: 500 });
});

afterEach(() => {
    act(() => {
        root?.unmount();
    });
    host?.remove();
    root = null;
    host = null;
    hook = null;
    container = null;
});

describe('useAutoScroll remembers the reader\'s place in the thread', () => {
    it('remembers "the bottom", not an offset, while the reader follows a response', () => {
        // Each frame of a streaming response pins the container to a new,
        // larger bottom; every scroll event lands at the end.
        scrollEvent(500, 1000);
        scrollEvent(900, 1400);
        scrollEvent(1500, 2000);

        expect(store.get(atoms.userScrolled)).toBe(false);
        expect(store.get(atoms.position)).toBeUndefined();
    });

    it('remembers the offset once the reader scrolls back, so a reopen lands there', () => {
        scrollEvent(1500, 2000);
        // A scrollbar drag: the container moved back at an offset nothing
        // programmatic wrote.
        scrollEvent(700, 2000);

        expect(store.get(atoms.userScrolled)).toBe(true);
        expect(store.get(atoms.position)).toBe(700);
    });

    it('keeps a scrolled-back reader\'s offset as the response keeps growing under them', () => {
        scrollEvent(1500, 2000);
        scrollEvent(700, 2000);
        // Content keeps arriving below; the container does not move.
        scrollEvent(700, 2600);
        scrollEvent(700, 3200);

        expect(store.get(atoms.position)).toBe(700);
    });

    it('forgets the offset again once the reader returns to the bottom', () => {
        scrollEvent(1500, 2000);
        scrollEvent(700, 2000);
        expect(store.get(atoms.position)).toBe(700);

        scrollEvent(1500, 2000);

        expect(store.get(atoms.userScrolled)).toBe(false);
        expect(store.get(atoms.position)).toBeUndefined();
    });

    it('only moves a remembered offset by a visible amount', () => {
        scrollEvent(1500, 2000);
        scrollEvent(700, 2000);

        // Jitter below the update threshold is not worth a write ...
        scrollEvent(694, 2000);
        expect(store.get(atoms.position)).toBe(700);

        // ... a real movement is.
        scrollEvent(600, 2000);
        expect(store.get(atoms.position)).toBe(600);
    });
});

describe('resuming without a scroll event', () => {
    // Content shrinking under a scrolled-back reader until its end reaches them
    // moves nothing and fires no scroll event; ThreadView resumes from a resize
    // record instead. The offset must go with the intent, or the next reopen
    // restores it above a bottom that has since moved on.
    it('resumeFollowing forgets the remembered offset along with the intent', () => {
        scrollEvent(1500, 2000);
        scrollEvent(700, 2000);
        expect(store.get(atoms.position)).toBe(700);

        resumeFollowing(atoms);

        expect(store.get(atoms.userScrolled)).toBe(false);
        expect(store.get(atoms.position)).toBeUndefined();
    });

    it('a restore that lands inside the bottom band resumes and forgets; one above it keeps the offset', () => {
        scrollEvent(1500, 2000);
        scrollEvent(700, 2000);

        latchIntentFromDistance(400, atoms);
        expect(store.get(atoms.userScrolled)).toBe(true);
        expect(store.get(atoms.position)).toBe(700);

        latchIntentFromDistance(40, atoms);
        expect(store.get(atoms.userScrolled)).toBe(false);
        expect(store.get(atoms.position)).toBeUndefined();
    });
});
