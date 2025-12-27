import { useRef, useCallback, useEffect, ForwardedRef, RefObject } from 'react';
import { store } from '../store';
import { userScrolledAtom, windowUserScrolledAtom } from '../atoms/ui';
import { currentThreadScrollPositionAtom, windowScrollPositionAtom } from '../atoms/threads';

const BOTTOM_THRESHOLD = 120; // pixels
const SCROLL_POSITION_UPDATE_THRESHOLD = 10; // pixels - minimum change to update scroll position atom

interface UseAutoScrollOptions {
    /**
     * Distance from bottom (in pixels) to consider "at bottom"
     * @default 120
     */
    threshold?: number;
    /**
     * Debounce delay (in ms) before marking as "user scrolled"
     * @default 150
     */
    debounceDelay?: number;
    /**
     * Minimum scroll distance (in pixels) to detect upward user scroll
     * @default 50
     */
    upScrollThreshold?: number; // kept for compatibility but unused
    /**
     * Number of consecutive upward scroll events required to confirm user scroll
     * @default 3
     */
    upScrollConsecutiveRequired?: number; // kept for compatibility but unused
    /**
     * Whether this is being used in the separate window (uses independent scroll state)

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
 * Hook for managing auto-scroll behavior with intelligent user scroll detection
 * 
 * Features:
 * - Detects deliberate upward scrolls immediately
 * - Tolerates layout shifts from streaming content via debouncing
 * - Maintains scroll position across thread changes
 * - Throttles scroll position atom updates to reduce jitter
 * 
 * @param forwardedRef Optional ref to forward (for forwardRef components)
 * @param options Configuration options
 * @returns Scroll container ref, ref setter, and scroll handler
 */
export function useAutoScroll(
    forwardedRef?: ForwardedRef<HTMLDivElement>,
    options: UseAutoScrollOptions = {}
): UseAutoScrollReturn {
    const win = Zotero.getMainWindow();
    const {
        threshold = BOTTOM_THRESHOLD,
        debounceDelay = 150,
        isWindow = false
    } = options;

    // Select the correct atoms based on whether we're in the separate window
    const scrolledAtom = isWindow ? windowUserScrolledAtom : userScrolledAtom;
    const scrollPositionAtom = isWindow ? windowScrollPositionAtom : currentThreadScrollPositionAtom;

    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const lastScrollTopRef = useRef(0);
    const lastStoredScrollTopRef = useRef(0); // Track what we last stored in atom
    const scrollDebounceTimer = useRef<number | null>(null);
    const lastScrollDirectionRef = useRef<'up' | 'down' | null>(null);
    const cumulativeUpScrollRef = useRef(0); // Track cumulative upward scroll distance
    const cumulativeResetTimer = useRef<number | null>(null);
    const lastScrolledStateRef = useRef(false); // Track last scrolled state to avoid redundant updates

    const setScrollContainerRef = useCallback((node: HTMLDivElement | null) => {
        scrollContainerRef.current = node;

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
     * Handle scroll events with intelligent user scroll detection
     * 
     * Logic:
     * 1. Upward scrolls accumulate; when cumulative distance exceeds threshold → mark as user scroll
     * 2. Near bottom (< threshold) → continue autoscroll
     * 3. Far from bottom (> threshold) → debounce before marking as user scroll
     */
    const handleScroll = useCallback(() => {
        if (!scrollContainerRef.current) {
            return;
        }

        const clearDebounceTimer = () => {
            if (scrollDebounceTimer.current === null) {
                return;
            }
            win.clearTimeout(scrollDebounceTimer.current);
            scrollDebounceTimer.current = null;
        };

        const clearCumulativeResetTimer = () => {
            if (cumulativeResetTimer.current !== null) {
                win.clearTimeout(cumulativeResetTimer.current);
                cumulativeResetTimer.current = null;
            }
        };

        const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;

        // Ignore scroll events when the container is hidden or has no height
        if (clientHeight === 0) {
            return;
        }

        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
        
        // Detect scroll direction and magnitude
        const scrollDelta = scrollTop - lastScrollTopRef.current;
        const scrollDirection = scrollTop > lastScrollTopRef.current ? 'down' : 
                               scrollTop < lastScrollTopRef.current ? 'up' : null;
        
        // Handle upward scrolling (interruption)
        if (scrollDirection === 'up') {
            // Accumulate upward scroll distance
            cumulativeUpScrollRef.current += Math.abs(scrollDelta);
            
            // Schedule reset of cumulative counter if user stops scrolling
            clearCumulativeResetTimer();
            cumulativeResetTimer.current = win.setTimeout(() => {
                cumulativeUpScrollRef.current = 0;
                cumulativeResetTimer.current = null;
            }, 200);

            // If cumulative upward scroll exceeds threshold, mark as user scrolled
            // This filters out single small layout shifts but catches deliberate scrolling
            if (cumulativeUpScrollRef.current > 15) { // 15px threshold for high responsiveness
                clearDebounceTimer();
                if (!lastScrolledStateRef.current) {
                    store.set(scrolledAtom, true);
                    lastScrolledStateRef.current = true;
                }
                lastScrollDirectionRef.current = 'up';
            }
        } else if (distanceFromBottom > threshold) {
            // Scrolling down or stationary but far from bottom
            // Reset cumulative upward counter
            cumulativeUpScrollRef.current = 0;
            clearCumulativeResetTimer();

            // Only set userScrolled after a debounce delay to avoid false positives
            // from rapid layout shifts during streaming
            clearDebounceTimer();
            
            scrollDebounceTimer.current = win.setTimeout(() => {
                // Double-check after debounce
                if (scrollContainerRef.current) {
                    const { scrollTop: currentScrollTop, scrollHeight: currentScrollHeight, clientHeight: currentClientHeight } = scrollContainerRef.current;
                    const currentDistanceFromBottom = currentScrollHeight - currentScrollTop - currentClientHeight;
                    if (currentDistanceFromBottom > threshold && !lastScrolledStateRef.current) {
                        store.set(scrolledAtom, true);
                        lastScrolledStateRef.current = true;
                    }
                }
            }, debounceDelay);
        } else {
            // Near the bottom - user hasn't scrolled
            // Reset counters when near bottom
            cumulativeUpScrollRef.current = 0;
            clearCumulativeResetTimer();
            clearDebounceTimer();
            
            // Only update if state actually changed to avoid unnecessary re-renders
            if (lastScrolledStateRef.current) {
                store.set(scrolledAtom, false);
                lastScrolledStateRef.current = false;
            }
            lastScrollDirectionRef.current = 'down';
        }

        // Only update scroll position atom if there's a meaningful change
        // This reduces jitter from micro-updates during animation
        const scrollPositionDelta = Math.abs(scrollTop - lastStoredScrollTopRef.current);
        if (scrollPositionDelta > SCROLL_POSITION_UPDATE_THRESHOLD) {
            store.set(scrollPositionAtom, scrollTop);
            lastStoredScrollTopRef.current = scrollTop;
        }
        
        lastScrollTopRef.current = scrollTop;
    }, [threshold, debounceDelay, win, scrolledAtom, scrollPositionAtom]);

    // Cleanup timers on unmount
    useEffect(() => {
        return () => {
            if (scrollDebounceTimer.current !== null) {
                win.clearTimeout(scrollDebounceTimer.current);
                scrollDebounceTimer.current = null;
            }
            if (cumulativeResetTimer.current !== null) {
                win.clearTimeout(cumulativeResetTimer.current);
                cumulativeResetTimer.current = null;
            }
        };
    }, [win]);

    return {
        scrollContainerRef,
        setScrollContainerRef,
        handleScroll
    };
}

