import React, { useEffect, useRef, forwardRef } from "react";
import UserMessageDisplay from "./UserMessageDisplay"
import AssistantMessage from "./AssistantMessage"
import { scrollToBottom } from "../utils/scrollToBottom";
import { ChatMessage } from "../types/chat/uiTypes";
import AssistantMessageTools from "./AssistantMessageTools";
import { isChatRequestPendingAtom } from "../atoms/threads";
import { useAtomValue } from "jotai";

type MessagesAreaProps = {
    messages: ChatMessage[];
    userScrolled: boolean;
    setUserScrolled: (userScrolled: boolean) => void;
};

export const MessagesArea = forwardRef<HTMLDivElement, MessagesAreaProps>(
    function MessagesArea(
        { messages, userScrolled, setUserScrolled }: MessagesAreaProps,
        ref: React.ForwardedRef<HTMLDivElement>
    ) {
        const lastScrollTopRef = useRef(0);
        const isChatRequestPending = useAtomValue(isChatRequestPendingAtom);

        // Scroll to bottom when messages change
        useEffect(() => {
            if (ref && 'current' in ref && ref.current && messages.length > 0) {
                scrollToBottom(ref as React.RefObject<HTMLElement>, userScrolled);
            }
        }, [messages, userScrolled, ref]);

        // Handle user scrolling
        const SCROLL_THRESHOLD = 100; // pixels
        const BOTTOM_THRESHOLD = 20; // pixels
        const handleScroll = () => {
            if (ref && 'current' in ref && ref.current) {
                const { scrollTop, scrollHeight, clientHeight } = ref.current;
                const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
                            
                // Check if not at the bottom
                if (distanceFromBottom > BOTTOM_THRESHOLD) {
                    setUserScrolled(true);
                } else {
                    setUserScrolled(false);
                }
                
                // Still track last scroll position for reference
                lastScrollTopRef.current = scrollTop;
            }
        };

        return (
            <div 
                id="beaver-messages"
                className="display-flex flex-col flex-1 min-h-0 overflow-y-auto gap-4 scrollbar min-w-0 mb-2"
                onScroll={handleScroll}
                ref={ref}
            >
                {messages.map((message, index) => (
                    <React.Fragment key={message.id}>
                        {/* User message */}
                        {message.role === 'user' && (
                            <UserMessageDisplay message={message} />
                        )}
                        {/* Assistant message content */}
                        {message.role === 'assistant' && (
                            <AssistantMessage
                                message={message}
                                isLastMessage={index === messages.length - 1}
                                isFirstAssistantMessage={index > 0 && messages[index - 1]?.role === 'user'}
                                previousMessageHasToolCalls={
                                    index > 0 && (messages[index - 1]?.tool_calls || []).length > 0
                                }
                                // Show buttons if last message or next message is a user message
                                showActionButtons={
                                    index === messages.length - 1 ||
                                    messages[index + 1]?.role === 'user'
                                }
                            />
                        )}
                    </React.Fragment>
                ))}
            </div>
        );
    }
);
