import React, { useEffect, useRef, forwardRef, useMemo, useLayoutEffect } from "react";
import { useAtomValue } from "jotai";
import UserMessageDisplay from "./UserMessageDisplay"
import { scrollToBottom } from "../../utils/scrollToBottom";
import { ChatMessage, MessageGroup } from "../../types/chat/uiTypes";
import AssistantMessagesGroup from "./AssistantMessagesGroup";
import { userScrolledAtom } from "../../atoms/ui";
import { currentThreadScrollPositionAtom } from "../../atoms/threads";
import { store } from "../../store";
import { useAutoScroll } from "../../hooks/useAutoScroll";

const BOTTOM_THRESHOLD = 120; // pixels

type MessagesAreaProps = {
    messages: ChatMessage[];
};

export const MessagesArea = forwardRef<HTMLDivElement, MessagesAreaProps>(
    function MessagesArea(
        { messages }: MessagesAreaProps,
        ref: React.ForwardedRef<HTMLDivElement>
    ) {
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
