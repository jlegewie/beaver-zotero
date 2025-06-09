import React, { useState, useRef, useEffect } from 'react';
import { StopIcon } from '../icons/icons';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { isStreamingAtom, newThreadAtom, isCancellableAtom, cancellerHolder, cancelStreamingMessageAtom, isCancellingAtom } from '../../atoms/threads';
import { currentSourcesAtom, currentMessageContentAtom } from '../../atoms/input';
import { readerTextSelectionAtom } from '../../atoms/input';
import { generateResponseAtom } from '../../atoms/generateMessages';
import { getPref } from '../../../src/utils/prefs';
import Button from '../ui/Button';
import { MenuPosition } from '../ui/menus/SearchMenu';
import ModelSelectionButton from '../ui/buttons/ModelSelectionButton';
import MessageAttachmentDisplay from '../messages/MessageAttachmentDisplay';
import { isAgentModelAtom } from '../../atoms/models';
import { getCustomPromptsFromPreferences } from '../../types/settings';
import { logger } from '../../../src/utils/logger';

interface InputAreaProps {
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

const InputArea: React.FC<InputAreaProps> = ({
    inputRef
}) => {
    const isAgentModel = useAtomValue(isAgentModelAtom);
    const [messageContent, setMessageContent] = useAtom(currentMessageContentAtom);
    const currentSources = useAtomValue(currentSourcesAtom);
    const [isCommandPressed, setIsCommandPressed] = useState(false);
    const isStreaming = useAtomValue(isStreamingAtom);
    const generateResponse = useSetAtom(generateResponseAtom);
    const newThread = useSetAtom(newThreadAtom);
    const [isAddAttachmentMenuOpen, setIsAddAttachmentMenuOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [isCancellable, setIsCancellable] = useAtom(isCancellableAtom);
    const cancelStreamingMessage = useSetAtom(cancelStreamingMessageAtom);
    const setIsCancelling = useSetAtom(isCancellingAtom);
    const readerTextSelection = useAtomValue(readerTextSelectionAtom);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            if (messageContent) {
                inputRef.current.style.height = `${inputRef.current.scrollHeight}px`;
            }
        }
    }, [messageContent]);
    
    const handleSubmit = async (
        e: React.FormEvent<HTMLFormElement> | React.MouseEvent<HTMLButtonElement>,
        isLibrarySearch: boolean = false
    ) => {
        e.preventDefault();
        chatCompletion(messageContent, isCommandPressed || isLibrarySearch);
    };

    const chatCompletion = async (
        query: string,
        isLibrarySearch: boolean = false
    ) => {
        if (isStreaming || query.length === 0) return;

        // Generate response
        generateResponse({
            content: query,
            sources: currentSources,
            isLibrarySearch: isLibrarySearch
        });

        Zotero.debug(`Chat completion: ${query}`);
    };

    const handleStop = () => {
        Zotero.debug('Stopping chat completion');
        if (isCancellable && cancellerHolder.current) {
            // Set the cancelling state to true so that onError will cancel the message
            setIsCancelling(true);
            // Cancel the html connection (which will trigger the onError event)
            cancellerHolder.current();
            cancellerHolder.current = null;
            // Reset the cancellable state to false
            setIsCancellable(false);
        } else {
            Zotero.debug('WARNING: handleStop called but no canceller function was found in holder.');
        }
    };

    const handleAddSources = async () => {
        Zotero.debug('Adding context item');
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (!isAgentModel && ((Zotero.isMac && e.key === 'Meta') || (!Zotero.isMac && e.key === 'Control'))) {
            setIsCommandPressed(true);
        }
        
        // Handle ⌘N (Mac) or Ctrl+N (Windows/Linux) for new thread
        if ((e.key === 'n' || e.key === 'N') && ((Zotero.isMac && e.metaKey) || (!Zotero.isMac && e.ctrlKey))) {
            e.preventDefault();
            newThread();
        }

        // Handle ⌘^1 (Mac) or Ctrl+Win+1 (Windows/Linux) etc. for custom prompt
        for (let i = 1 as 1 | 2 | 3 | 4 | 5 | 6; i <= 6; i++) {
            if (e.key === i.toString() &&  ((Zotero.isMac && e.metaKey && e.ctrlKey) || (!Zotero.isMac && e.ctrlKey && e.metaKey))) {
                e.preventDefault();
                handleCustomPrompt(i);
            }
        }
    };

    const handleCustomPrompt = (i: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9) => {
        const customPrompts = getCustomPromptsFromPreferences();
        if (!customPrompts[i - 1]) return;
        const customPrompt = customPrompts[i - 1];
        logger(`Custom prompt: ${i} ${customPrompt.text} ${currentSources.length}`);
        if (customPrompt && (!customPrompt.requiresAttachment || currentSources.length > 0)) {
            chatCompletion(customPrompt.text, customPrompt.librarySearch);
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
            {/* Message attachments */}
            <MessageAttachmentDisplay
                isAddAttachmentMenuOpen={isAddAttachmentMenuOpen}
                setIsAddAttachmentMenuOpen={setIsAddAttachmentMenuOpen}
                menuPosition={menuPosition}
                setMenuPosition={setMenuPosition}
                inputRef={inputRef as React.RefObject<HTMLTextAreaElement>}
            />

            {/* Input Form */}
            <form onSubmit={handleSubmit} className="display-flex flex-col">
                {/* Message Input  */}
                <div className="mb-2 -ml-1">
                    <textarea
                        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                        value={messageContent}
                        // onChange={(e) => setMessageContent(e.target.value)}
                        onChange={(e) => {
                            if (e.target.value.endsWith('@')) {
                                const rect = e.currentTarget.getBoundingClientRect();
                                setMenuPosition({ 
                                    x: rect.left,
                                    y: rect.top - 5
                                })
                                setIsAddAttachmentMenuOpen(true);
                            } else {
                                setMessageContent(e.target.value);
                            }
                        }}
                        onInput={(e) => {
                            e.currentTarget.style.height = 'auto';
                            e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                        }}
                        placeholder="@ to add a source"
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
                <div className="display-flex flex-row items-center pt-2">
                    <ModelSelectionButton inputRef={inputRef as React.RefObject<HTMLTextAreaElement>} />
                    <div className="flex-1" />
                    <div className="display-flex gap-2">
                        {!isAgentModel && 
                            <Button
                                type={(isCommandPressed && !isStreaming && messageContent.length > 0) ? "button" : undefined}
                                variant={(isCommandPressed && !isStreaming) ? 'solid' : 'outline'}
                                // className={`mr-1 ${isCommandPressed ? '' : 'opacity-50'}`}
                                className="mr-1"
                                onClick={(e) => handleSubmit(e as any, true)}
                                disabled={isStreaming || messageContent.length === 0}
                            >
                                Library Search
                                <span className="opacity-50">
                                    {Zotero.isMac ? '⌘' : '⌃'}⏎
                                </span>
                            </Button>
                        }
                        <Button
                            rightIcon={isStreaming ? StopIcon : undefined}
                            type={!isCommandPressed && !isStreaming && messageContent.length > 0 ? "button" : undefined}
                            variant={!isCommandPressed || isStreaming ? 'solid' : 'outline'  }
                            className="mr-1"
                            onClick={isStreaming ? handleStop : handleSubmit}
                            disabled={(messageContent.length === 0 && !isStreaming) || (isStreaming && !isCancellable)}
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