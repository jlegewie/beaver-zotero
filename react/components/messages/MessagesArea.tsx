import React, { useEffect, useRef, forwardRef, useMemo, useLayoutEffect, useCallback } from "react";
import { useAtomValue } from "jotai";
import UserMessageDisplay from "./UserMessageDisplay"
import { scrollToBottom } from "../../utils/scrollToBottom";
import { ChatMessage, MessageGroup } from "../../types/chat/uiTypes";
import AssistantMessagesGroup from "./AssistantMessagesGroup";
import { messagesScrollAtom, userScrolledAtom } from "../../atoms/ui";
import { store } from "../../store";

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
        const storedScrollTop = useAtomValue(messagesScrollAtom);
        const BOTTOM_THRESHOLD = 20; // pixels

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

            const delta = Math.abs(container.scrollTop - storedScrollTop);
            if (delta > 1) {
                restoredFromAtomRef.current = true;
                container.scrollTop = storedScrollTop;
            } else {
                restoredFromAtomRef.current = false;
            }

            const { scrollHeight, clientHeight } = container;
            const distanceFromBottom = scrollHeight - storedScrollTop - clientHeight;
            const isNearBottom = distanceFromBottom <= BOTTOM_THRESHOLD;
            store.set(userScrolledAtom, !isNearBottom);
            store.set(messagesScrollAtom, storedScrollTop);
            lastScrollTopRef.current = storedScrollTop;
        }, [storedScrollTop]);

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

        // Handle user scrolling
        const handleScroll = () => {
            if (!scrollContainerRef.current) {
                return;
            }

            const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
            const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
            
            // Check if not at the bottom
            if (distanceFromBottom > BOTTOM_THRESHOLD) {
                store.set(userScrolledAtom, true);
            } else {
                store.set(userScrolledAtom, false);
            }

            store.set(messagesScrollAtom, scrollTop);
            
            // Still track last scroll position for reference
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
