import React, { useState, useEffect } from 'react';
import { StopIcon, GlobalSearchIcon } from '../icons/icons';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { isStreamingAtom, newThreadAtom, isCancellableAtom, cancellerHolder, isCancellingAtom } from '../../atoms/threads';
import { currentMessageContentAtom, currentMessageItemsAtom } from '../../atoms/messageComposition';
import { generateResponseAtom } from '../../atoms/generateMessages';
import { sendWSMessageAtom, isWSChatPendingAtom, wsStreamedContentAtom, wsErrorAtom } from '../../atoms/generateMessagesWS';
import Button from '../ui/Button';
import { MenuPosition } from '../ui/menus/SearchMenu';
import ModelSelectionButton from '../ui/buttons/ModelSelectionButton';
import MessageAttachmentDisplay from '../messages/MessageAttachmentDisplay';
import { getCustomPromptsFromPreferences } from '../../types/settings';
import { logger } from '../../../src/utils/logger';
import { isLibraryTabAtom, isWebSearchEnabledAtom } from '../../atoms/ui';
import { selectedModelAtom } from '../../atoms/models';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';

interface InputAreaProps {
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

const InputArea: React.FC<InputAreaProps> = ({
    inputRef
}) => {
    const [messageContent, setMessageContent] = useAtom(currentMessageContentAtom);
    const currentMessageItems = useAtomValue(currentMessageItemsAtom);
    const [isCommandPressed, setIsCommandPressed] = useState(false);
    const isStreaming = useAtomValue(isStreamingAtom);
    const selectedModel = useAtomValue(selectedModelAtom);
    const generateResponse = useSetAtom(generateResponseAtom);
    const newThread = useSetAtom(newThreadAtom);
    const [isAddAttachmentMenuOpen, setIsAddAttachmentMenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [isCancellable, setIsCancellable] = useAtom(isCancellableAtom);
    const setIsCancelling = useSetAtom(isCancellingAtom);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);
    const [isWebSearchEnabled, setIsWebSearchEnabled] = useAtom(isWebSearchEnabledAtom);

    // WebSocket test state
    const sendWSMessage = useSetAtom(sendWSMessageAtom);
    const isWSPending = useAtomValue(isWSChatPendingAtom);
    const wsContent = useAtomValue(wsStreamedContentAtom);
    const wsError = useAtomValue(wsErrorAtom);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            inputRef.current.style.height = `${inputRef.current.scrollHeight}px`;
        }
    }, [messageContent]);
    
    const handleSubmit = async (
        e: React.FormEvent<HTMLFormElement> | React.MouseEvent<HTMLButtonElement>
    ) => {
        e.preventDefault();
        chatCompletion(messageContent);
    };

    const chatCompletion = async (
        query: string
    ) => {
        if (isStreaming || query.length === 0) return;

        // Generate response
        generateResponse({
            content: query,
            items: currentMessageItems
        });

        logger(`Chat completion: ${query}`);
    };

    const handleStop = () => {
        logger('Stopping chat completion');
        if (isCancellable && cancellerHolder.current) {
            // Set the cancelling state to true so that onError will cancel the message
            setIsCancelling(true);
            // Cancel the html connection (which will trigger the onError event)
            cancellerHolder.current();
            cancellerHolder.current = null;
            // Reset the cancellable state to false
            setIsCancellable(false);
        } else {
            logger('WARNING: handleStop called but no canceller function was found in holder.');
        }
    };

    const handleAddSources = async () => {
        logger('Adding context item');
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {        
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
        logger(`Custom prompt: ${i} ${customPrompt.text} ${currentMessageItems.length}`);
        if (customPrompt && (!customPrompt.requiresAttachment || currentMessageItems.length > 0)) {
            chatCompletion(customPrompt.text);
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

    // WebSocket test handler
    const handleWSTest = () => {
        const testMessage = messageContent.length > 0 ? messageContent : 'Hello from WebSocket test!';
        logger(`Testing WebSocket with message: ${testMessage}`);
        sendWSMessage(testMessage);
    };

    return (
        // <DragDropWrapper addFileSource={addFileSource}>
        <div
            className="user-message-display shadow-md shadow-md-top"
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
                        placeholder={isLibraryTab ? "@ to add a source" : "@ to add a source, drag to add annotations"}
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
                    <div className="display-flex flex-row items-center gap-4">
                        <Tooltip content={isWebSearchEnabled ? 'Disable web search' : 'Enable web search'} singleLine>
                            <IconButton
                                icon={GlobalSearchIcon}
                                variant="ghost-secondary"
                                className="scale-12 mt-015"
                                iconClassName={isWebSearchEnabled ? 'font-color-accent-blue stroke-width-2' : ''}
                                onClick={() => setIsWebSearchEnabled(!isWebSearchEnabled)}
                            />
                        </Tooltip>
                        {/* ----- Temporary WebSocket test button ----- */}
                        <Tooltip content={wsError ? `WS Error: ${wsError.message}` : (wsContent ? `WS: ${wsContent.substring(0, 50)}...` : 'Test WebSocket')} singleLine>
                            <Button
                                variant="outline"
                                style={{ padding: '2px 8px' }}
                                onClick={handleWSTest}
                                disabled={isWSPending}
                            >
                                {isWSPending ? 'WS...' : 'WS'}
                            </Button>
                        </Tooltip>
                        {/* ----- End of Temporary WebSocket test button ----- */}
                        <Button
                            rightIcon={isStreaming ? StopIcon : undefined}
                            type={!isCommandPressed && !isStreaming && messageContent.length > 0 ? "button" : undefined}
                            variant={!isCommandPressed || isStreaming ? 'solid' : 'outline'  }
                            style={{ padding: '2px 5px' }}
                            onClick={isStreaming ? handleStop : handleSubmit}
                            disabled={(messageContent.length === 0 && !isStreaming) || (isStreaming && !isCancellable) || !selectedModel}
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