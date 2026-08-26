/**
 * One place that decides what "at the bottom" means, and one set of scroll atoms
 * per surface.
 *
 * The thread's scroll state is written from several places — the scroll handler,
 * the resize observers, the restore path, and each of the effects that jumps to
 * the bottom. They used to measure independently, so the answer depended on
 * which one ran last, and any distance change that arrived without a scroll
 * event (content streaming in, a card expanding) left the state describing where
 * the reader used to be. Measuring through `publishScrollPosition` keeps the
 * measured position honest wherever it is taken from.
 *
 * Two separate facts live here and should not be confused:
 *
 * - `isAtBottomAtom` — measured. Where the container actually sits. Ask this
 *   when rendering something that answers "is there more below?".
 * - `userScrolledAtom` — intent. Whether the reader deliberately scrolled back,
 *   which is what suppresses auto-scroll. It stays latched while they read, even
 *   as the measured distance moves under them.
 */

import type { PrimitiveAtom, WritableAtom } from 'jotai';
import {
    isAtBottomAtom,
    userScrolledAtom,
    windowIsAtBottomAtom,
    windowUserScrolledAtom,
} from '../atoms/ui';
import { currentThreadScrollPositionAtom, windowScrollPositionAtom } from '../atoms/threads';
import { store } from '../store';

/**
 * How close to the bottom still counts as being at it.
 *
 * The single threshold every reader of scroll state compares against. A second,
 * smaller one lives in `scrollToBottom` — that one decides whether a scroll is
 * worth animating, which is a different question from where the reader is.
 */
export const BOTTOM_THRESHOLD = 120; // pixels

/** Reads as the remembered offset, writes null to forget it. */
type ScrollPositionAtom = WritableAtom<number | undefined, [number | null], void>;

export interface ScrollAtoms {
    /** Measured: whether the container sits at its bottom. */
    isAtBottom: PrimitiveAtom<boolean>;
    /** Intent: whether the reader scrolled back and auto-scroll should stand off. */
    userScrolled: PrimitiveAtom<boolean>;
    /** Remembered scroll offset, restored when the thread is reopened. */
    position: ScrollPositionAtom;
}

// Frozen module constants rather than fresh objects: these are read during
// render and used as hook dependencies, where a new object each call would
// re-run every effect that depends on them.
const SIDEBAR_ATOMS: ScrollAtoms = Object.freeze({
    isAtBottom: isAtBottomAtom,
    userScrolled: userScrolledAtom,
    position: currentThreadScrollPositionAtom,
});

const WINDOW_ATOMS: ScrollAtoms = Object.freeze({
    isAtBottom: windowIsAtBottomAtom,
    userScrolled: windowUserScrolledAtom,
    position: windowScrollPositionAtom,
});

/**
 * The scroll atoms for a surface. The separate Beaver window scrolls
 * independently of the sidebars, so it keeps its own set.
 */
export function getScrollAtoms(isWindow: boolean): ScrollAtoms {
    return isWindow ? WINDOW_ATOMS : SIDEBAR_ATOMS;
}

/**
 * Distance in pixels from the bottom of the container's scrollable area.
 *
 * Null when the container is not being displayed — a collapsed pane or an
 * unmounted tab reports a zero client height and scroll offsets that describe
 * nothing. Callers must treat that as "unknown" and leave the state alone;
 * writing a measurement taken from a hidden container is how the state ends up
 * describing a view nobody is looking at.
 */
export function measureDistanceFromBottom(container: HTMLElement | null): number | null {
    if (!container || container.clientHeight === 0) return null;
    return container.scrollHeight - container.scrollTop - container.clientHeight;
}

/**
 * Publish a distance that has already been measured.
 *
 * For a caller holding the numbers — the scroll handler, which reads them to
 * decide about intent anyway — so the measurement is not taken twice.
 */
export function publishDistanceFromBottom(
    distance: number,
    atoms: ScrollAtoms,
    threshold: number = BOTTOM_THRESHOLD,
): void {
    store.set(atoms.isAtBottom, distance <= threshold);
}

/**
 * Measure the container and publish whether it is at the bottom.
 *
 * Safe to call as often as the distance might have changed: the atom is a
 * primitive, so a write that does not change the value notifies nobody.
 *
 * Cheap from a resize-observer callback or a scroll handler, which run once
 * layout is settled. From an effect that has just rendered, the same read forces
 * the browser to lay out early — prefer letting the observers report it.
 *
 * @returns The measured distance, or null when the container is not displayed
 * and nothing was published.
 */
export function publishScrollPosition(
    container: HTMLElement | null,
    atoms: ScrollAtoms,
    threshold: number = BOTTOM_THRESHOLD,
): number | null {
    const distance = measureDistanceFromBottom(container);
    if (distance === null) return null;
    publishDistanceFromBottom(distance, atoms, threshold);
    return distance;
}
