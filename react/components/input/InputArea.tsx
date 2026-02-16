import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { StopIcon, GlobalSearchIcon, PlusSignIcon } from '../icons/icons';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { newThreadAtom, currentThreadIdAtom } from '../../atoms/threads';
import { currentMessageContentAtom, currentMessageItemsAtom, currentReaderAttachmentAtom } from '../../atoms/messageComposition';
import { sendWSMessageAtom, isWSChatPendingAtom, closeWSConnectionAtom, sendApprovalResponseAtom } from '../../atoms/agentRunAtoms';
import { pendingApprovalsAtom, removePendingApprovalAtom } from '../../agents/agentActions';
import Button from '../ui/Button';
import SearchMenu, { MenuPosition, SearchMenuItem } from '../ui/menus/SearchMenu';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';
import { CustomPrompt } from '../../types/settings';
import ModelSelectionButton from '../ui/buttons/ModelSelectionButton';
import MessageAttachmentDisplay from '../messages/MessageAttachmentDisplay';
import { customPromptsForContextAtom, markPromptUsedAtom } from '../../atoms/customPrompts';
import { logger } from '../../../src/utils/logger';
import { isLibraryTabAtom, isWebSearchEnabledAtom } from '../../atoms/ui';
import { selectedModelAtom } from '../../atoms/models';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import PendingActionsBar from './PendingActionsBar';
import HighTokenUsageWarningBar from './HighTokenUsageWarningBar';
import { allRunsAtom } from '../../agents/atoms';
import { dismissHighTokenWarningForThreadAtom, dismissedHighTokenWarningByThreadAtom } from '../../atoms/messageUIState';
import { getLastRequestInputTokens } from '../../utils/runUsage';
import { getPref } from '../../../src/utils/prefs';

const HIGH_INPUT_TOKEN_WARNING_THRESHOLD = 100_000;

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
    const customPrompts = useAtomValue(customPromptsForContextAtom);
    const markPromptUsed = useSetAtom(markPromptUsedAtom);
    const currentReaderAttachment = useAtomValue(currentReaderAttachmentAtom);
    const [isSlashMenuOpen, setIsSlashMenuOpen] = useState(false);
    const [slashMenuPosition, setSlashMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [slashSearchQuery, setSlashSearchQuery] = useState('');
    const preSlashTextRef = useRef('');
    const allRuns = useAtomValue(allRunsAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const dismissedWarningsByThread = useAtomValue(dismissedHighTokenWarningByThreadAtom);
    const dismissHighTokenWarning = useSetAtom(dismissHighTokenWarningForThreadAtom);

    // WebSocket state
    const sendWSMessage = useSetAtom(sendWSMessageAtom);
    const closeWSConnection = useSetAtom(closeWSConnectionAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);

    // Pending approval state (for deferred tools)
    // With parallel tool calls, there can be multiple pending approvals
    const pendingApprovalsMap = useAtomValue(pendingApprovalsAtom);
    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const removePendingApproval = useSetAtom(removePendingApprovalAtom);
    const isAwaitingApproval = pendingApprovalsMap.size > 0;
    // For "reject with instructions" feature, get the first pending approval (if any)
    const firstPendingApproval = pendingApprovalsMap.size > 0 
        ? Array.from(pendingApprovalsMap.values())[0] 
        : null;
    const lastRun = allRuns.length > 0 ? allRuns[allRuns.length - 1] : null;
    const lastRunUsage = lastRun?.total_usage;
    const lastRequestInputTokens = lastRunUsage ? getLastRequestInputTokens(lastRunUsage) : null;
    const warningThreadId = lastRun?.thread_id ?? currentThreadId;
    const dismissedRunId = warningThreadId ? dismissedWarningsByThread[warningThreadId] : undefined;
    const showHighTokenUsageWarningMessage = getPref('showHighTokenUsageWarningMessage');
    const shouldShowHighTokenWarning = Boolean(
        showHighTokenUsageWarningMessage &&
        !isAwaitingApproval &&
        lastRun &&
        warningThreadId &&
        lastRequestInputTokens !== null &&
        lastRequestInputTokens > HIGH_INPUT_TOKEN_WARNING_THRESHOLD &&
        dismissedRunId !== lastRun.id
    );

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
        closeWSConnection(); // Also clears all pending approvals
    };

    const handleRejectWithInstructions = (e?: React.MouseEvent | React.FormEvent) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        if (pendingApprovalsMap.size === 0) return;
        const instructions = messageContent.trim() || null;
        for (const pendingApproval of pendingApprovalsMap.values()) {
            logger(`Rejecting approval ${pendingApproval.actionId} with instructions: ${instructions}`);
            sendApprovalResponse({
                actionId: pendingApproval.actionId,
                approved: false,
                userInstructions: instructions,
            });
            removePendingApproval(pendingApproval.actionId);
        }
        setMessageContent('');
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Handle ⌘N (Mac) or Ctrl+N (Windows/Linux) for new thread
        if ((e.key === 'n' || e.key === 'N') && ((Zotero.isMac && e.metaKey) || (!Zotero.isMac && e.ctrlKey))) {
            e.preventDefault();
            newThread();
        }

        // Handle ⌘^1-9 (Mac) or Ctrl+Win+1-9 (Windows/Linux) for custom prompt
        for (let i = 1; i <= 9; i++) {
            if (e.key === i.toString() && ((Zotero.isMac && e.metaKey && e.ctrlKey) || (!Zotero.isMac && e.ctrlKey && e.metaKey))) {
                e.preventDefault();
                handleCustomPrompt(i);
            }
        }
    };

    const handleCustomPrompt = (i: number) => {
        const customPrompt = customPrompts.find(p => p.shortcut === i);
        if (!customPrompt) return;
        logger(`Custom prompt: ${i} ${customPrompt.text} ${currentMessageItems.length}`);
        if (!customPrompt.requiresAttachment || currentMessageItems.length > 0) {
            if (customPrompt.id) markPromptUsed(customPrompt.id);
            sendMessage(customPrompt.text);
        }
    }

    // Slash menu: derived state & handlers
    const hasAttachment = currentMessageItems.length > 0 || !!currentReaderAttachment;

    const handleSlashSelect = useCallback((prompt: CustomPrompt) => {
        const pre = preSlashTextRef.current;
        const fullMessage = pre.length > 0
            ? (pre + '\n\n' + prompt.text).trim()
            : prompt.text.trim();
        setIsSlashMenuOpen(false);
        setSlashSearchQuery('');
        setMessageContent('');
        if (prompt.id) markPromptUsed(prompt.id);
        sendMessage(fullMessage);
        setTimeout(() => inputRef.current?.focus(), 0);
    }, [sendMessage, markPromptUsed]);

    const handleSlashDismiss = useCallback(() => {
        setIsSlashMenuOpen(false);
        setSlashSearchQuery('');
        // Keep the "/" in the input when dismissing
        setMessageContent(preSlashTextRef.current + '/');
        setTimeout(() => inputRef.current?.focus(), 0);
    }, []);

    const slashMenuItems = useMemo<SearchMenuItem[]>(() => {
        const query = slashSearchQuery.toLowerCase();
        const items: SearchMenuItem[] = [];

        // Note: SearchMenu reverses items for verticalPosition="above",
        // so we build in reverse visual order: footer first, prompts, header last.

        // Custom prompt items: enabled first, disabled last (reversed for "above")
        const filtered = customPrompts.filter(prompt =>
            !query || prompt.title.toLowerCase().includes(query) || prompt.text.toLowerCase().includes(query)
        );

        // "Create Action" footer (visually at bottom)
        // Show when: no query, query matches "create action", or no matching prompts
        const createActionItem: SearchMenuItem[] = !query || 'create action'.includes(query) || filtered.length === 0
            ? [{
                label: 'Create Action',
                icon: PlusSignIcon,
                onClick: () => {
                    setIsSlashMenuOpen(false);
                    setSlashSearchQuery('');
                    setMessageContent(preSlashTextRef.current + '/');
                    openPreferencesWindow('prompts');
                },
            }] : [];
        const enabled = filtered.filter(p => !p.requiresAttachment || hasAttachment);
        const disabled = filtered.filter(p => p.requiresAttachment && !hasAttachment);

        // Sort each group: most recently used first, then by preferences order
        const sortByUsage = (a: CustomPrompt, b: CustomPrompt): number => {
            if (a.lastUsed && !b.lastUsed) return -1;
            if (!a.lastUsed && b.lastUsed) return 1;
            if (a.lastUsed && b.lastUsed) {
                const diff = new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
                if (diff !== 0) return diff;
            }
            return (a.index ?? Infinity) - (b.index ?? Infinity);
        };
        enabled.sort(sortByUsage);
        disabled.sort(sortByUsage);

        // Disabled items go first in array (visually at bottom after reverse)
        for (let i = disabled.length - 1; i >= 0; i--) {
            items.push({
                label: disabled[i].title,
                onClick: () => handleSlashSelect(disabled[i]),
                disabled: true,
            });
        }
        // Enabled items go after (visually above disabled after reverse)
        for (let i = enabled.length - 1; i >= 0; i--) {
            items.push({
                label: enabled[i].title,
                onClick: () => handleSlashSelect(enabled[i]),
            });
        }

        // Group header (visually at top)
        // const groupHeaderItem = { label: 'Actions', onClick: () => {}, isGroupHeader: true };

        return [...items.reverse(), ...createActionItem];
    }, [customPrompts, slashSearchQuery, hasAttachment, handleSlashSelect]);

    const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
        // Check if the click target is a button or within a button
        const isButtonClick = (e.target as Element).closest('button') !== null;
        
        // Only focus if not clicking a button and editing is enabled
        if (!isButtonClick && inputRef.current) {
            inputRef.current.focus();
        }
    };

    const handleDismissHighTokenWarning = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!warningThreadId || !lastRun) return;
        dismissHighTokenWarning({
            threadId: warningThreadId,
            runId: lastRun.id,
        });
    };

    return (
        <div
            className="user-message-display shadow-md shadow-md-top"
            onClick={handleContainerClick}
            style={{ minHeight: 'fit-content' }}
        >
            {/* Pending actions bar - shown when awaiting approval */}
            <PendingActionsBar />
            {shouldShowHighTokenWarning && lastRequestInputTokens !== null && (
                <HighTokenUsageWarningBar
                    onNewThread={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        newThread();
                    }}
                    onDismiss={handleDismissHighTokenWarning}
                />
            )}

            {/* Message attachments */}
            <MessageAttachmentDisplay
                isAddAttachmentMenuOpen={isAddAttachmentMenuOpen}
                setIsAddAttachmentMenuOpen={setIsAddAttachmentMenuOpen}
                menuPosition={menuPosition}
                setMenuPosition={setMenuPosition}
                inputRef={inputRef as React.RefObject<HTMLTextAreaElement>}
                disabled={isAwaitingApproval}
            />

            {/* Slash command menu */}
            <SearchMenu
                menuItems={slashMenuItems}
                isOpen={isSlashMenuOpen}
                onClose={handleSlashDismiss}
                position={slashMenuPosition}
                verticalPosition="above"
                useFixedPosition={true}
                width="250px"
                searchQuery={slashSearchQuery}
                setSearchQuery={setSlashSearchQuery}
                onSearch={() => {}}
                noResultsText="No actions found"
                placeholder="Search actions..."
                closeOnSelect={true}
                // showSearchInput={customPrompts.length > 6}
                showSearchInput={true}
            />

            {/* Input Form */}
            <form onSubmit={handleSubmit} className="display-flex flex-col">
                {/* Message Input  */}
                <div className="mb-2 -ml-1">
                    <textarea
                        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                        value={messageContent}
                        onChange={(e) => {
                            // Block textarea changes while slash menu is open
                            if (isSlashMenuOpen) return;

                            const value = e.target.value;

                            // Detect `/` trigger: at start or after whitespace/newline
                            if (value.endsWith('/') && !isAddAttachmentMenuOpen) {
                                const charBefore = value.length > 1 ? value[value.length - 2] : null;
                                if (charBefore === null || charBefore === ' ' || charBefore === '\n') {
                                    preSlashTextRef.current = value.slice(0, -1);
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    setSlashMenuPosition({ x: rect.left, y: rect.top - 5 });
                                    setIsSlashMenuOpen(true);
                                    setSlashSearchQuery('');
                                    setMessageContent(value);
                                    return;
                                }
                            }

                            // Don't open attachment menu when awaiting approval or slash menu is open
                            if (e.target.value.endsWith('@') && !isAwaitingApproval && !isSlashMenuOpen) {
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
                            : (isLibraryTab ? "@ to add a source, / for actions" : "@ to add a source, / for actions, drag to add annotations")}
                        className="chat-input"
                        onKeyDown={(e) => {
                            // When slash menu is open, prevent Enter/Arrow keys from reaching textarea
                            if (isSlashMenuOpen) {
                                if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    return;
                                }
                                if (e.key === 'Escape') {
                                    e.preventDefault();
                                    handleSlashDismiss();
                                    return;
                                }
                                // Space with empty search query closes the menu (keeps /)
                                if (e.key === ' ' && slashSearchQuery.length === 0) {
                                    e.preventDefault();
                                    handleSlashDismiss();
                                    return;
                                }
                                // Backspace closes the menu and removes the /
                                if (e.key === 'Backspace') {
                                    e.preventDefault();
                                    setIsSlashMenuOpen(false);
                                    setSlashSearchQuery('');
                                    setMessageContent(preSlashTextRef.current);
                                    setTimeout(() => inputRef.current?.focus(), 0);
                                    return;
                                }
                            }
                            handleKeyDown(e);
                            // Submit on Enter (without Shift) - guard against pending to prevent race with button click
                            // Don't trigger reject on Enter when awaiting approval (must click button)
                            if (e.key === 'Enter' && !e.shiftKey && !isPending && !isAwaitingApproval && !isSlashMenuOpen) {
                                e.preventDefault();
                                handleSubmit(e as any);
                            }
                        }}
                        rows={1}
                    />
                </div>

                {/* Button Row */}
                <div className="display-flex flex-row items-center pt-2">
                    <ModelSelectionButton inputRef={inputRef as React.RefObject<HTMLTextAreaElement>} disabled={isAwaitingApproval} />
                    <div className="flex-1" />
                    <div className="display-flex flex-row items-center gap-4">
                        <Tooltip content={isWebSearchEnabled ? 'Disable web search' : 'Enable web search'} singleLine>
                            <IconButton
                                icon={GlobalSearchIcon}
                                variant="ghost-secondary"
                                className="scale-12 mt-015"
                                iconClassName={isWebSearchEnabled ? 'font-color-accent-blue stroke-width-2' : ''}
                                onClick={() => setIsWebSearchEnabled(!isWebSearchEnabled)}
                                disabled={isAwaitingApproval}
                            />
                        </Tooltip>
                        <Button
                            rightIcon={isPending && !(isAwaitingApproval && messageContent.trim().length > 0) ? StopIcon : undefined}
                            type="button"
                            variant={
                                (
                                    (isPending && !(isAwaitingApproval && messageContent.trim().length > 0)) ||
                                    (isAwaitingApproval && messageContent.trim().length > 0)
                                )
                                ? 'surface' : 'solid'
                            }
                            style={{ padding: '2px 5px' }}
                            onClick={
                                isAwaitingApproval && messageContent.trim().length > 0
                                    ? handleRejectWithInstructions
                                    : (isPending 
                                        ? (e) => handleStop(e as any) 
                                        : handleSubmit)
                            }
                            disabled={
                                // When awaiting approval with text, never disable (Reject button)
                                // When awaiting approval without text, never disable (Stop button)
                                // Otherwise, disable if no content and not pending, or no model selected
                                isAwaitingApproval 
                                    ? false
                                    : ((messageContent.length === 0 && !isPending) || !selectedModel || isSlashMenuOpen)
                            }
                        >
                            {isAwaitingApproval && messageContent.trim().length > 0
                                ? pendingApprovalsMap.size > 1 ? 'Reject All' : 'Reject'
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
