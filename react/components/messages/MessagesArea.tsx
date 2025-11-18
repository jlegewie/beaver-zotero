import React, { useEffect, useRef, forwardRef, useMemo, useLayoutEffect, useCallback } from "react";
import { useAtomValue } from "jotai";
import UserMessageDisplay from "./UserMessageDisplay"
import { scrollToBottom } from "../../utils/scrollToBottom";
import { ChatMessage, MessageGroup } from "../../types/chat/uiTypes";
import AssistantMessagesGroup from "./AssistantMessagesGroup";
import { userScrolledAtom } from "../../atoms/ui";
import { currentThreadScrollPositionAtom } from "../../atoms/threads";
import { store } from "../../store";

const BOTTOM_THRESHOLD = 120; // pixels

type MessagesAreaProps = {
    messages: ChatMessage[];
};

export const MessagesArea = forwardRef<HTMLDivElement, MessagesAreaProps>(
    function MessagesArea(
        { messages }: MessagesAreaProps,
        ref: React.ForwardedRef<HTMLDivElement>
    ) {
        const lastScrollTopRef = useRef(0);
        const restoredFromAtomRef = useRef(false);
        const scrollContainerRef = useRef<HTMLDivElement | null>(null);
        const storedScrollTop = useAtomValue(currentThreadScrollPositionAtom);
        const scrollDebounceTimer = useRef<number | null>(null);
        const lastScrollDirectionRef = useRef<'up' | 'down' | null>(null);

        const setScrollContainerRef = useCallback((node: HTMLDivElement | null) => {
            scrollContainerRef.current = node;

            if (!ref) {
                return;
            }

            if (typeof ref === "function") {
                ref(node);
            } else {
                ref.current = node;
            }
        }, [ref]);

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
            lastScrollTopRef.current = container.scrollTop;
        }, [storedScrollTop]);

        // Cleanup debounce timer on unmount
        useEffect(() => {
            return () => {
                if (scrollDebounceTimer.current !== null) {
                    clearTimeout(scrollDebounceTimer.current);
                }
            };
        }, []);

        // Scroll to bottom when messages change
        useEffect(() => {
            if (restoredFromAtomRef.current) {
                restoredFromAtomRef.current = false;
                return;
            }

            if (scrollContainerRef.current && messages.length > 0) {
                scrollToBottom(scrollContainerRef as React.RefObject<HTMLElement>);
            }
        }, [messages]);

        // Group messages by role
        const messageGroups = useMemo(() => {
            const groups: MessageGroup[] = [];
            let currentGroup: MessageGroup | null = null;

            for (const message of messages) {
                if (!currentGroup || currentGroup.role !== message.role) {
                    currentGroup = { role: message.role, messages: [] };
                    groups.push(currentGroup);
                }
                currentGroup.messages.push(message);
            }
            
            return groups;
        }, [messages]);

        // Handle user scrolling with debouncing and direction detection
        const handleScroll = () => {
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
            if (scrollDirection === 'up' && Math.abs(scrollTop - lastScrollTopRef.current) > 10) {
                // Clear any existing debounce timer
                if (scrollDebounceTimer.current !== null) {
                    clearTimeout(scrollDebounceTimer.current);
                }
                
                // User deliberately scrolled up
                store.set(userScrolledAtom, true);
                lastScrollDirectionRef.current = 'up';
            } else if (distanceFromBottom > BOTTOM_THRESHOLD) {
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
                        if (currentDistanceFromBottom > BOTTOM_THRESHOLD) {
                            store.set(userScrolledAtom, true);
                        }
                    }
                }, 150); // 150ms debounce
            } else {
                // Near the bottom - user hasn't scrolled
                store.set(userScrolledAtom, false);
                lastScrollDirectionRef.current = 'down';
            }

            store.set(currentThreadScrollPositionAtom, scrollTop);
            lastScrollTopRef.current = scrollTop;
        };

        return (
            <div 
                id="beaver-messages"
                className="display-flex flex-col flex-1 min-h-0 overflow-y-auto gap-4 scrollbar min-w-0 pb-4"
                onScroll={handleScroll}
                ref={setScrollContainerRef}
            >
                {messageGroups.map((group, index) => (
                    <React.Fragment key={group.messages[0].id}>

                        {/* User message (always single message) */}
                        {group.role === 'user' && (
                            <UserMessageDisplay message={group.messages[0]} />
                        )}

                        {/* Assistant message group */}
                        {group.role === 'assistant' && (
                            <AssistantMessagesGroup
                                messages={group.messages}
                                isLastGroup={index === messageGroups.length - 1}
                                isFirstAssistantGroup={index === 0 || messageGroups[index - 1]?.role === 'user'}
                            />
                        )}
                    </React.Fragment>
                ))}
            </div>
        );
    }
);
