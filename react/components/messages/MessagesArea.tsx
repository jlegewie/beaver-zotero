import React, { useEffect, useRef, forwardRef, useMemo } from "react";
import UserMessageDisplay from "./UserMessageDisplay"
import { scrollToBottom } from "../../utils/scrollToBottom";
import { ChatMessage, MessageGroup } from "../../types/chat/uiTypes";
import AssistantMessagesGroup from "./AssistantMessagesGroup";
import { userScrolledAtom } from "../../atoms/ui";
import { store } from "../../store";
import { useScrollPosition } from "../../hooks/useScrollPosition";
import { useAtomValue } from "jotai";
import { currentThreadIdAtom } from "../../atoms/threads";

type MessagesAreaProps = {
    messages: ChatMessage[];
    location: 'library' | 'reader';
};

export const MessagesArea = forwardRef<HTMLDivElement, MessagesAreaProps>(
    function MessagesArea(
        { messages, location }: MessagesAreaProps,
        ref: React.ForwardedRef<HTMLDivElement>
    ) {
        const lastScrollTopRef = useRef(0);
        const threadId = useAtomValue(currentThreadIdAtom);
        const previousThreadIdRef = useRef(threadId);
        const previousMessageCountRef = useRef(messages.length);
        
        // Initialize scroll position persistence
        useScrollPosition(ref as React.RefObject<HTMLElement>, location);

        // Smart scroll to bottom: only when new messages arrive AND user hasn't scrolled up
        // useEffect(() => {
        //     if (!ref || !('current' in ref) || !ref.current || messages.length === 0) {
        //         return;
        //     }

        //     const isNewThread = threadId !== previousThreadIdRef.current;
        //     const hasNewMessages = messages.length > previousMessageCountRef.current;
        //     const userHasScrolledUp = store.get(userScrolledAtom);

        //     // Scroll to bottom if:
        //     // 1. It's a new thread (always scroll to bottom on thread change)
        //     // 2. New messages arrived AND user hasn't scrolled up
        //     if (isNewThread || (hasNewMessages && !userHasScrolledUp)) {
        //         scrollToBottom(ref as React.RefObject<HTMLElement>);
        //     }

        //     // Update refs
        //     previousThreadIdRef.current = threadId;
        //     previousMessageCountRef.current = messages.length;
        // }, [messages, threadId, ref]);

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
        const SCROLL_THRESHOLD = 100; // pixels
        const BOTTOM_THRESHOLD = 20; // pixels
        const handleScroll = () => {
            if (ref && 'current' in ref && ref.current) {
                const { scrollTop, scrollHeight, clientHeight } = ref.current;
                const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
                            
                // Check if not at the bottom
                if (distanceFromBottom > BOTTOM_THRESHOLD) {
                    store.set(userScrolledAtom, true);
                } else {
                    store.set(userScrolledAtom, false);
                }
                
                // Still track last scroll position for reference
                lastScrollTopRef.current = scrollTop;
            }
        };

        return (
            <div 
                id="beaver-messages"
                className="display-flex flex-col flex-1 min-h-0 overflow-y-auto gap-4 scrollbar min-w-0 pb-4"
                onScroll={handleScroll}
                ref={ref}
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
