import React, { useState, useEffect } from 'react';
import { StopIcon, GlobalSearchIcon } from '../icons/icons';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { newThreadAtom } from '../../atoms/threads';
import { currentMessageContentAtom, currentMessageItemsAtom } from '../../atoms/messageComposition';
import { sendWSMessageAtom, isWSChatPendingAtom, closeWSConnectionAtom, sendApprovalResponseAtom } from '../../atoms/agentRunAtoms';
import { pendingApprovalAtom, clearPendingApprovalAtom } from '../../agents/agentActions';
import Button from '../ui/Button';
import { MenuPosition } from '../ui/menus/SearchMenu';
import ModelSelectionButton from '../ui/buttons/ModelSelectionButton';
import MessageAttachmentDisplay from '../messages/MessageAttachmentDisplay';
import { getCustomPromptsForContext } from '../../types/settings';
import { logger } from '../../../src/utils/logger';
import { isLibraryTabAtom, isWebSearchEnabledAtom } from '../../atoms/ui';
import { selectedModelAtom } from '../../atoms/models';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import { isDatabaseSyncSupportedAtom, processingModeAtom } from '../../atoms/profile';

interface InputAreaProps {
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

const InputArea: React.FC<InputAreaProps> = ({
    inputRef
}) => {
    const [messageContent, setMessageContent] = useAtom(currentMessageContentAtom);
    const currentMessageItems = useAtomValue(currentMessageItemsAtom);
    const selectedModel = useAtomValue(selectedModelAtom);
    const newThread = useSetAtom(newThreadAtom);
    const [isAddAttachmentMenuOpen, setIsAddAttachmentMenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const isLibraryTab = useAtomValue(isLibraryTabAtom);
    const [isWebSearchEnabled, setIsWebSearchEnabled] = useAtom(isWebSearchEnabledAtom);
    const isDatabaseSyncSupported = useAtomValue(isDatabaseSyncSupportedAtom);
    const processingMode = useAtomValue(processingModeAtom);

    // WebSocket state
    const sendWSMessage = useSetAtom(sendWSMessageAtom);
    const closeWSConnection = useSetAtom(closeWSConnectionAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);

    // Pending approval state (for deferred tools)
    const pendingApproval = useAtomValue(pendingApprovalAtom);
    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const clearPendingApproval = useSetAtom(clearPendingApprovalAtom);
    const isAwaitingApproval = pendingApproval !== null;

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
        // Guard against double submission
        if (isPending) {
            logger('handleSubmit: Blocked - request already in progress');
            return;
        }
        sendMessage(messageContent);
    };

    const sendMessage = (message: string) => {
        if (isPending || message.length === 0) return;
        logger(`Sending message: ${message}`);
        sendWSMessage(message);
    };

    const handleStop = (e?: React.MouseEvent) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        logger('Stopping chat completion');
        closeWSConnection();
    };

    const handleRejectWithInstructions = (e?: React.MouseEvent | React.FormEvent) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        if (!pendingApproval) return;
        
        const instructions = messageContent.trim() || null;
        logger(`Rejecting approval ${pendingApproval.actionId} with instructions: ${instructions}`);
        sendApprovalResponse({
            actionId: pendingApproval.actionId,
            approved: false,
            userInstructions: instructions,
        });
        clearPendingApproval();
        setMessageContent('');
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
        const customPrompts = getCustomPromptsForContext({
            isDatabaseSyncSupported,
            processingMode: processingMode
        });
        if (!customPrompts[i - 1]) return;
        const customPrompt = customPrompts[i - 1];
        logger(`Custom prompt: ${i} ${customPrompt.text} ${currentMessageItems.length}`);
        if (customPrompt && (!customPrompt.requiresAttachment || currentMessageItems.length > 0)) {
            sendMessage(customPrompt.text);
        }
    }


    const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
        // Check if the click target is a button or within a button
        const isButtonClick = (e.target as Element).closest('button') !== null;
        
        // Only focus if not clicking a button and editing is enabled
        if (!isButtonClick && inputRef.current) {
            inputRef.current.focus();
        }
    };

    return (
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
                        placeholder={isAwaitingApproval 
                            ? "Add instructions to reject" 
                            : (isLibraryTab ? "@ to add a source" : "@ to add a source, drag to add annotations")}
                        className="chat-input"
                        onKeyDown={(e) => {
                            handleKeyDown(e);
                            // Submit on Enter (without Shift) - guard against pending to prevent race with button click
                            // Don't trigger reject on Enter when awaiting approval (must click button)
                            if (e.key === 'Enter' && !e.shiftKey && !isPending && !isAwaitingApproval) {
                                e.preventDefault();
                                handleSubmit(e as any);
                            }
                        }}
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
                        <Button
                            rightIcon={isPending && !isAwaitingApproval ? StopIcon : undefined}
                            type="button"
                            variant="solid"
                            style={{ padding: '2px 5px' }}
                            onClick={
                                isAwaitingApproval
                                    ? handleRejectWithInstructions
                                    : (isPending 
                                        ? (e) => handleStop(e as any) 
                                        : handleSubmit)
                            }
                            disabled={
                                isAwaitingApproval 
                                    ? messageContent.trim().length === 0  // Reject requires instructions
                                    : ((messageContent.length === 0 && !isPending) || !selectedModel)
                            }
                        >
                            {isAwaitingApproval
                                ? 'Reject'
                                : isPending
                                    ? 'Stop'
                                    : (<span>Send <span className="opacity-50">⏎</span></span>)
                            }
                        </Button>
                    </div>
                </div>
            </form>
        </div>
    );
};

export default InputArea;