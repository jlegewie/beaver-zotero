import React from 'react';
import { ContextItem } from "./contextItem";
import { getInTextCitations, getBibliographies } from "../../src/utils/citations";

interface ChatInputProps {
    message: string;
    setMessage: (msg: string) => void;
    inputRef: React.RefObject<HTMLInputElement>;
    isCommandPressed: boolean;
    contextItems: any[];
    handleSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
    handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    handleKeyUp: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    handleLibrarySearch: () => void;
}

const ChatInput: React.FC<ChatInputProps> = ({
    message,
    setMessage,
    inputRef,
    isCommandPressed,
    contextItems,
    handleSubmit,
    handleKeyDown,
    handleKeyUp,
    handleLibrarySearch,
}) => {
    return (
        <div className="chat-box">
            <form onSubmit={handleSubmit} className="flex flex-col">
                {/* Chat Input */}
                <div className="mb-2 -ml-1">
                    <input
                        ref={inputRef}
                        type="text"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder="How can I help you today?"
                        className="chat-input"
                        onKeyDown={handleKeyDown}
                        onKeyUp={handleKeyUp}
                    />
                </div>

                {/* Context Items */}
                <div className="context-items-container">
                    {contextItems.map((item, index) => (
                        <ContextItem
                            key={index}
                            icon={item.getItemTypeIconName()}
                            tooltip={getBibliographies([item])[0]}
                            onRemove={() => alert('test')}
                        >
                            {getInTextCitations([item])[0]}
                        </ContextItem>
                    ))}
                </div>

                {/* Button Row */}
                <div className="flex flex-row items-center pt-2">
                    <div className="flex-1" />
                    <div className="flex gap-2">
                        <button
                            type={isCommandPressed ? "button" : undefined}
                            className={`beaver-button ${isCommandPressed ? '' : 'faded'} mr-1`}
                            onClick={handleLibrarySearch}
                        >
                            Library Search ⌘ ⏎
                        </button>
                        <button
                            type={isCommandPressed ? undefined : "button"}
                            className={`beaver-button ${isCommandPressed ? 'faded' : ''}`}
                            onClick={() => alert('test')}
                        >
                            Send ⏎
                        </button>
                    </div>
                </div>
            </form>
        </div>
    );
};

export default ChatInput;