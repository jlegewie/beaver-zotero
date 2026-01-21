import React, { useEffect, useRef, forwardRef, useLayoutEffect, useCallback } from "react";
import { useAtomValue } from "jotai";
import { allRunsAtom } from "../../agents/atoms";
import { AgentRunView } from "./AgentRunView";
import { scrollToBottom } from "../../utils/scrollToBottom";
import { userScrolledAtom, windowUserScrolledAtom } from "../../atoms/ui";
import { currentThreadScrollPositionAtom, windowScrollPositionAtom, currentThreadIdAtom } from "../../atoms/threads";
import { pendingApprovalsAtom } from "../../agents/agentActions";
import { store } from "../../store";
import { useAutoScroll } from "../../hooks/useAutoScroll";

const BOTTOM_THRESHOLD = 120; // pixels
const RESTORE_THRESHOLD = 100; // pixels - threshold for restoring scroll position
const RESTORE_DEBOUNCE_MS = 50; // ms - debounce delay for scroll restoration
const ANIMATION_LOCKOUT_MS = 400; // ms - time to wait after animation before allowing restore
const PENDING_APPROVAL_SCROLL_DELAY = 100; // ms - delay before scrolling for pending approval (allows content to render)

type ThreadViewProps = {
    /** Optional className for styling */
    className?: string;
    /** Whether this is rendered in the separate window (uses independent scroll state) */
    isWindow?: boolean;
};

/**
 * ThreadView renders all agent runs for the current thread.
 * Uses allRunsAtom which combines completed runs with any active streaming run.
 */
export const ThreadView = forwardRef<HTMLDivElement, ThreadViewProps>(
    function ThreadView({ className, isWindow = false }: ThreadViewProps, ref: React.ForwardedRef<HTMLDivElement>) {
        const win = Zotero.getMainWindow();
        const runs = useAtomValue(allRunsAtom);
        const restoredFromAtomRef = useRef(false);
        const currentThreadId = useAtomValue(currentThreadIdAtom);
        const prevThreadIdRef = useRef<string | null>(null);
        
        // Track pending approvals for scroll-to-bottom triggering
        // With parallel tool calls, there can be multiple pending approvals
        const pendingApprovalsMap = useAtomValue(pendingApprovalsAtom);
        const prevPendingApprovalIdsRef = useRef<Set<string>>(new Set());
        
        // Track visibility state for ResizeObserver
        const wasHiddenRef = useRef(true);
        // Track if we're currently animating scroll
        const isAnimatingRef = useRef(false);
        // Debounce timer for restore
        const restoreDebounceRef = useRef<number | null>(null);
        
        // Select the correct atoms based on whether we're in the separate window
        const scrollPositionAtom = isWindow ? windowScrollPositionAtom : currentThreadScrollPositionAtom;
        const scrolledAtom = isWindow ? windowUserScrolledAtom : userScrolledAtom;
        const storedScrollTop = useAtomValue(scrollPositionAtom);
        
        // Use the auto-scroll hook with window-aware state
        const { scrollContainerRef, setScrollContainerRef, handleScroll } = useAutoScroll(ref, {
            threshold: BOTTOM_THRESHOLD,
            isWindow
        });

        /**
         * Helper function to restore scroll position.
         * Only restores if there's a significant difference and we're not animating.
         */
        const restoreScrollPosition = useCallback((force = false) => {
            const container = scrollContainerRef.current;
            if (!container) {
                restoredFromAtomRef.current = false;
                return;
            }
            
            // Skip if hidden
            if (container.clientHeight === 0) {
                restoredFromAtomRef.current = false;
                return;
            }
            
            // Skip if currently animating (unless forced)
            if (isAnimatingRef.current && !force) {
                return;
            }

            const targetScrollTop = storedScrollTop ?? container.scrollHeight;
            const delta = Math.abs(container.scrollTop - targetScrollTop);
            
            // Check if this is a thread switch
            const isThreadSwitch = currentThreadId !== prevThreadIdRef.current;

            // Only restore if there's a significant difference (e.g., thread switch)
            // Use a larger threshold to avoid oscillation near boundaries
            if (delta > RESTORE_THRESHOLD) {
                restoredFromAtomRef.current = true;
                container.scrollTop = targetScrollTop;
                
                // Set scroll state based on position after restore
                const { scrollHeight, clientHeight } = container;
                const distanceFromBottom = scrollHeight - container.scrollTop - clientHeight;
                const isNearBottom = distanceFromBottom <= BOTTOM_THRESHOLD;
                store.set(scrolledAtom, !isNearBottom);
            } else {
                restoredFromAtomRef.current = false;
                
                // For small deltas (thread switch with similar position or streaming updates),
                // ensure scroll state is false if we're near the bottom.
                // IMPORTANT: Only do this on thread switch!
                // If we're just scrolling (user interaction), useAutoScroll handles the atom state.
                // Overwriting it here would hide the ScrollDownButton when the user scrolls up.
                if (isThreadSwitch) {
                    const { scrollHeight, clientHeight } = container;
                    const distanceFromBottom = scrollHeight - container.scrollTop - clientHeight;
                    if (distanceFromBottom <= BOTTOM_THRESHOLD) {
                        store.set(scrolledAtom, false);
                    }
                }
            }
        }, [storedScrollTop, scrolledAtom, scrollContainerRef, currentThreadId]);

        // Restore scroll position from atom (only for thread switching, not during streaming)
        // Note: userScrolledAtom is managed by useAutoScroll.handleScroll, not here
        useLayoutEffect(() => {
            restoreScrollPosition();
            prevThreadIdRef.current = currentThreadId;
        }, [restoreScrollPosition, currentThreadId]);

        // Watch for visibility transitions only (not all resize events)
        useEffect(() => {
            const container = scrollContainerRef.current;
            if (!container) return;

            const observer = new ResizeObserver((entries) => {
                const entry = entries[0];
                if (!entry) return;
                
                const isVisible = entry.contentRect.height > 0;
                const wasHidden = wasHiddenRef.current;
                
                // Only restore scroll position when transitioning from hidden to visible
                // This prevents interference during normal content growth or layout shifts
                if (wasHidden && isVisible) {
                    // Debounce to avoid rapid-fire restores during visibility transitions
                    if (restoreDebounceRef.current !== null) {
                        win.clearTimeout(restoreDebounceRef.current);
                    }
                    restoreDebounceRef.current = win.setTimeout(() => {
                        restoreDebounceRef.current = null;
                        restoreScrollPosition();
                    }, RESTORE_DEBOUNCE_MS);
                }
                
                wasHiddenRef.current = !isVisible;
            });
            
            observer.observe(container);
            return () => {
                observer.disconnect();
                if (restoreDebounceRef.current !== null) {
                    win.clearTimeout(restoreDebounceRef.current);
                }
            };
        }, [restoreScrollPosition, win]);

        // Scroll to bottom when runs change
        useEffect(() => {
            if (restoredFromAtomRef.current) {
                restoredFromAtomRef.current = false;
                return;
            }

            if (scrollContainerRef.current && runs.length > 0) {
                const container = scrollContainerRef.current;

                // Check if we're effectively at the bottom now (e.g. content shrunk due to retry/edit)
                // If we are within the threshold, we should reset userScrolled to allow auto-scroll.
                // This handles cases where the user was scrolled up, but the content size reduced 
                // such that they are now looking at the bottom.
                const { scrollHeight, clientHeight, scrollTop } = container;
                const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
                
                if (distanceFromBottom <= BOTTOM_THRESHOLD) {
                    store.set(scrolledAtom, false);
                }

                // Set animation flag to prevent restoreScrollPosition from interfering
                isAnimatingRef.current = true;
                
                // Pass the correct scroll atom for this context
                scrollToBottom(scrollContainerRef as React.RefObject<HTMLElement>, undefined, scrolledAtom);
                
                // Clear animation flag after animation completes (with buffer)
                win.setTimeout(() => {
                    isAnimatingRef.current = false;
                }, ANIMATION_LOCKOUT_MS);
            }
        }, [runs, scrolledAtom, win]);

        // Scroll to bottom when a new pending approval appears
        // This ensures the approval buttons are visible, even if user had scrolled up
        // Uses a delay to allow the AgentActionView to fully render/expand
        // With parallel tool calls, we track all pending approval IDs
        useEffect(() => {
            const currentApprovalIds = new Set(pendingApprovalsMap.keys());
            
            // Check if there are any NEW pending approvals (not seen before)
            let hasNewApproval = false;
            for (const id of currentApprovalIds) {
                if (!prevPendingApprovalIdsRef.current.has(id)) {
                    hasNewApproval = true;
                    break;
                }
            }
            
            // Only scroll if there's a NEW pending approval (not the same ones re-rendering)
            if (hasNewApproval) {
                const timeoutId = win.setTimeout(() => {
                    if (scrollContainerRef.current) {
                        // Force scroll to bottom for pending approvals - user action is required
                        // Reset userScrolled to allow auto-scroll
                        store.set(scrolledAtom, false);
                        
                        // Set animation flag
                        isAnimatingRef.current = true;
                        
                        // Force scroll to bottom (passing false to override userScrolled)
                        scrollToBottom(scrollContainerRef as React.RefObject<HTMLElement>, false, scrolledAtom);
                        
                        // Clear animation flag after animation completes
                        win.setTimeout(() => {
                            isAnimatingRef.current = false;
                        }, ANIMATION_LOCKOUT_MS);
                    }
                }, PENDING_APPROVAL_SCROLL_DELAY);
                
                prevPendingApprovalIdsRef.current = currentApprovalIds;
                
                return () => win.clearTimeout(timeoutId);
            }
            
            prevPendingApprovalIdsRef.current = currentApprovalIds;
        }, [pendingApprovalsMap, scrolledAtom, win]);

        if (runs.length === 0) {
            return (
                <div 
                    id="beaver-thread-view"
                    className={`display-flex flex-col flex-1 min-h-0 items-center justify-center ${className || ''}`}
                    ref={setScrollContainerRef}
                >
                    <p className="text-secondary">No messages yet</p>
                </div>
            );
        }

        return (
            <div 
                id="beaver-thread-view"
                className={`display-flex flex-col flex-1 min-h-0 overflow-y-auto gap-4 scrollbar min-w-0 pb-4 ${className || ''}`}
                onScroll={handleScroll}
                ref={setScrollContainerRef}
            >
                {runs.map((run, index) => (
                    <AgentRunView
                        key={run.id}
                        run={run}
                        isLastRun={index === runs.length - 1}
                    />
                ))}
            </div>
        );
    }
);

export default ThreadView;

