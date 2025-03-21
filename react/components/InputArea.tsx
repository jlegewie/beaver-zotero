// @ts-ignore no idea
import React, { useState } from 'react';
import { SourceButton } from "./SourceButton";
import { PlusSignIcon, StopIcon } from './icons';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { isStreamingAtom, threadSourceCountAtom, newThreadAtom } from '../atoms/threads';
import { currentSourcesAtom, currentUserMessageAtom } from '../atoms/input';
import { generateResponseAtom } from '../atoms/generateMessages';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import Button from './button';
import AddSourcesMenu from './AddSourcesMenu';
import { getAppState } from '../utils/appState';

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
    const generateResponse = useSetAtom(generateResponseAtom);
    const newThread = useSetAtom(newThreadAtom);

    const handleSubmit = async (
        e: React.FormEvent<HTMLFormElement> | React.MouseEvent<HTMLButtonElement>
    ) => {
        e.preventDefault();
        
        if (isStreaming || userMessage.length === 0) return;

        // Get context from reader if it exists
        const appState = getAppState();

        // Generate response
        generateResponse({
            content: userMessage,
            sources: currentSources,
            appState,
        });

        console.log('Chat completion:', userMessage);
    };

    const handleStop = () => {
        console.log('Stopping chat completion');
    };

    const handleLibrarySearch = () => {
        console.log('Chat completion with library search:', userMessage);
    };

    const handleAddSources = async () => {
        console.log('Adding context item');
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if ((Zotero.isMac && e.key === 'Meta') || (!Zotero.isMac && e.key === 'Control')) {
            setIsCommandPressed(true);
        }
        
        // Handle ⌘N (Mac) or Ctrl+N (Windows/Linux) for new thread
        if ((e.key === 'n' || e.key === 'N') && ((Zotero.isMac && e.metaKey) || (!Zotero.isMac && e.ctrlKey))) {
            e.preventDefault();
            newThread();
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
        // <DragDropWrapper addFileSource={addFileSource}>
        <div
            className="user-message-display shadow-md"
            onClick={handleContainerClick}
            style={{ minHeight: 'fit-content' }}
        >
            {/* Message sources */}
            <div className="flex flex-wrap gap-3 mb-2">
                <AddSourcesMenu showText={currentSources.length == 0 && threadSourceCount == 0}/>
                {/* <IconButton
                    icon={PlusSignIcon}
                    onClick={handleAddSources}
                    className="scale-11"
                    ariaLabel="Add sources"
                /> */}
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
                                if (isCommandPressed && !isStreaming && userMessage.length > 0) {
                                    handleLibrarySearch();
                                } else if (!isStreaming && userMessage.length > 0) {
                                    handleSubmit(e as any);
                                }
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
                        <Button
                            type={(isCommandPressed && !isStreaming && userMessage.length > 0) ? "button" : undefined}
                            variant={(isCommandPressed && !isStreaming) ? 'solid' : 'outline'}
                            // className={`mr-1 ${isCommandPressed ? '' : 'opacity-50'}`}
                            className="mr-1"
                            onClick={handleLibrarySearch}
                            disabled={isStreaming || userMessage.length === 0}
                        >
                            Library Search
                            <span className="opacity-50">
                                {Zotero.isMac ? '⌘' : '⌃'}⏎
                            </span>
                        </Button>
                        <Button
                            rightIcon={isStreaming ? StopIcon : undefined}
                            type={!isCommandPressed && !isStreaming && userMessage.length > 0 ? "button" : undefined}
                            variant={!isCommandPressed || isStreaming ? 'solid' : 'outline'  }
                            className="mr-1"
                            onClick={isStreaming ? handleStop : handleSubmit}
                            disabled={userMessage.length === 0 && !isStreaming}
                        >
                            {isStreaming
                                ? 'Stop'
                                : (<span>Send <span className="opacity-50">⏎</span></span>)
                            }
                        </Button>
                    </div>
                </div>
            </form>
        </div>
        // </DragDropWrapper>
    );
};

export default InputArea;