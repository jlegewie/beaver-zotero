import { useRef, useCallback, useEffect, useState, ForwardedRef, RefObject } from 'react';
import { store } from '../store';
import { AT_BOTTOM_EPSILON, BOTTOM_THRESHOLD, getScrollAtoms, publishDistanceFromBottom, wasProgrammaticScroll } from '../utils/scrollPosition';

const SCROLL_POSITION_UPDATE_THRESHOLD = 10; // pixels - minimum change to update scroll position atom

/**
 * Smallest backwards movement between two scroll events that counts as one.
 * Below it are the fractional offsets a scaled display reports, not a gesture.
 */
const SCROLL_BACK_EPSILON = 1; // pixels

interface UseAutoScrollOptions {
    /**
     * Distance from bottom (in pixels) to consider "at bottom"
     * @default 120
     */
    threshold?: number;
    /**
     * Whether this is being used in the separate window (uses independent scroll state)
     *
     * @default false
     */
    isWindow?: boolean;
}

interface UseAutoScrollReturn {
    scrollContainerRef: RefObject<HTMLDivElement>;
    setScrollContainerRef: (node: HTMLDivElement | null) => void;
    handleScroll: () => void;
}

/**
 * Auto-scroll state for a thread container: whether to keep following the
 * bottom, and where the container sits.
 *
 * Following stops on a real input gesture on the container — a wheel turned
 * up, a finger dragged down, one of the scroll-back keys. Those events only
 * exist because a person produced them: writing `scrollTop` to follow a
 * response fires scroll events but no wheel, touch or key events, so nothing
 * auto-scroll does can be mistaken for the reader wanting out of it. Following
 * resumes when the container comes back down to its bottom.
 *
 * Dragging the scrollbar thumb produces none of those events, only a scroll,
 * so it is caught in the scroll handler instead — see there for how a drag is
 * told apart from auto-scroll's own writes.
 *
 * Two separate facts are written from here, and they answer different
 * questions — see react/utils/scrollPosition.ts:
 *
 * - the measured position (`isAtBottom`), published on every scroll event
 * - the reader's intent (`userScrolled`), latched by the gestures below
 *
 * @param forwardedRef Optional ref to forward (for forwardRef components)
 * @param options Configuration options
 * @returns Scroll container ref, ref setter, and scroll handler
 */
export function useAutoScroll(
    forwardedRef?: ForwardedRef<HTMLDivElement>,
    options: UseAutoScrollOptions = {}
): UseAutoScrollReturn {
    const {
        threshold = BOTTOM_THRESHOLD,
        isWindow = false
    } = options;

    // Select the correct atoms based on whether we're in the separate window
    const scrollAtoms = getScrollAtoms(isWindow);
    const scrolledAtom = scrollAtoms.userScrolled;
    const scrollPositionAtom = scrollAtoms.position;

    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    // The same element as the ref, held in state so the gesture listeners below
    // can be re-registered when the container is replaced — a ref assignment
    // notifies nobody, and ThreadView swaps the container between its empty
    // state and the thread itself.
    const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
    const lastStoredScrollTopRef = useRef(0); // Track what we last stored in atom
    // Where the container sat at the previous scroll event, so this one can be
    // read as a direction rather than a position.
    const lastObservedScrollTopRef = useRef(0);
    const lastTouchYRef = useRef<number | null>(null);

    const setScrollContainerRef = useCallback((node: HTMLDivElement | null) => {
        scrollContainerRef.current = node;
        setScrollContainer(node);

        // The remembered-offset baselines belong to the element they were
        // measured on; carrying them across a swap would read the new
        // container's first scroll event as a jump of the difference between
        // the two.
        lastStoredScrollTopRef.current = node?.scrollTop ?? 0;
        lastObservedScrollTopRef.current = node?.scrollTop ?? 0;

        if (!forwardedRef) {
            return;
        }

        if (typeof forwardedRef === 'function') {
            forwardedRef(node);
        } else {
            forwardedRef.current = node;
        }
    }, [forwardedRef]);

    /**
     * Stop following the bottom because the reader moved the container back.
     *
     * Ignores gestures a hidden container cannot have received.
     *
     * @param movedBack Whether the caller has already established that the
     * container moved backwards. A gesture has not, so a gesture on a container
     * already scrolled as far back as it goes is ignored too: an upward wheel
     * with nothing above to reveal has not taken the reader anywhere, and
     * latching on it would leave a short thread — one that does not fill its
     * viewport yet — refusing to follow the response about to fill it. A
     * movement that has already happened is its own evidence, including one
     * that came to rest at the very top.
     */
    const detachFromBottom = useCallback((movedBack = false) => {
        const container = scrollContainerRef.current;
        if (!container || container.clientHeight === 0) {
            return;
        }
        if (!movedBack && container.scrollTop <= 0) {
            return;
        }
        store.set(scrolledAtom, true);
    }, [scrolledAtom]);

    /**
     * Whether a scroll-back gesture aimed at `target` is going to move this
     * container, or be spent before it reaches it.
     *
     * The listeners below sit on the container, so they see every gesture made
     * anywhere inside the thread — including ones that have nothing to do with
     * scrolling it. A run can hold its own scrollable box (a batch outcome list,
     * a preview of an action's payload), and a message being edited holds a text
     * editor whose caret the arrow keys move. Both take the movement for
     * themselves and leave the thread exactly where it was, so reading either as
     * the reader stepping out of the response would strand them: the thread
     * never moves, so it never comes back to its bottom, and nothing resumes.
     *
     * Assumes a light-DOM tree, which is what the thread renders. An event from
     * inside a shadow root arrives retargeted to its host, so a scrollable box
     * within one would be invisible here and read as a gesture on the thread.
     */
    const gestureMovesThisContainer = useCallback((target: EventTarget | null): boolean => {
        const container = scrollContainerRef.current;
        if (!container) {
            return true;
        }
        const defaultView = container.ownerDocument.defaultView;
        // Nothing to reason about, so take the gesture at face value.
        if (!defaultView || !(target instanceof defaultView.Element)) {
            return true;
        }
        const win: Window & typeof globalThis = defaultView;

        for (let node: Element | null = target; node && node !== container; node = node.parentElement) {
            if (node instanceof win.HTMLElement && node.isContentEditable) {
                return false;
            }
            const tag = node.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') {
                return false;
            }
            // Cheap checks first: only a box with somewhere left to scroll back
            // to is worth asking the style engine about.
            if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight) {
                const overflowY = win.getComputedStyle(node)?.overflowY;
                if (overflowY === 'auto' || overflowY === 'scroll') {
                    return false;
                }
            }
        }

        return true;
    }, []);

    // Gesture listeners live on the container itself, so they see only what the
    // reader did to this thread. Registered against the element in state, and
    // torn down when it is replaced or the surface unmounts.
    useEffect(() => {
        if (!scrollContainer) {
            return;
        }

        // A wheel turned up, whatever produced it (mouse wheel, trackpad,
        // inertia from either). The downward direction is left alone: it moves
        // towards the bottom, which is where following would have gone anyway.
        const handleWheel = (event: WheelEvent) => {
            // Already detached: there is nothing left to latch, and the walk
            // below reads layout. An inertial scroll delivers these for as long
            // as it keeps moving, and during a response the DOM is dirtied every
            // frame, so answering it would mean a synchronous reflow per event
            // for an answer that cannot change anything.
            if (event.deltaY >= 0 || store.get(scrolledAtom)) {
                return;
            }
            if (gestureMovesThisContainer(event.target)) {
                detachFromBottom();
            }
        };

        const handleTouchStart = (event: TouchEvent) => {
            lastTouchYRef.current = event.touches[0]?.clientY ?? null;
        };

        // A finger dragged *down* the screen pulls the content down, revealing
        // what is above — the touch equivalent of scrolling back.
        const handleTouchMove = (event: TouchEvent) => {
            const y = event.touches[0]?.clientY;
            if (y === undefined) {
                return;
            }
            const previousY = lastTouchYRef.current;
            lastTouchYRef.current = y;
            if (previousY === null || y <= previousY || store.get(scrolledAtom)) {
                return;
            }
            if (gestureMovesThisContainer(event.target)) {
                detachFromBottom();
            }
        };

        const handleTouchEnd = () => {
            lastTouchYRef.current = null;
        };


        // Passive: none of these handlers calls preventDefault, and saying so
        // keeps them off the scrolling critical path.
        scrollContainer.addEventListener('wheel', handleWheel, { passive: true });
        scrollContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
        scrollContainer.addEventListener('touchmove', handleTouchMove, { passive: true });
        scrollContainer.addEventListener('touchend', handleTouchEnd, { passive: true });
        scrollContainer.addEventListener('touchcancel', handleTouchEnd, { passive: true });

        return () => {
            scrollContainer.removeEventListener('wheel', handleWheel);
            scrollContainer.removeEventListener('touchstart', handleTouchStart);
            scrollContainer.removeEventListener('touchmove', handleTouchMove);
            scrollContainer.removeEventListener('touchend', handleTouchEnd);
            scrollContainer.removeEventListener('touchcancel', handleTouchEnd);
            lastTouchYRef.current = null;
        };
    }, [scrollContainer, detachFromBottom, gestureMovesThisContainer, scrolledAtom]);

    /**
     * Report where the container sits, and resume following once it is back at
     * the bottom.
     *
     * Runs for every scroll event, the reader's and auto-scroll's alike. It is
     * also the only place a scrollbar drag can be noticed, since that gesture
     * produces no other event — so it does read intent from a scroll, but only
     * for a movement no scroll this code performed accounts for.
     */
    const handleScroll = useCallback(() => {
        const container = scrollContainerRef.current;
        if (!container) {
            return;
        }

        const { scrollTop, scrollHeight, clientHeight } = container;

        // Ignore scroll events when the container is hidden or has no height
        if (clientHeight === 0) {
            return;
        }

        const previousScrollTop = lastObservedScrollTopRef.current;
        lastObservedScrollTopRef.current = scrollTop;

        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

        // Published from the numbers already read above rather than measured
        // again, and before the branch below: where the container sits is
        // settled by this event whatever it goes on to mean.
        publishDistanceFromBottom(distanceFromBottom, scrollAtoms, threshold);

        // Resume following once the container is back at its bottom, however it
        // got there — the reader scrolling down to the end, or content shrinking
        // under them until the end is where they already were.
        //
        // Against `AT_BOTTOM_EPSILON`, not the threshold this hook publishes
        // against: a reader who scrolls back 50px is still inside the band that
        // hides the scroll-down button, and resuming there would take away the
        // intent their gesture just recorded.
        if (distanceFromBottom <= AT_BOTTOM_EPSILON) {
            store.set(scrolledAtom, false);
        } else if (
            scrollTop < previousScrollTop - SCROLL_BACK_EPSILON &&
            !wasProgrammaticScroll(container, scrollTop)
        ) {
            // Dragging the scrollbar thumb back through the thread is the one
            // way of moving this container that produces no wheel, touch or key
            // event, so this is where it has to be caught. A scroll event that
            // left the container higher than it was, at an offset none of the
            // code that scrolls it wrote, was the reader's doing — and detaches
            // exactly as an upward wheel does.
            //
            // Checked second, after the bottom, because content shrinking under
            // a reader who is at the end clamps `scrollTop` down and looks like
            // the same movement. Where it comes to rest separates them: a
            // clamp leaves the container at its (new) bottom, and a reader
            // scrolling back does not stop there.
            //
            // The attribution is best-effort by construction, since scroll
            // events are dispatched after the fact: a drag whose event is
            // overtaken by the next frame of a response reports the offset that
            // frame pinned, and is read as ours. That costs one event of a
            // gesture that produces many, and the next one detaches. It cannot
            // fail the other way — see markProgrammaticScroll for why nothing
            // here can be left latched.
            detachFromBottom(true);
        }

        // Only update scroll position atom if there's a meaningful change
        // This reduces jitter from micro-updates during animation
        const scrollPositionDelta = Math.abs(scrollTop - lastStoredScrollTopRef.current);
        if (scrollPositionDelta > SCROLL_POSITION_UPDATE_THRESHOLD) {
            store.set(scrollPositionAtom, scrollTop);
            lastStoredScrollTopRef.current = scrollTop;
        }
    }, [threshold, scrollAtoms, scrolledAtom, scrollPositionAtom, detachFromBottom]);

    return {
        scrollContainerRef,
        setScrollContainerRef,
        handleScroll
    };
}

