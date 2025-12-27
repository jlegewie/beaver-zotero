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
    upScrollThreshold?: number;
    /**
     * Number of consecutive upward scroll events required to confirm user scroll
     * @default 3
     */
    upScrollConsecutiveRequired?: number;
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
        upScrollThreshold = 50,
        upScrollConsecutiveRequired = 3,
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
    const consecutiveUpScrollsRef = useRef(0);
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
     * 1. Upward scrolls > threshold → immediately mark as user scroll
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
        
        // Only consider it a "user scroll" if they scroll UP significantly AND consistently
        // or if they scroll down but stop far from the bottom
        // This prevents layout shifts from streaming content from being detected as user scrolls
        if (scrollDirection === 'up' && Math.abs(scrollDelta) > upScrollThreshold) {
            consecutiveUpScrollsRef.current++;
            
            // Only mark as user scrolled after multiple consecutive upward scrolls
            // This filters out layout-induced scroll jumps during streaming
            if (consecutiveUpScrollsRef.current >= upScrollConsecutiveRequired) {
                clearDebounceTimer();
                if (!lastScrolledStateRef.current) {
                    store.set(scrolledAtom, true);
                    lastScrolledStateRef.current = true;
                }
                lastScrollDirectionRef.current = 'up';
            }
        } else if (distanceFromBottom > threshold) {
            // Reset consecutive counter on non-upward scroll
            consecutiveUpScrollsRef.current = 0;
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
            // Reset consecutive counter when near bottom
            consecutiveUpScrollsRef.current = 0;
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
    }, [threshold, debounceDelay, upScrollThreshold, upScrollConsecutiveRequired, win, scrolledAtom, scrollPositionAtom]);

    // Cleanup debounce timer on unmount
    useEffect(() => {
        return () => {
            if (scrollDebounceTimer.current === null) {
                return;
            }
            win.clearTimeout(scrollDebounceTimer.current);
            scrollDebounceTimer.current = null;
        };
    }, [win]);

    return {
        scrollContainerRef,
        setScrollContainerRef,
        handleScroll
    };
}

