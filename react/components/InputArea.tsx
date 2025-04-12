// @ts-ignore no idea
import React, { useState, useRef } from 'react';
import { SourceButton } from "./SourceButton";
import { PlusSignIcon, StopIcon } from './icons';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { isStreamingAtom, threadSourceCountAtom, newThreadAtom } from '../atoms/threads';
import { currentSourcesAtom, currentUserMessageAtom } from '../atoms/input';
import { generateResponseAtom } from '../atoms/generateMessages';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';
import { getPref } from '../../src/utils/prefs';
import Button from './button';
import AddSourcesMenu from './AddSourcesMenu';
import { getAppState } from '../utils/appState';
import { MenuPosition } from './SearchMenu';

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
    const [isSourcesMenuOpen, setIsSourcesMenuOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });

    const handleSubmit = async (
        e: React.FormEvent<HTMLFormElement> | React.MouseEvent<HTMLButtonElement>,
        isLibrarySearch: boolean = false
    ) => {
        e.preventDefault();
        chatCompletion(userMessage, isCommandPressed || isLibrarySearch);
    };
    

    const chatCompletion = async (
        query: string,
        isLibrarySearch: boolean = false
    ) => {
        if (isStreaming || query.length === 0) return;

        // Get context from reader if it exists
        const appState = getAppState();

        // Generate response
        generateResponse({
            content: query,
            sources: currentSources,
            appState: appState,
            isLibrarySearch: isLibrarySearch
        });

        console.log('Chat completion:', query);
    };

    const handleStop = () => {
        console.log('Stopping chat completion');
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

        // Handle ⌘^1 (Mac) or Ctrl+Win+1 (Windows/Linux) etc. for quick prompt
        for (let i = 1 as 1 | 2 | 3 | 4 | 5 | 6; i <= 6; i++) {
            if (e.key === i.toString() &&  ((Zotero.isMac && e.metaKey && e.ctrlKey) || (!Zotero.isMac && e.ctrlKey && e.metaKey))) {
                e.preventDefault();
                handleQuickPrompt(i);
            }
        }
    };

    const handleQuickPrompt = (i: 1 | 2 | 3 | 4 | 5 | 6) => {
        const quickPrompt = getPref(`quickPrompt${i}_text`);
        const requiresAttachment = getPref(`quickPrompt${i}_requiresAttachment`);
        console.log('Quick prompt:', i, quickPrompt, requiresAttachment, currentSources.length);
        if (quickPrompt && (!requiresAttachment || currentSources.length > 0)) {
            console.log('Quick prompt test:', i);
            const librarySearch = getPref(`quickPrompt${i}_librarySearch`);
            chatCompletion(quickPrompt, librarySearch);
        }
    }

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
                <AddSourcesMenu
                    showText={currentSources.length == 0 && threadSourceCount == 0}
                    onClose={() => {
                        inputRef.current?.focus();
                        setIsSourcesMenuOpen(false);
                    }}
                    isMenuOpen={isSourcesMenuOpen}
                    onOpen={() => setIsSourcesMenuOpen(true)}
                    menuPosition={menuPosition}
                    setMenuPosition={setMenuPosition}
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
                        // onChange={(e) => setUserMessage(e.target.value)}
                        onChange={(e) => {
                            if (e.target.value.endsWith('@')) {
                                const rect = e.currentTarget.getBoundingClientRect();
                                setMenuPosition({ 
                                    x: rect.left,
                                    y: rect.top - 5
                                })
                                setIsSourcesMenuOpen(true);
                            } else {
                                setUserMessage(e.target.value);
                            }
                        }}
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
                        <Button
                            type={(isCommandPressed && !isStreaming && userMessage.length > 0) ? "button" : undefined}
                            variant={(isCommandPressed && !isStreaming) ? 'solid' : 'outline'}
                            // className={`mr-1 ${isCommandPressed ? '' : 'opacity-50'}`}
                            className="mr-1"
                            onClick={(e) => handleSubmit(e as any, true)}
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