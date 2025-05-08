// @ts-ignore no idea
import React, { useEffect, useRef, forwardRef } from "react";
import UserMessageDisplay from "./UserMessageDisplay"
import AssistantMessageContent from "./AssistantMessageContent"
import { scrollToBottom } from "../utils/scrollToBottom";
import { ChatMessage } from "../types/chat/uiTypes";
import AssistantMessageTools from "./AssistantMessageTools";
import { isChatRequestPendingAtom } from "../atoms/threads";
import { useAtomValue } from "jotai";
import GeneratingButton from "./GeneratingButton";

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
                    <>
                        {/* User message */}
                        {message.role === 'user' && (
                            <UserMessageDisplay
                                key={message.id}
                                message={message}
                            />
                        )}
                        {/* Assistant message content */}
                        {message.role === 'assistant' && (message.content !== '' || message.status == "error" || message.warnings) && (
                            <AssistantMessageContent
                                key={`content-${message.id}`}
                                message={message}
                                isLastMessage={index === messages.length - 1}
                            />
                        )}
                        {/* Assistant message tools */}
                        {message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0 && (
                            <AssistantMessageTools
                                key={`tools-${message.id}`}
                                message={message}
                            />
                        )}
                    </>
                ))}
                {/* Generating button */}
                {
                    messages.length > 0 &&
                    (
                        (messages[messages.length - 1].role === 'user' && isChatRequestPending) ||
                        (messages[messages.length - 1].role === 'assistant' && messages[messages.length - 1].status === 'in_progress' && messages[messages.length - 1].content === '' && !messages[messages.length - 1].tool_calls)
                    )
                    && (
                        <GeneratingButton />
                    )
                }
            </div>
        );
    }
);
