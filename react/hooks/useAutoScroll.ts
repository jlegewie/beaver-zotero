import { useRef, useCallback, useEffect, ForwardedRef, RefObject } from 'react';
import { store } from '../store';
import { userScrolledAtom } from '../atoms/ui';
import { currentThreadScrollPositionAtom } from '../atoms/threads';

const BOTTOM_THRESHOLD = 120; // pixels

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
     * @default 10
     */
    upScrollThreshold?: number;
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
        debounceDelay = 150,
        upScrollThreshold = 10
    } = options;

    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const lastScrollTopRef = useRef(0);
    const scrollDebounceTimer = useRef<number | null>(null);
    const lastScrollDirectionRef = useRef<'up' | 'down' | null>(null);

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

        const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
        
        // Detect scroll direction
        const scrollDirection = scrollTop > lastScrollTopRef.current ? 'down' : 
                               scrollTop < lastScrollTopRef.current ? 'up' : null;
        
        // Only consider it a "user scroll" if they scroll UP significantly
        // or if they scroll down but stop far from the bottom
        // This prevents layout shifts from streaming content from being detected as user scrolls
        if (scrollDirection === 'up' && Math.abs(scrollTop - lastScrollTopRef.current) > upScrollThreshold) {
            // Clear any existing debounce timer
            if (scrollDebounceTimer.current !== null) {
                clearTimeout(scrollDebounceTimer.current);
            }
            
            // User deliberately scrolled up
            store.set(userScrolledAtom, true);
            lastScrollDirectionRef.current = 'up';
        } else if (distanceFromBottom > threshold) {
            // Only set userScrolled after a debounce delay to avoid false positives
            // from rapid layout shifts during streaming
            if (scrollDebounceTimer.current !== null) {
                clearTimeout(scrollDebounceTimer.current);
            }
            
            scrollDebounceTimer.current = Zotero.getMainWindow().setTimeout(() => {
                // Double-check after debounce
                if (scrollContainerRef.current) {
                    const { scrollTop: currentScrollTop, scrollHeight: currentScrollHeight, clientHeight: currentClientHeight } = scrollContainerRef.current;
                    const currentDistanceFromBottom = currentScrollHeight - currentScrollTop - currentClientHeight;
                    if (currentDistanceFromBottom > threshold) {
                        store.set(userScrolledAtom, true);
                    }
                }
            }, debounceDelay);
        } else {
            // Near the bottom - user hasn't scrolled
            store.set(userScrolledAtom, false);
            lastScrollDirectionRef.current = 'down';
        }

        store.set(currentThreadScrollPositionAtom, scrollTop);
        lastScrollTopRef.current = scrollTop;
    }, [threshold, debounceDelay, upScrollThreshold]);

    // Cleanup debounce timer on unmount
    useEffect(() => {
        return () => {
            if (scrollDebounceTimer.current !== null) {
                clearTimeout(scrollDebounceTimer.current);
            }
        };
    }, []);

    return {
        scrollContainerRef,
        setScrollContainerRef,
        handleScroll
    };
}

