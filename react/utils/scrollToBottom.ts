import { store } from "../store";
import { userScrolledAtom } from "../atoms/ui";
import type { WritableAtom } from "jotai";

// Function to scroll to the bottom of the chat container
// const scrollToBottom = () => {
//   if (containerRef.current && !userScrolled) {
//     containerRef.current.scrollTop = containerRef.current.scrollHeight;
//   }
// };

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
    const startScrollTop = container.scrollTop;
    const distance = targetScrollTop - startScrollTop;
    
    // If already at bottom or nearly at bottom, just jump there
    // Allow for small negative distance if already overscrolled by a tiny bit
    if (distance < 50 && distance > -5) { 
        container.scrollTop = targetScrollTop;
        return;
    }
    
    // Otherwise animate scroll
    // Animation duration based on distance (faster for shorter distances)
    const duration = Math.min(300, 100 + Math.sqrt(Math.abs(distance)) * 5); 

    let start: number | null = null;
    // expectedScrollTop tracks where the animation intends the scrollTop to be.
    // Initialize with the current scrollTop in case it's already moving.
    let expectedScrollTop = container.scrollTop; 

    const step = (timestamp: number) => {
        if (!start) {
            start = timestamp;
            // Re-initialize expectedScrollTop and startScrollTop at the true beginning of the animation
            // to correctly calculate the path, especially if container.scrollTop changed before animation started.
            expectedScrollTop = container.scrollTop; 
            const currentStartScrollTop = container.scrollTop;
            const currentDistance = targetScrollTop - currentStartScrollTop;
            
            // If, after re-checking, we are already at the bottom or no scroll is needed.
            if (currentDistance < 5 && currentDistance > -5) {
                container.scrollTop = targetScrollTop;
                return;
            }
        }
        const progress = timestamp - start!; // start is guaranteed to be non-null here
        const percentage = Math.min(progress / duration, 1);
        
        // Check for interruption before setting scrollTop
        if (progress > 20) {
            // A threshold of 20-30 pixels for interruption detection.
            if (Math.abs(container.scrollTop - expectedScrollTop) > 30) { 
                // User scrolled, abort animation
                return;
            }
        }

        const eased = 1 - (1 - percentage) * (1 - percentage); 
        // Calculate the next position based on the original start and distance
        const nextAnimatedScrollTop = startScrollTop + distance * eased;
        
        container.scrollTop = nextAnimatedScrollTop;
        expectedScrollTop = nextAnimatedScrollTop; // Update for the next frame's check

        if (progress < duration) {
            Zotero.getMainWindow().requestAnimationFrame(step);
        } else {
            // Ensure it ends exactly at the target if animation completes
            container.scrollTop = targetScrollTop;
        }
    };

    Zotero.getMainWindow().requestAnimationFrame(step);
};
