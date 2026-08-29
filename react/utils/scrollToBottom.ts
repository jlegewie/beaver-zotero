import { store } from "../store";
import { userScrolledAtom } from "../atoms/ui";
import { markProgrammaticScroll } from "./scrollPosition";
import type { WritableAtom } from "jotai";

// Threshold for detecting user scroll interruption during animation
const INTERRUPTION_THRESHOLD = 10; // pixels - sensitive to any user movement
// Minimum progress before checking for interruption (allow animation to stabilize)
const MIN_PROGRESS_FOR_INTERRUPTION_CHECK = 20; // ms

/**
 * Distance below which an animated scroll is not worth animating. Easing across
 * a line or two reads as a stutter rather than as movement, so those jump.
 */
const MIN_ANIMATION_DISTANCE = 50; // pixels

/**
 * The animation frame currently stepping each container.
 *
 * Two easing loops writing one `scrollTop` do not average out. Each carries its
 * own idea of where the container should be by now and reads the other's writes
 * as the reader taking over, so they abort each other part-way and leave the
 * thread stranded mid-scroll. At most one may own a container, and every entry
 * point below cancels the incumbent before it starts.
 *
 * Keyed by container rather than held in one module-level slot, so the sidebars
 * and the separate Beaver window — which share this bundle but scroll
 * independently — never cancel each other's scrolls. Each handle is scheduled
 * and cancelled through its own container's window, the only window that can
 * cancel it; a handle left behind by a window that has since closed is never
 * read again and falls out of the map with the element.
 */
const animationFrames = new WeakMap<HTMLElement, number>();

/** The window an element lives in. Null once that window is gone. */
const containerWindow = (container: HTMLElement) => container.ownerDocument.defaultView;

/** Stop the animation stepping this container, if one is running. */
const cancelAnimation = (container: HTMLElement): void => {
    const handle = animationFrames.get(container);
    if (handle === undefined) {
        return;
    }
    animationFrames.delete(container);
    containerWindow(container)?.cancelAnimationFrame(handle);
};

/**
 * Put the container at its bottom now, without animating.
 *
 * This is what following a response means. Content arrives many times a second
 * and every arrival moves the bottom, so each arrival is a fresh assignment —
 * not a three-hundred-millisecond journey towards a bottom that has moved again
 * long before it is reached. Assigning per frame is also what keeps the thread
 * still: the reader sees the new line appear in place, with no motion under it.
 *
 * Does nothing when the reader has scrolled back, or when the container is not
 * on screen — a collapsed pane reports a zero client height and offsets that
 * describe nothing.
 */
export const pinToBottom = (
    containerRef: React.RefObject<HTMLElement>,
    customScrolledAtom?: WritableAtom<boolean, [boolean], void>
): void => {
    const container = containerRef.current;
    if (!container || container.clientHeight === 0) {
        return;
    }
    if (store.get(customScrolledAtom ?? userScrolledAtom)) {
        return;
    }

    // A pin supersedes an animation heading for the same bottom. Left running,
    // it would write `scrollTop` from a second place and read the pin's jumps as
    // the reader taking over.
    cancelAnimation(container);

    const target = Math.max(container.scrollHeight - container.clientHeight, 0);
    container.scrollTop = target;
    // Marked with the offset written rather than the one read back: this runs on
    // every frame of a response, and the read-back would make the browser
    // resolve the scroll before the frame is done with it.
    markProgrammaticScroll(container, 0, target);
};

/**
 * Smoothly scroll a container to the bottom, for a one-off jump the reader
 * asked for. Following a streaming response is `pinToBottom`, not this.
 *
 * Unconditional by design, and the difference from `pinToBottom`: every caller
 * is acting on something the reader just did — pressing the scroll-down button,
 * or an approval arriving that needs an answer — so having scrolled back is not
 * a reason to refuse. Callers that want the reader's intent respected want
 * `pinToBottom`.
 *
 * Can be interrupted by the reader scrolling while it runs.
 *
 * @param containerRef Ref to the scroll container
 * @returns Whether an animation was started. False when the container was
 * already at (or close to) the bottom and the scroll completed synchronously,
 * so a caller that locks other scroll handling out for the length of the
 * animation has nothing to lock out.
 */
export const scrollToBottom = (
    containerRef: React.RefObject<HTMLElement>
): boolean => {
    const container = containerRef.current;
    // Nothing to scroll if the container is missing or not on screen.
    if (!container || container.clientHeight === 0) {
        return false;
    }

    // Whatever this container was doing, this call replaces it.
    cancelAnimation(container);

    const win = containerWindow(container);
    const targetScrollTop = Math.max(container.scrollHeight - container.clientHeight, 0);
    const initialScrollTop = container.scrollTop;
    const initialDistance = targetScrollTop - initialScrollTop;

    // If already at bottom or nearly at bottom, just jump there.
    // Allow for small negative distance if already overscrolled by a tiny bit.
    // Also the fallback when there is no window left to schedule frames on.
    if (!win || (initialDistance < MIN_ANIMATION_DISTANCE && initialDistance > -5)) {
        container.scrollTop = targetScrollTop;
        markProgrammaticScroll(container);
        return false;
    }

    // Otherwise animate scroll
    // Animation duration based on distance (faster for shorter distances)
    const duration = Math.min(300, 100 + Math.sqrt(Math.abs(initialDistance)) * 5);

    let start: number | null = null;
    // Track animation state for interruption detection
    let animationStartScrollTop = initialScrollTop;
    let animationDistance = initialDistance;
    let expectedScrollTop = initialScrollTop;

    const step = (timestamp: number) => {
        // The frame that is running is no longer pending. The slot is re-claimed
        // below if this loop schedules another, and left empty if it does not,
        // so it never holds a handle that cannot be cancelled.
        animationFrames.delete(container);

        if (start === null) {
            start = timestamp;
            // Re-initialize at the true beginning of the animation
            // This handles cases where scrollTop changed between call and first frame
            animationStartScrollTop = container.scrollTop;
            animationDistance = targetScrollTop - animationStartScrollTop;
            expectedScrollTop = animationStartScrollTop;

            // If, after re-checking, we are already at the bottom or no scroll is needed
            if (animationDistance < 5 && animationDistance > -5) {
                container.scrollTop = targetScrollTop;
                markProgrammaticScroll(container);
                return;
            }
        }

        const progress = timestamp - start;
        const percentage = Math.min(progress / duration, 1);

        // Check for user interruption after animation has had time to stabilize
        // Use a higher threshold to avoid false positives from layout shifts
        if (progress > MIN_PROGRESS_FOR_INTERRUPTION_CHECK) {
            const deviation = Math.abs(container.scrollTop - expectedScrollTop);
            if (deviation > INTERRUPTION_THRESHOLD) {
                // User scrolled significantly away from expected position, abort animation
                return;
            }
        }

        // Ease-out quadratic for smooth deceleration
        const eased = 1 - (1 - percentage) * (1 - percentage);
        const nextAnimatedScrollTop = animationStartScrollTop + animationDistance * eased;

        container.scrollTop = nextAnimatedScrollTop;
        markProgrammaticScroll(container);
        expectedScrollTop = nextAnimatedScrollTop;

        if (progress < duration) {
            animationFrames.set(container, win.requestAnimationFrame(step));
        } else {
            // Ensure it ends exactly at the target if animation completes
            container.scrollTop = targetScrollTop;
            markProgrammaticScroll(container);
        }
    };

    animationFrames.set(container, win.requestAnimationFrame(step));
    return true;
};
