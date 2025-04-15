// @ts-ignore no idea
import React, { useEffect, useRef, forwardRef } from "react";
import UserMessageDisplay from "./UserMessageDisplay"
import AssistantMessageDisplay from "./AssistantMessageDisplay"
import { scrollToBottom } from "../utils/scrollToBottom";
import { ChatMessage } from "../types/messages";
import ToolMessageDisplay from "./ToolMessageDisplay";

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
                className="display-flex flex-col flex-1 min-h-0 overflow-y-auto gap-4 scrollbar min-w-0"
                onScroll={handleScroll}
                ref={ref}
            >
                {messages.map((message, index) => (
                    <div key={index} className={`${message.role === 'user' ? 'px-3' : 'px-4'}`}>
                        {/* User message */}
                        {message.role === 'user' && (
                            <UserMessageDisplay
                                message={message}
                            />
                        )}
                        {/* Assistant message without tool calls */}
                        {message.role === 'assistant' && (!message.tool_calls || message.tool_calls.length === 0) && (
                            <AssistantMessageDisplay
                                message={message}
                                isLastMessage={index === messages.length - 1}
                                toolCallInProgress={
                                    messages
                                        .filter(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0)
                                        .some(m => m.status == "in_progress")
                                }
                            />
                        )}
                        {/* Assistant message with tool calls */}
                        {message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0 && (
                            <ToolMessageDisplay message={message} />
                        )}
                    </div>
                ))}
            </div>
        );
    }
);
