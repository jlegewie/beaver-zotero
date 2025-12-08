import React, { useEffect, useRef, forwardRef, useLayoutEffect } from "react";
import { useAtomValue } from "jotai";
import { allRunsAtom } from "../../agents/atoms";
import { AgentRunView } from "./AgentRunView";
import { scrollToBottom } from "../../utils/scrollToBottom";
import { userScrolledAtom } from "../../atoms/ui";
import { currentThreadScrollPositionAtom } from "../../atoms/threads";
import { store } from "../../store";
import { useAutoScroll } from "../../hooks/useAutoScroll";

const BOTTOM_THRESHOLD = 120; // pixels

type ThreadViewProps = {
    /** Optional className for styling */
    className?: string;
};

/**
 * ThreadView renders all agent runs for the current thread.
 * Uses allRunsAtom which combines completed runs with any active streaming run.
 */
export const ThreadView = forwardRef<HTMLDivElement, ThreadViewProps>(
    function ThreadView({ className }: ThreadViewProps, ref: React.ForwardedRef<HTMLDivElement>) {
        const runs = useAtomValue(allRunsAtom);
        const restoredFromAtomRef = useRef(false);
        const storedScrollTop = useAtomValue(currentThreadScrollPositionAtom);
        
        // Use the auto-scroll hook
        const { scrollContainerRef, setScrollContainerRef, handleScroll } = useAutoScroll(ref, {
            threshold: BOTTOM_THRESHOLD
        });

        // Restore scroll position from atom
        useLayoutEffect(() => {
            const container = scrollContainerRef.current;
            if (!container) {
                restoredFromAtomRef.current = false;
                return;
            }

            const targetScrollTop = storedScrollTop ?? container.scrollHeight;
            const delta = Math.abs(container.scrollTop - targetScrollTop);
            if (delta > 1) {
                restoredFromAtomRef.current = true;
                container.scrollTop = targetScrollTop;
            } else {
                restoredFromAtomRef.current = false;
            }

            const { scrollHeight, clientHeight } = container;
            const distanceFromBottom = scrollHeight - container.scrollTop - clientHeight;
            const isNearBottom = distanceFromBottom <= BOTTOM_THRESHOLD;
            store.set(userScrolledAtom, !isNearBottom);
        }, [storedScrollTop]);

        // Scroll to bottom when runs change
        useEffect(() => {
            if (restoredFromAtomRef.current) {
                restoredFromAtomRef.current = false;
                return;
            }

            if (scrollContainerRef.current && runs.length > 0) {
                scrollToBottom(scrollContainerRef as React.RefObject<HTMLElement>);
            }
        }, [runs]);

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

