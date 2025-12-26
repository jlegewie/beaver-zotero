import React, { useEffect, useRef, forwardRef, useLayoutEffect, useCallback } from "react";
import { useAtomValue } from "jotai";
import { allRunsAtom } from "../../agents/atoms";
import { AgentRunView } from "./AgentRunView";
import { scrollToBottom } from "../../utils/scrollToBottom";
import { userScrolledAtom, windowUserScrolledAtom } from "../../atoms/ui";
import { currentThreadScrollPositionAtom, windowScrollPositionAtom } from "../../atoms/threads";
import { store } from "../../store";
import { useAutoScroll } from "../../hooks/useAutoScroll";

const BOTTOM_THRESHOLD = 120; // pixels

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
        const runs = useAtomValue(allRunsAtom);
        const restoredFromAtomRef = useRef(false);
        
        // Select the correct atoms based on whether we're in the separate window
        const scrollPositionAtom = isWindow ? windowScrollPositionAtom : currentThreadScrollPositionAtom;
        const scrolledAtom = isWindow ? windowUserScrolledAtom : userScrolledAtom;
        const storedScrollTop = useAtomValue(scrollPositionAtom);
        
        // Use the auto-scroll hook with window-aware state
        const { scrollContainerRef, setScrollContainerRef, handleScroll } = useAutoScroll(ref, {
            threshold: BOTTOM_THRESHOLD,
            isWindow
        });

        // Helper function to restore scroll position
        const restoreScrollPosition = useCallback(() => {
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

            const targetScrollTop = storedScrollTop ?? container.scrollHeight;
            const delta = Math.abs(container.scrollTop - targetScrollTop);
            
            // Only restore if there's a significant difference (e.g., thread switch)
            // Small deltas are just normal scroll position updates during streaming
            if (delta > 50) {
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
                // This prevents stale userScrolled=true from a previous thread from blocking auto-scroll.
                // We only set to false (never true) to avoid the original regression where
                // content growth during streaming would incorrectly disable auto-scroll.
                const { scrollHeight, clientHeight } = container;
                const distanceFromBottom = scrollHeight - container.scrollTop - clientHeight;
                if (distanceFromBottom <= BOTTOM_THRESHOLD) {
                    store.set(scrolledAtom, false);
                }
            }
        }, [storedScrollTop, scrolledAtom]);

        // Restore scroll position from atom (only for thread switching, not during streaming)
        // Note: userScrolledAtom is managed by useAutoScroll.handleScroll, not here
        useLayoutEffect(() => {
            restoreScrollPosition();
        }, [restoreScrollPosition]);

        // Watch for visibility/size changes to restore scroll position when becoming visible
        useEffect(() => {
            const container = scrollContainerRef.current;
            if (!container) return;

            const observer = new ResizeObserver(() => {
                // If we became visible, try restoring
                if (container.clientHeight > 0) {
                    restoreScrollPosition();
                }
            });
            
            observer.observe(container);
            return () => observer.disconnect();
        }, [restoreScrollPosition]);

        // Scroll to bottom when runs change
        useEffect(() => {
            if (restoredFromAtomRef.current) {
                restoredFromAtomRef.current = false;
                return;
            }

            if (scrollContainerRef.current && runs.length > 0) {
                // Pass the correct scroll atom for this context
                scrollToBottom(scrollContainerRef as React.RefObject<HTMLElement>, undefined, scrolledAtom);
            }
        }, [runs, scrolledAtom]);

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

