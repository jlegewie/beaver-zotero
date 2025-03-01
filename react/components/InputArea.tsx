// @ts-ignore no idea
import React, { useState } from 'react';
import { SourceButton } from "./SourceButton";
import { PlusSignIcon } from './icons';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { isStreamingAtom, currentUserMessageAtom } from '../atoms/messages';
import { currentSourcesAtom, addFileSourceAtom, threadSourceCountAtom } from '../atoms/resources';
import DragDropWrapper from './DragDropWrapper';
import { generateResponseAtom } from '../atoms/generateMessages';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import IconButton from './IconButton';

interface InputAreaProps {
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

const InputArea: React.FC<InputAreaProps> = ({
    inputRef
}) => {
    const [userMessage, setUserMessage] = useAtom(currentUserMessageAtom);
    const currentSources = useAtomValue(currentSourcesAtom);
    const [isCommandPressed, setIsCommandPressed] = useState(false);
    const isStreaming = useAtomValue(isStreamingAtom);
    const threadSourceCount = useAtomValue(threadSourceCountAtom);
    const addFileSource = useSetAtom(addFileSourceAtom);
    const generateResponse = useSetAtom(generateResponseAtom);

    const handleSubmit = async (
        e: React.FormEvent<HTMLFormElement> | React.MouseEvent<HTMLButtonElement>
    ) => {
        e.preventDefault();
        
        if (isStreaming) {
            return;
        }

        generateResponse({
            content: userMessage,
            sources: currentSources,
        });

        // If command is pressed, handle library search
        if (isCommandPressed) {
            handleLibrarySearch();
        } else {
            console.log('Chat completion:', userMessage);
        }
    };

    const handleLibrarySearch = () => {
        console.log('Chat completion with library search:', userMessage);
    };

    const handleAddSources = async () => {
        console.log('Adding context item');
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Meta') {
            setIsCommandPressed(true);
        }
    };

    const handleKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Meta') {
            setIsCommandPressed(false);
        }
    };

    const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
        // Check if the click target is a button or within a button
        const isButtonClick = (e.target as Element).closest('button') !== null;
        
        // Only focus if not clicking a button and editing is enabled
        if (!isButtonClick && inputRef.current) {
            inputRef.current.focus();
        }
    };

    return (
        <DragDropWrapper addFileSource={addFileSource}>
        <div
            className="user-message-display"
            onClick={handleContainerClick}
            style={{ minHeight: 'fit-content' }}
        >
            {/* Message sources */}
            <div className="flex flex-wrap gap-3 mb-2">
                <IconButton
                    icon={PlusSignIcon}
                    onClick={handleAddSources}
                    className="scale-11"
                    ariaLabel="Add sources"
                />
                {threadSourceCount > 0 && (
                    <button
                        className="sources-info"
                        disabled={true}
                        title={`This thread has ${threadSourceCount} sources.`}
                    >
                        <ZoteroIcon 
                            icon={ZOTERO_ICONS.ATTACHMENTS} 
                            size={14} 
                            color="--accent-green"
                            className="mr-1"
                        />
                        {threadSourceCount}
                    </button>
                )}
                {currentSources.map((source, index) => (
                    <SourceButton
                        key={index}
                        source={source}
                    />
                ))}
            </div>

            {/* Input Form */}
            <form onSubmit={handleSubmit} className="flex flex-col">
                {/* Message Input  */}
                <div className="mb-2 -ml-1">
                    <textarea
                        ref={inputRef}
                        value={userMessage}
                        onChange={(e) => setUserMessage(e.target.value)}
                        onInput={(e) => {
                            e.currentTarget.style.height = 'auto';
                            e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                        }}
                        placeholder="How can I help you today?"
                        className="chat-input"
                        onKeyDown={(e) => {
                            handleKeyDown(e);
                            // Submit on Enter (without Shift)
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSubmit(e as any);
                            }
                        }}
                        onKeyUp={handleKeyUp}
                        rows={1}
                    />
                </div>

                {/* Button Row */}
                <div className="flex flex-row items-center pt-2">
                    <div className="flex-1" />
                    <div className="flex gap-2">
                        <button
                            type={isCommandPressed ? "button" : undefined}
                            className={`beaver-button ${isCommandPressed ? '' : 'faded'} mr-1`}
                            onClick={handleLibrarySearch}
                            disabled={isStreaming}
                        >
                            Library Search ⌘ ⏎
                        </button>
                        <button
                            type={isCommandPressed ? undefined : "button"}
                            className={`beaver-button ${isCommandPressed ? 'faded' : ''}`}
                            onClick={handleSubmit}
                            disabled={isStreaming}
                        >
                            Send ⏎
                        </button>
                    </div>
                </div>
            </form>
        </div>
        </DragDropWrapper>
    );
};

export default InputArea;