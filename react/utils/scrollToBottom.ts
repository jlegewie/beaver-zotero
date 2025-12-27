import { store } from "../store";
import { userScrolledAtom } from "../atoms/ui";
import type { WritableAtom } from "jotai";

// Threshold for detecting user scroll interruption during animation
const INTERRUPTION_THRESHOLD = 50; // pixels
// Minimum progress before checking for interruption (allow animation to stabilize)
const MIN_PROGRESS_FOR_INTERRUPTION_CHECK = 50; // ms

/**
 * Smoothly scroll a container to the bottom with animation.
 * Respects user scroll state and can be interrupted by user scrolling.
 * @param containerRef Ref to the scroll container
 * @param userScrolledOverride Optional override for user scrolled state
 * @param customScrolledAtom Optional custom atom to read scrolled state from
 */
export const scrollToBottom = (
    containerRef: React.RefObject<HTMLElement>,
    userScrolledOverride?: boolean,
    customScrolledAtom?: WritableAtom<boolean, [boolean], void>
) => {
    const atomToRead = customScrolledAtom ?? userScrolledAtom;
    const userScrolled = userScrolledOverride !== undefined ? userScrolledOverride : store.get(atomToRead);
    // If user has manually scrolled, or container doesn't exist, don't auto-scroll
    if (!containerRef.current || userScrolled) {
        return;
    }
    
    const container = containerRef.current;
    const targetScrollTop = Math.max(container.scrollHeight - container.clientHeight, 0);
    const initialScrollTop = container.scrollTop;
    const initialDistance = targetScrollTop - initialScrollTop;
    
    // If already at bottom or nearly at bottom, just jump there
    // Allow for small negative distance if already overscrolled by a tiny bit
    if (initialDistance < 50 && initialDistance > -5) { 
        container.scrollTop = targetScrollTop;
        return;
    }
    
    // Otherwise animate scroll
    // Animation duration based on distance (faster for shorter distances)
    const duration = Math.min(300, 100 + Math.sqrt(Math.abs(initialDistance)) * 5);
    const win = Zotero.getMainWindow();

    let start: number | null = null;
    // Track animation state for interruption detection
    let animationStartScrollTop = initialScrollTop;
    let animationDistance = initialDistance;
    let expectedScrollTop = initialScrollTop;

    const step = (timestamp: number) => {
        if (!start) {
            start = timestamp;
            // Re-initialize at the true beginning of the animation
            // This handles cases where scrollTop changed between call and first frame
            animationStartScrollTop = container.scrollTop;
            animationDistance = targetScrollTop - animationStartScrollTop;
            expectedScrollTop = animationStartScrollTop;
            
            // If, after re-checking, we are already at the bottom or no scroll is needed
            if (animationDistance < 5 && animationDistance > -5) {
                container.scrollTop = targetScrollTop;
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
        expectedScrollTop = nextAnimatedScrollTop;

        if (progress < duration) {
            win.requestAnimationFrame(step);
        } else {
            // Ensure it ends exactly at the target if animation completes
            container.scrollTop = targetScrollTop;
        }
    };

    win.requestAnimationFrame(step);
};
