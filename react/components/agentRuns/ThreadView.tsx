import React, { useEffect, useRef, forwardRef, useLayoutEffect, useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { allRunsAtom } from "../../agents/atoms";
import { AgentRunView } from "./AgentRunView";
import { scrollToBottom } from "../../utils/scrollToBottom";
import { userScrolledAtom, windowUserScrolledAtom } from "../../atoms/ui";
import { currentThreadScrollPositionAtom, windowScrollPositionAtom, currentThreadIdAtom, pendingScrollToRunAtom, isLoadingThreadAtom } from "../../atoms/threads";
import { pendingApprovalsAtom } from "../../agents/agentActions";
import { store } from "../../store";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import { toolExpandedAtom, messageSourcesVisibilityAtom, annotationPanelStateAtom } from "../../atoms/messageUIState";
import { logger } from "../../../src/utils/logger";

const BOTTOM_THRESHOLD = 120; // pixels
const RESTORE_THRESHOLD = 100; // pixels - threshold for restoring scroll position
const RESTORE_DEBOUNCE_MS = 50; // ms - debounce delay for scroll restoration
const ANIMATION_LOCKOUT_MS = 400; // ms - time to wait after animation before allowing restore
const PENDING_APPROVAL_SCROLL_DELAY = 100; // ms - delay before scrolling for pending approval (allows content to render)
const EXPANSION_SCROLL_EVAL_DELAY = 50; // ms - delay before re-evaluating scroll state after expansion toggle
const PROTOCOL_SCROLL_LOCKOUT_MS = 800; // ms - block other scroll restorations right after protocol target jump

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
        const pendingRunId = useAtomValue(pendingScrollToRunAtom);
        const isLoadingThread = useAtomValue(isLoadingThreadAtom);
        const setPendingScrollToRun = useSetAtom(pendingScrollToRunAtom);
        const restoredFromAtomRef = useRef(false);
        const currentThreadId = useAtomValue(currentThreadIdAtom);
        const prevThreadIdRef = useRef<string | null>(null);
        
        // Track pending approvals for scroll-to-bottom triggering
        // With parallel tool calls, there can be multiple pending approvals
        const pendingApprovalsMap = useAtomValue(pendingApprovalsAtom);
        const prevPendingApprovalIdsRef = useRef<Set<string>>(new Set());
        
        // Track visibility state for ResizeObserver
        const wasHiddenRef = useRef(true);
        // Track previous container height for resize detection
        const prevContainerHeightRef = useRef(0);
        // Track if we're currently animating scroll
        const isAnimatingRef = useRef(false);
        // Debounce timer for restore
        const restoreDebounceRef = useRef<number | null>(null);
        // Target run element for protocol navigation
        const pendingRunElementRef = useRef<HTMLDivElement | null>(null);
        // Timestamp lock to prevent post-target-jump scroll overrides
        const protocolScrollLockUntilRef = useRef(0);
        
        // Select the correct atoms based on whether we're in the separate window
        const scrollPositionAtom = isWindow ? windowScrollPositionAtom : currentThreadScrollPositionAtom;
        const scrolledAtom = isWindow ? windowUserScrolledAtom : userScrolledAtom;
        const storedScrollTop = useAtomValue(scrollPositionAtom);
        
        // Watch expansion state to re-evaluate scroll button visibility after expand/collapse
        // Track multiple expansion states: tool calls, sources, and agent actions
        const toolExpansionState = useAtomValue(toolExpandedAtom);
        const sourcesVisibilityState = useAtomValue(messageSourcesVisibilityAtom);
        const annotationPanelState = useAtomValue(annotationPanelStateAtom);
        const prevExpansionStateRef = useRef(toolExpansionState);
        const prevSourcesVisibilityRef = useRef(sourcesVisibilityState);
        const prevAnnotationPanelRef = useRef(annotationPanelState);
        
        // Use the auto-scroll hook with window-aware state
        const { scrollContainerRef, setScrollContainerRef, handleScroll } = useAutoScroll(ref, {
            threshold: BOTTOM_THRESHOLD,
            isWindow
        });

        const isProtocolScrollLocked = useCallback(() => {
            return Date.now() < protocolScrollLockUntilRef.current;
        }, []);

        const tryScrollToPendingRun = useCallback((source: string, targetElement?: HTMLElement | null) => {
            if (!pendingRunId) {
                return false;
            }

            const container = scrollContainerRef.current;
            if (!container || container.clientHeight === 0) {
                return false;
            }

            const element = targetElement
                ?? pendingRunElementRef.current
                ?? container.querySelector<HTMLElement>(`#run-${CSS.escape(pendingRunId)}`);

            if (!element) {
                if (!isLoadingThread && !runs.some((run) => run.id === pendingRunId)) {
                    logger("ThreadView: pending run target not found after load", {
                        source,
                        pendingRunId,
                        currentThreadId,
                        runsCount: runs.length,
                    }, 1);
                    setPendingScrollToRun(null);
                }
                return false;
            }

            // Prevent restore/auto-bottom effects from overriding this jump.
            protocolScrollLockUntilRef.current = Date.now() + PROTOCOL_SCROLL_LOCKOUT_MS;
            isAnimatingRef.current = true;
            win.setTimeout(() => {
                isAnimatingRef.current = false;
            }, ANIMATION_LOCKOUT_MS);

            element.scrollIntoView({ behavior: "smooth", block: "start" });
            // Determine scroll state based on whether the target is near the bottom.
            // scrollIntoView is async (smooth), so check the position we'll end up at:
            // if the element's top is close enough to the bottom of scrollable content,
            // the final scroll position will be at/near the bottom.
            const { scrollHeight, clientHeight } = container;
            const elementOffsetTop = element.offsetTop;
            const projectedDistanceFromBottom = scrollHeight - elementOffsetTop - clientHeight;
            store.set(scrolledAtom, projectedDistanceFromBottom > BOTTOM_THRESHOLD);
            setPendingScrollToRun(null);
            return true;
        }, [pendingRunId, currentThreadId, isLoadingThread, scrollContainerRef, runs, scrolledAtom, setPendingScrollToRun, win]);

        const setPendingRunRef = useCallback((node: HTMLDivElement | null) => {
            pendingRunElementRef.current = node;
            if (node) {
                tryScrollToPendingRun("target-ref", node);
            }
        }, [tryScrollToPendingRun]);

        /**
         * Helper function to restore scroll position.
         * Only restores if there's a significant difference and we're not animating.
         */
        const restoreScrollPosition = useCallback((force = false) => {
            if (pendingRunId && !force) {
                restoredFromAtomRef.current = false;
                return;
            }
            if (isProtocolScrollLocked() && !force) {
                restoredFromAtomRef.current = false;
                return;
            }

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
        }, [pendingRunId, isProtocolScrollLocked, storedScrollTop, scrolledAtom, scrollContainerRef, currentThreadId, isLoadingThread]);

        // Restore scroll position from atom (only for thread switching, not during streaming)
        // Note: userScrolledAtom is managed by useAutoScroll.handleScroll, not here
        useLayoutEffect(() => {
            restoreScrollPosition();
            prevThreadIdRef.current = currentThreadId;
        }, [restoreScrollPosition, currentThreadId]);

        // Deterministic retry path for protocol navigation:
        // attempt again on render-state changes instead of relying on timers.
        useEffect(() => {
            if (!pendingRunId) return;
            tryScrollToPendingRun("retry-effect");
        }, [pendingRunId, isLoadingThread, runs, tryScrollToPendingRun]);

        // Watch for visibility transitions and container resizes
        useEffect(() => {
            const container = scrollContainerRef.current;
            if (!container) return;

            const observer = new ResizeObserver((entries) => {
                const entry = entries[0];
                if (!entry) return;
                
                const currentHeight = entry.contentRect.height;
                const isVisible = currentHeight > 0;
                const wasHidden = wasHiddenRef.current;
                const prevHeight = prevContainerHeightRef.current;
                
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
                        tryScrollToPendingRun("visibility-transition");
                    }, RESTORE_DEBOUNCE_MS);
                }
                // Re-evaluate scroll state when container height changes (window resize)
                // Only trigger if already visible (not on visibility transition)
                else if (!wasHidden && isVisible && prevHeight > 0 && currentHeight !== prevHeight) {
                    const { scrollHeight, scrollTop } = container;
                    const distanceFromBottom = scrollHeight - scrollTop - currentHeight;
                    const isNearBottom = distanceFromBottom <= BOTTOM_THRESHOLD;
                    store.set(scrolledAtom, !isNearBottom);
                }
                
                wasHiddenRef.current = !isVisible;
                prevContainerHeightRef.current = currentHeight;
            });
            
            observer.observe(container);
            return () => {
                observer.disconnect();
                if (restoreDebounceRef.current !== null) {
                    win.clearTimeout(restoreDebounceRef.current);
                }
            };
        }, [restoreScrollPosition, scrolledAtom, tryScrollToPendingRun, win]);

        // Scroll to bottom when runs change
        useEffect(() => {
            if (pendingRunId || isProtocolScrollLocked()) {
                return;
            }

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
        }, [pendingRunId, isProtocolScrollLocked, runs, scrolledAtom, win]);

        // Scroll to bottom when a new pending approval appears
        // This ensures the approval buttons are visible, even if user had scrolled up
        // Uses a delay to allow the AgentActionView to fully render/expand
        // With parallel tool calls, we track all pending approval IDs
        useEffect(() => {
            const currentApprovalIds = new Set(pendingApprovalsMap.keys());

            if (pendingRunId || isProtocolScrollLocked()) {
                prevPendingApprovalIdsRef.current = currentApprovalIds;
                return;
            }
            
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
        }, [pendingApprovalsMap, pendingRunId, isProtocolScrollLocked, scrolledAtom, win]);

        // Re-evaluate scroll state when content expands/collapses
        // This ensures the ScrollDownButton visibility is updated when user toggles:
        // - Tool call results (toolExpandedAtom)
        // - Sources sections (messageSourcesVisibilityAtom)
        // - Agent action panels (annotationPanelStateAtom)
        useEffect(() => {
            // Check if any expansion state changed
            const toolChanged = prevExpansionStateRef.current !== toolExpansionState;
            const sourcesChanged = prevSourcesVisibilityRef.current !== sourcesVisibilityState;
            const annotationChanged = prevAnnotationPanelRef.current !== annotationPanelState;
            
            // Skip if nothing changed (initial mount or no state change)
            if (!toolChanged && !sourcesChanged && !annotationChanged) return;
            
            // Update refs
            prevExpansionStateRef.current = toolExpansionState;
            prevSourcesVisibilityRef.current = sourcesVisibilityState;
            prevAnnotationPanelRef.current = annotationPanelState;
            
            // Wait briefly for DOM to update after expansion toggle
            const timeoutId = win.setTimeout(() => {
                const container = scrollContainerRef.current;
                if (!container || container.clientHeight === 0) return;
                
                const { scrollHeight, clientHeight, scrollTop } = container;
                const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
                const isNearBottom = distanceFromBottom <= BOTTOM_THRESHOLD;
                
                // Update scrolled state based on current position
                store.set(scrolledAtom, !isNearBottom);
            }, EXPANSION_SCROLL_EVAL_DELAY);
            
            return () => win.clearTimeout(timeoutId);
        }, [toolExpansionState, sourcesVisibilityState, annotationPanelState, scrolledAtom, win]);

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
                        ref={run.id === pendingRunId ? setPendingRunRef : undefined}
                        run={run}
                        isLastRun={index === runs.length - 1}
                    />
                ))}
            </div>
        );
    }
);

export default ThreadView;
