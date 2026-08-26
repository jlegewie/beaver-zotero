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

/**
 * How close to the bottom counts as being *at* it, for the one question that
 * needs the strict answer: may auto-scroll resume following?
 *
 * Deliberately not `BOTTOM_THRESHOLD`. That one is generous on purpose — it
 * decides whether there is enough below to bother showing the scroll-down
 * button, and a reader a screen-inch from the end does not need to be told
 * there is more. Resuming on the same generosity would mean a reader who
 * scrolled back a little, and is still inside the band, gets handed straight
 * back to auto-scroll and yanked to the end.
 *
 * Small enough that only the true bottom qualifies, large enough to absorb what
 * lands there honestly: fractional scroll offsets on a scaled display, and the
 * sub-pixel rounding between `scrollHeight` and `scrollTop + clientHeight`.
 */
export const AT_BOTTOM_EPSILON = 8; // pixels

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
 * Where each container was last put by code rather than by the reader.
 *
 * A container cannot say who moved it. Dragging the scrollbar thumb produces a
 * scroll event and nothing else — no wheel, no touch, no key — so on its own it
 * is indistinguishable from auto-scroll following a response. Recording the
 * offsets this code writes is what tells the two apart.
 *
 * Keyed by element and holding no reference to one, so a container belonging to
 * a window that has since closed simply falls out.
 */
const programmaticScrolls = new WeakMap<HTMLElement, { scrollTop: number; settleUntil: number }>();

/**
 * How far a reported offset may sit from the one that was written and still
 * count as the same position: sub-pixel scroll offsets on a scaled display, the
 * rounding between a value assigned and the value reported back, and — for a
 * caller that records the offset it computed rather than reading it back — the
 * rounding between that and where the browser clamped to.
 */
const PROGRAMMATIC_SCROLL_EPSILON = 2; // pixels

/**
 * Record that this code, not the reader, just moved the container. Call it
 * immediately after writing `scrollTop`, so the offset the container actually
 * came to rest at — clamped, rounded — is what gets remembered.
 *
 * An offset rather than a flag, because scroll events are dispatched
 * asynchronously and coalesced: a flag would be left standing by a write that
 * moved nothing, or by two writes that produced a single event, and would then
 * swallow the reader's next gesture. An offset cannot strand that way. It either
 * describes where the container is or it does not, and a wrong one costs at most
 * the single event that happens to match it.
 *
 * @param settleMs For a scroll this code starts but does not step itself — a
 * smooth `scrollIntoView`, whose intermediate offsets are never ours to see —
 * how long the browser may keep moving the container towards its destination.
 * Every offset reported inside that window is attributed to it, so keep it to
 * the length of the scroll: while it lasts, the reader cannot scroll away.
 */
export function markProgrammaticScroll(
    container: HTMLElement,
    settleMs = 0,
    scrollTop?: number,
): void {
    programmaticScrolls.set(container, {
        // The caller's own value when it has one. Reading `scrollTop` back
        // straight after assigning it asks the browser to resolve the scroll
        // there and then, which is worth avoiding on a path that runs every
        // frame of a response; a caller that computed the offset it wrote
        // already knows the answer to within the epsilon above.
        scrollTop: scrollTop ?? container.scrollTop,
        settleUntil: settleMs > 0 ? Date.now() + settleMs : 0,
    });
}

/**
 * Whether an offset reported by a scroll event is explained by a scroll this
 * code performed. Anything else moved because a person moved it.
 */
export function wasProgrammaticScroll(container: HTMLElement, scrollTop: number): boolean {
    const record = programmaticScrolls.get(container);
    if (!record) return false;
    if (record.settleUntil > Date.now()) return true;
    return Math.abs(scrollTop - record.scrollTop) <= PROGRAMMATIC_SCROLL_EPSILON;
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
