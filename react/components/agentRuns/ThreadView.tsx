import React, { useEffect, useRef, forwardRef, useLayoutEffect, useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { activeRunAtom, allRunsAtom, threadRunIdsAtom } from "@beaver/agent-core/run-state/atoms";
import { AgentRunView } from "./AgentRunView";
import { pinToBottom, scrollToBottom } from "../../utils/scrollToBottom";
import { AT_BOTTOM_EPSILON, BOTTOM_THRESHOLD, getScrollAtoms, latchIntentFromDistance, markProgrammaticScroll, measureDistanceFromBottom, publishDistanceFromBottom, publishScrollPosition, resumeFollowing } from "../../utils/scrollPosition";
import { currentThreadIdAtom, pendingScrollToRunAtom, isLoadingThreadAtom } from "../../atoms/threads";
import { pendingApprovalsAtom } from "../../agents/agentActions";
import { store } from "../../store";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import { toolExpandedAtom, messageSourcesVisibilityAtom, annotationPanelStateAtom } from "../../atoms/messageUIState";
import { logger } from "@beaver/agent-core/platform/logger";

const RESTORE_THRESHOLD = 100; // pixels - threshold for restoring scroll position
const RESTORE_DEBOUNCE_MS = 50; // ms - debounce delay for scroll restoration
const ANIMATION_LOCKOUT_MS = 400; // ms - time to wait after animation before allowing restore
const PENDING_APPROVAL_SCROLL_DELAY = 100; // ms - delay before scrolling for pending approval (allows content to render)
const EXPANSION_SCROLL_EVAL_DELAY = 50; // ms - delay before re-evaluating scroll state after expansion toggle
const PROTOCOL_SCROLL_LOCKOUT_MS = 800; // ms - block other scroll restorations right after protocol target jump
/**
 * How long after a response stops arriving its layout is still followed.
 *
 * A run's last act is to change its own status, and the parts of a run that
 * only appear once it is over — the footer, the receipt, the review of what it
 * did to the library, an error card — are laid out after that. Their resize
 * arrives when nothing is generating any more, so without this a reader who
 * followed a response to its end would be left above the very summary of it.
 * Long enough for that layout, short enough that it has expired by the time a
 * reader has read the card and reached for it.
 */
const TERMINAL_SETTLE_MS = 1000;

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
        // The rendered runs' ids, holding their array while the set of runs is
        // unchanged. Used below to re-observe the run elements only when they
        // are actually replaced, rather than on every frame of a response.
        const runIds = useAtomValue(threadRunIdsAtom);
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
        // How long the layout that follows a finished response is still followed
        const terminalSettleUntilRef = useRef(0);
        
        // Select the correct atoms based on whether we're in the separate window
        const scrollAtoms = getScrollAtoms(isWindow);
        const scrollPositionAtom = scrollAtoms.position;
        const scrolledAtom = scrollAtoms.userScrolled;
        // Read scroll position imperatively inside restoreScrollPosition rather than subscribing.
        // The atom is updated every ~10px of scroll, so subscribing would cause ThreadView to
        // re-render constantly while the user scrolls, cascading through all message components.
        
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

            // Determine scroll state based on whether the target is near the bottom.
            // scrollIntoView is async (smooth), so project the final scroll position:
            // use getBoundingClientRect relative to the container to get the element's
            // position within the scrollable area (offsetTop is relative to offsetParent,
            // which may not be the scroll container).
            const { scrollHeight, scrollTop, clientHeight } = container;
            const elementTopInContainer = element.getBoundingClientRect().top - container.getBoundingClientRect().top + scrollTop;
            const projectedDistanceFromBottom = scrollHeight - elementTopInContainer - clientHeight;

            // The browser steps this scroll, so its intermediate offsets are
            // never written here. Claiming the whole lockout as ours keeps the
            // scroll handler from reading the upward journey as the reader
            // scrolling back out of the run they just navigated to. The offset
            // recorded is where the jump is aiming, which is also where it lands
            // unless the target sits too near the end to be brought to the top —
            // then the browser stops short and the record describes a position
            // the container never took. That fails safe: nothing matches it, so
            // once the lockout expires the drag detection simply works as usual.
            markProgrammaticScroll(container, PROTOCOL_SCROLL_LOCKOUT_MS, elementTopInContainer);
            element.scrollIntoView({ behavior: "smooth", block: "start" });
            latchIntentFromDistance(projectedDistanceFromBottom, scrollAtoms);
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

            // No remembered offset means the bottom — the reader was following
            // the response when this thread was last shown, or has never opened
            // it. Taken from the container now rather than remembered as an
            // offset, because the bottom has moved if the response kept
            // arriving while the pane was closed.
            const targetScrollTop = store.get(scrollPositionAtom) ?? container.scrollHeight;
            const delta = Math.abs(container.scrollTop - targetScrollTop);
            
            // Check if this is a thread switch
            const isThreadSwitch = currentThreadId !== prevThreadIdRef.current;

            // Only restore if there's a significant difference (e.g., thread switch)
            // Use a larger threshold to avoid oscillation near boundaries
            if (delta > RESTORE_THRESHOLD) {
                restoredFromAtomRef.current = true;
                container.scrollTop = targetScrollTop;
                // A restore usually moves the container a long way back, which
                // is the shape of a reader scrolling away. The intent is decided
                // here instead, from the position it lands at.
                markProgrammaticScroll(container);

                // Set scroll state based on position after restore, but only
                // when a thread was actually opened. This runs from a layout
                // trigger too — the reader collapsing and re-opening the pane —
                // and there the restore describes where they had got to, not a
                // decision to leave the response. Latching from it would stop a
                // stream mid-flight for someone who only resized a pane.
                const distanceFromBottom = publishScrollPosition(container, scrollAtoms);
                if (distanceFromBottom !== null && isThreadSwitch) {
                    latchIntentFromDistance(distanceFromBottom, scrollAtoms);
                }
            } else {
                restoredFromAtomRef.current = false;

                // For small deltas (thread switch with similar position or streaming updates),
                // re-derive the intent from where the restored thread actually sits.
                // IMPORTANT: Only do this on thread switch!
                // Mid-scroll this belongs to useAutoScroll, which latches the
                // intent from the reader's own gestures; overwriting it from
                // here would undo that.
                //
                // Both directions, not just the clear: a thread reopened part-way
                // up is one the reader left part-way up, and leaving a stale
                // "at the bottom" behind would have auto-scroll yank them to the
                // end of it on the next streamed frame.
                if (isThreadSwitch) {
                    const distanceFromBottom = publishScrollPosition(container, scrollAtoms);
                    if (distanceFromBottom !== null) {
                        latchIntentFromDistance(distanceFromBottom, scrollAtoms);
                    }
                }
            }
        }, [pendingRunId, isProtocolScrollLocked, scrollAtoms, scrollPositionAtom, scrolledAtom, scrollContainerRef, currentThreadId]);

        // Restore scroll position from atom (only for thread switching, not during streaming)
        // Note: userScrolledAtom is managed by useAutoScroll — its gesture
        // listeners and scroll handler — not here
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
                    const containerShrunk = currentHeight < prevHeight;
                    const wasAtBottom = !store.get(scrolledAtom);

                    // If the container shrunk and the user was at the bottom,
                    // pin to the new bottom
                    if (containerShrunk && wasAtBottom && !isProtocolScrollLocked()) {
                        container.scrollTop = Math.max(container.scrollHeight - currentHeight, 0);
                        markProgrammaticScroll(container);
                    } else {
                        // Resuming only, and only at the true bottom. A resize
                        // says nothing about what the reader wants — latching
                        // intent from one would take a reader who scrolled back
                        // a little and then resized the pane, and hand them to
                        // auto-scroll on the next frame. Where the container now
                        // sits is published below, which is what the scroll-down
                        // button reads.
                        const { scrollHeight, scrollTop } = container;
                        const distanceFromBottom = scrollHeight - scrollTop - currentHeight;
                        if (distanceFromBottom <= AT_BOTTOM_EPSILON) {
                            resumeFollowing(scrollAtoms);
                        }
                    }
                }

                // Whatever the branches above decided about intent, the resize
                // moved the bottom — publish where the container now sits.
                publishScrollPosition(container, scrollAtoms);

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
        }, [restoreScrollPosition, scrollAtoms, scrolledAtom, tryScrollToPendingRun, isProtocolScrollLocked, win]);

        // Follow the bottom, and keep the measured position honest, from the one
        // signal that says the content changed size.
        //
        // The observer above watches the scroll container, whose box does not
        // change as messages stream into it — only its scrollable content does.
        // Nothing else reports that: growing the content moves the bottom away
        // without moving `scrollTop`, so no scroll event fires, and a reader
        // sitting above the fold would otherwise keep an "at the bottom" reading
        // taken before the response began. Observing the run elements catches it
        // at the source, and catches it whatever caused it — a token arriving, an
        // image finishing, a code block re-wrapping, a card animating open, the
        // working indicator appearing part-way through a response. None of those
        // has to be described by an atom first, and a frame in which the text
        // changed but the height did not does no work here at all.
        //
        // Shrinking is the same signal, and it is why this has to be a resize and
        // not a scroll: content shrinking under a reader who is at the end moves
        // the bottom towards them without moving `scrollTop`, so no scroll event
        // ever fires. It arrives here as a resize record like any other, and the
        // resume rule below sees the container is now at its bottom.
        //
        // Resize records are delivered at most once per frame, after layout and
        // before paint. Reading `scrollHeight`/`scrollTop` here is therefore free
        // — layout is already settled, so nothing has to be recomputed to answer
        // — and a scroll issued from here still lands in the frame that grew the
        // content, with no intermediate state ever painted.
        useEffect(() => {
            const container = scrollContainerRef.current;
            if (!container) return;

            const observer = new ResizeObserver(() => {
                // A pane that is mounted but not laid out yet, or one the reader
                // collapsed, reports every offset as zero — which reads as "at
                // the bottom" and would both publish that and clear the reader's
                // scroll-back intent below, from a container nobody is looking
                // at. `measureDistanceFromBottom` returns null for those.
                const distanceFromBottom = measureDistanceFromBottom(container);
                if (distanceFromBottom === null) return;

                // Where the container sits is settled by this resize whatever the
                // gates below decide about intent, so it is published first, and
                // from the read already made.
                publishDistanceFromBottom(distanceFromBottom, scrollAtoms);

                // Protocol navigation owns the container until its jump has
                // landed; the run it is heading for is usually not the last one,
                // and following would take the reader straight back off it.
                if (pendingRunId || isProtocolScrollLocked()) {
                    return;
                }

                // A restore has just put the container back where the reader left
                // this thread, and re-rendering the thread is itself a resize.
                // Consume one record so that placement stands; the growth after
                // it is the response, and is followed normally.
                if (restoredFromAtomRef.current) {
                    restoredFromAtomRef.current = false;
                    return;
                }

                // Nothing to follow in a thread with no runs in it, and nothing
                // the reader can have scrolled back from.
                if (runIds.length === 0) {
                    return;
                }

                // The same rule useAutoScroll resumes on, against the same
                // constant: only the true bottom resumes following. Against the
                // button's threshold instead, a reader who scrolled back a little
                // and is still inside that band would have their intent cleared
                // here on the next streamed frame, and be pulled to the end.
                if (distanceFromBottom <= AT_BOTTOM_EPSILON) {
                    resumeFollowing(scrollAtoms);
                }

                // Only a response in flight is followed. A resize says the
                // content changed size, not who changed it, and when nothing is
                // generating the only thing that changes it is the reader —
                // opening a tool result, expanding the list of library changes.
                // Following that would carry them to the end of the thread and
                // take with it the very thing they just opened, which is exactly
                // as far above the fold as it is tall. Left alone, the view stays
                // where they put it and the scroll-down button appears, because
                // there is now more below them.
                //
                // Generating, or settling immediately after it. Not merely
                // live: a run paused on a deferred approval is still live, and
                // is exactly when the reader is reading the cards it put in
                // front of them — the review of a run's library changes renders
                // on this same status, so keying both on it is what keeps a card
                // from being shown and scrolled away in the same breath.
                //
                // The settle window is for the other end. A run's terminal
                // layout is laid out after its status has already changed, so
                // gating on the status alone would stop following a response
                // exactly as the last of it arrived.
                //
                // Read rather than subscribed: this needs the value as of the
                // resize, and subscribing would re-register the observer at the
                // start and end of every run.
                if (store.get(activeRunAtom)?.status === 'in_progress') {
                    terminalSettleUntilRef.current = Date.now() + TERMINAL_SETTLE_MS;
                } else if (Date.now() >= terminalSettleUntilRef.current) {
                    return;
                }

                // Follow the bottom by assignment, not by animation. Content
                // arrives many times a second and every arrival moves the bottom,
                // so easing towards one that has moved again before the easing
                // finishes is what makes a streaming thread wobble; a fresh
                // assignment per record simply holds the reader at the end of the
                // text as it arrives.
                //
                // Nothing to arm `isAnimatingRef` for, either: the write lands
                // before this returns, so restoreScrollPosition has no in-flight
                // motion to stay out of the way of.
                //
                // This cannot re-enter the observer. `scrollTop` is a scroll
                // offset, not a layout property: assigning it resizes nothing, so
                // it produces no resize record. (Content growing past the
                // viewport can bring a scrollbar in and narrow the children,
                // which is a real second record — but it is caused by the growth,
                // not by the scroll, and it settles immediately, because taking
                // the same offset again changes no width.)
                pinToBottom(scrollContainerRef as React.RefObject<HTMLElement>, scrolledAtom);

                // Deliberately not measuring again after the scroll. The jump
                // above writes scrollTop, and a read after it is a read-after-
                // write. The position was already published from the read before
                // the write, and the scroll event the jump produces reports the
                // offset it came to rest at, for free.
            });

            for (const child of Array.from(container.children)) {
                observer.observe(child);
            }

            return () => observer.disconnect();
            // Keyed on which runs are rendered, not on the array holding them:
            // that array is replaced on every frame of a streaming response and
            // would tear this observer down and rebuild it just as often, while
            // the ids behind it stay put — `threadRunIdsAtom` holds its array
            // for exactly as long as they do. The count alone is not enough: a
            // retry drops a run and installs its replacement in one batch, so
            // the children are swapped without the count ever moving, and an
            // observer keyed on the count would sit watching detached elements.
            //
            // Re-registering is also how a run being added or removed is noticed
            // at all: observing an element delivers an initial record for it, so
            // the swap reports the new content size the same way growth does.
            //
            // `pendingRunId` is in here so the gate above reads the current one.
            // It changes only on protocol navigation, and a re-registration
            // during one is gated by that same navigation.
        }, [runIds, scrollAtoms, scrolledAtom, scrollContainerRef, pendingRunId, isProtocolScrollLocked]);

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
                        resumeFollowing(scrollAtoms);
                        
                        // Animated, unlike the per-frame following above: this
                        // happens once, when an approval appears, and can carry
                        // a reader who was reading further up the thread a long
                        // way down. The motion is what tells them they were
                        // moved, and where from.
                        const isAnimating = scrollToBottom(
                            scrollContainerRef as React.RefObject<HTMLElement>,
                        );

                        // Set the animation flag only when there is an animation
                        // for restoreScrollPosition to stay out of the way of.
                        if (isAnimating) {
                            isAnimatingRef.current = true;
                            // Clear animation flag after animation completes
                            win.setTimeout(() => {
                                isAnimatingRef.current = false;
                            }, ANIMATION_LOCKOUT_MS);
                        }

                        publishScrollPosition(scrollContainerRef.current, scrollAtoms);
                    }
                }, PENDING_APPROVAL_SCROLL_DELAY);

                prevPendingApprovalIdsRef.current = currentApprovalIds;

                return () => win.clearTimeout(timeoutId);
            }

            prevPendingApprovalIdsRef.current = currentApprovalIds;
        }, [pendingApprovalsMap, pendingRunId, isProtocolScrollLocked, scrollAtoms, scrollContainerRef, scrolledAtom, win]);

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
                const distanceFromBottom = publishScrollPosition(container, scrollAtoms);
                if (distanceFromBottom === null) return;

                // Publishing the position is the point here — that is what moves
                // the scroll-down button. Intent is only ever resumed, and only
                // at the true bottom: collapsing a card above a reader who had
                // scrolled back leaves them nearer the end without their having
                // asked to go back to it.
                if (distanceFromBottom <= AT_BOTTOM_EPSILON) {
                    resumeFollowing(scrollAtoms);
                }
            }, EXPANSION_SCROLL_EVAL_DELAY);

            return () => win.clearTimeout(timeoutId);
        }, [toolExpansionState, sourcesVisibilityState, annotationPanelState, scrollAtoms, scrollContainerRef, scrolledAtom, win]);

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
                role="log"
                aria-label="Chat history"
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
