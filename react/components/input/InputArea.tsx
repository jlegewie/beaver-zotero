import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StopIcon, GlobalSearchIcon } from '../icons/icons';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { newThreadAtom, currentThreadIdAtom } from '../../atoms/threads';
import { currentMessageContentAtom, currentMessageItemsAtom } from '../../atoms/messageComposition';
import { sendWSMessageAtom, isWSChatPendingAtom, closeWSConnectionAtom, sendApprovalResponseAtom } from '../../atoms/agentRunAtoms';
import { pendingApprovalsAtom, removePendingApprovalAtom } from '../../agents/agentActions';
import Button from '../ui/Button';
import { MenuPosition } from '../ui/menus/SearchMenu';
import ModelSelectionButton from '../ui/buttons/ModelSelectionButton';
import MessageAttachmentDisplay from '../messages/MessageAttachmentDisplay';
import { logger } from '../../../src/utils/logger';
import { isLibraryTabAtom, isWebSearchAllowedAtom, isWebSearchEnabledAtom } from '../../atoms/ui';
import { selectedModelAtom, isUsingBeaverCreditsAtom } from '../../atoms/models';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import PendingActionsBar from './PendingActionsBar';
import HighTokenUsageWarningBar from './HighTokenUsageWarningBar';
import SoftCapWarningBar from './SoftCapWarningBar';
import { allRunsAtom } from '../../agents/atoms';
import { dismissHighTokenWarningForThreadAtom, dismissedHighTokenWarningByThreadAtom, dismissSoftCapWarningForThreadAtom, dismissedSoftCapWarningByThreadAtom, backendHighTokenUsageRunsAtom, softCapTriggeredRunsAtom } from '../../atoms/messageUIState';
import { getLastRequestInputTokens } from '../../utils/runUsage';
import { getPref, setPref } from '../../../src/utils/prefs';
import { LexicalEditorInput, LexicalEditorInputHandle } from './lexical/LexicalEditorInput';

const HIGH_INPUT_TOKEN_WARNING_THRESHOLD = 100_000;

interface InputAreaProps {
    // Kept for backward-compat with callers that only need `.focus()`.
    // The underlying element is now a contenteditable div managed by Lexical.
    inputRef: React.RefObject<HTMLElement | null>;
    verticalPosition?: 'above' | 'below';
}

const InputArea: React.FC<InputAreaProps> = ({
    inputRef,
    verticalPosition = 'above',
}) => {
    const [messageContent, setMessageContent] = useAtom(currentMessageContentAtom);
    const [currentMessageItems, setCurrentMessageItems] = useAtom(currentMessageItemsAtom);
    const selectedModel = useAtomValue(selectedModelAtom);
    const isUsingBeaverCredits = useAtomValue(isUsingBeaverCreditsAtom);
    const newThread = useSetAtom(newThreadAtom);
    const [isAddAttachmentMenuOpen, setIsAddAttachmentMenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const isLibraryTab = useAtomValue(isLibraryTabAtom);
    const [isWebSearchEnabled, setIsWebSearchEnabled] = useAtom(isWebSearchEnabledAtom);
    const allRuns = useAtomValue(allRunsAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const dismissedHighTokenByThread = useAtomValue(dismissedHighTokenWarningByThreadAtom);
    const dismissHighTokenWarning = useSetAtom(dismissHighTokenWarningForThreadAtom);
    const dismissedSoftCapByThread = useAtomValue(dismissedSoftCapWarningByThreadAtom);
    const dismissSoftCapWarning = useSetAtom(dismissSoftCapWarningForThreadAtom);
    const backendHighTokenUsageRuns = useAtomValue(backendHighTokenUsageRunsAtom);
    const softCapTriggeredRuns = useAtomValue(softCapTriggeredRunsAtom);
    const isWebSearchAllowed = useAtomValue(isWebSearchAllowedAtom);

    // Imperative handle exposed by the Lexical editor (focus / clear).
    const editorHandleRef = useRef<LexicalEditorInputHandle | null>(null);

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

    const lastRun = allRuns.length > 0 ? allRuns[allRuns.length - 1] : null;
    const lastRunUsage = lastRun?.total_usage;
    const lastRequestInputTokens = lastRunUsage ? getLastRequestInputTokens(lastRunUsage) : null;
    const warningThreadId = lastRun?.thread_id ?? currentThreadId;
    const isHighTokenDismissed = warningThreadId ? dismissedHighTokenByThread[warningThreadId] : false;
    const dismissedSoftCapRunId = warningThreadId ? dismissedSoftCapByThread[warningThreadId] : undefined;
    const showHighTokenUsageWarningMessage = getPref('showHighTokenUsageWarningMessage');
    const pauseLongRunningAgent = getPref('pauseLongRunningAgent');
    const threadHasHighTokenUsage = allRuns.some(r => backendHighTokenUsageRuns[r.id])
        || (lastRequestInputTokens !== null && lastRequestInputTokens > HIGH_INPUT_TOKEN_WARNING_THRESHOLD);
    const shouldShowHighTokenWarning = Boolean(
        showHighTokenUsageWarningMessage &&
        !isAwaitingApproval &&
        warningThreadId &&
        threadHasHighTokenUsage &&
        !isHighTokenDismissed
    );
    const shouldShowSoftCapWarning = Boolean(
        !isAwaitingApproval &&
        lastRun &&
        warningThreadId &&
        softCapTriggeredRuns[lastRun.id] &&
        pauseLongRunningAgent &&
        dismissedSoftCapRunId !== lastRun.id
    );

    // Slash handling now lives inside the Lexical editor (SlashCommandsPlugin).
    // Legacy slash-menu state kept inert to avoid touching other call sites.
    const isSlashMenuOpen = false;

    useEffect(() => {
        // Focus on mount via the Lexical handle.
        editorHandleRef.current?.focus();
    }, []);

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

    const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
        // Check if the click target is a button or within a button
        const isButtonClick = (e.target as Element).closest('button') !== null;

        // Only focus if not clicking a button and editing is enabled
        if (!isButtonClick) {
            editorHandleRef.current?.focus();
        }
    };

    // Handle the editor's submit signal (Enter without Shift).
    const handleEditorSubmit = useCallback(() => {
        if (isPending) {
            logger('handleEditorSubmit: Blocked - request already in progress');
            return;
        }
        if (isAwaitingApproval) {
            // Mirror old behavior: Enter does not reject-with-instructions,
            // users must click the button.
            return;
        }
        if (isSlashMenuOpen) return;
        sendMessage(messageContent);
    }, [isPending, isAwaitingApproval, isSlashMenuOpen, messageContent]);

    const handleDismissHighTokenWarning = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!warningThreadId) return;
        dismissHighTokenWarning(warningThreadId);
    };

    const handleDismissSoftCapWarning = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!warningThreadId || !lastRun) return;
        dismissSoftCapWarning({
            threadId: warningThreadId,
            runId: lastRun.id,
        });
    };

    const handleEnableLongRunning = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setPref('pauseLongRunningAgent', false);
        if (warningThreadId && lastRun) {
            dismissSoftCapWarning({
                threadId: warningThreadId,
                runId: lastRun.id,
            });
        }
    };

    const getPlaceholderText = () => {
        if (isAwaitingApproval) return "Add instructions to reject";
        if (shouldShowSoftCapWarning && !shouldShowHighTokenWarning) return "Yes to continue, or add instructions to adjust";
        if (isLibraryTab) return "@ to add a source, / for actions";
        return "@ to add a source, / for actions, drag to add annotations";
    }

    return (
        <div
            className="user-message-display"
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
                    isUsingBeaverCredits={isUsingBeaverCredits}
                />
            )}
            {shouldShowSoftCapWarning && (
                <SoftCapWarningBar
                    onEnableLongRunning={handleEnableLongRunning}
                    onDismiss={handleDismissSoftCapWarning}
                />
            )}

            {/* Message attachments */}
            <MessageAttachmentDisplay
                isAddAttachmentMenuOpen={isAddAttachmentMenuOpen}
                setIsAddAttachmentMenuOpen={setIsAddAttachmentMenuOpen}
                menuPosition={menuPosition}
                setMenuPosition={setMenuPosition}
                inputRef={inputRef}
                disabled={isAwaitingApproval}
                verticalPosition={verticalPosition}
            />

            {/* Input Form */}
            <form onSubmit={handleSubmit} className="display-flex flex-col">
                {/* Message Input - Lexical-backed rich input with inline pills */}
                <div className="mb-2 -ml-1">
                    <LexicalEditorInput
                        ref={editorHandleRef}
                        value={messageContent}
                        onChange={setMessageContent}
                        onSubmit={handleEditorSubmit}
                        placeholder={getPlaceholderText()}
                        ariaLabel="Message input"
                        disabled={isAwaitingApproval}
                        onContentEditableRef={(el) => {
                            // Forward the Lexical content-editable element to the
                            // parent's inputRef so legacy `.focus()` callers work.
                            (inputRef as React.MutableRefObject<HTMLElement | null>).current = el;
                        }}
                    />
                </div>

                {/* Button Row */}
                <div className="display-flex flex-row items-center pt-2">
                    <ModelSelectionButton inputRef={inputRef} disabled={isAwaitingApproval} />
                    <div className="flex-1" />
                    <div className="display-flex flex-row items-center gap-4">
                        <Tooltip
                            key={String(isWebSearchAllowed)}
                            content={isWebSearchAllowed ? (isWebSearchEnabled ? 'Disable web search' : 'Enable web search') : 'Web search requires Beaver credits'}
                            singleLine={isWebSearchAllowed}
                            padding={isWebSearchAllowed}
                            width={!isWebSearchAllowed ? '250px' : undefined}
                            customContent={!isWebSearchAllowed ? (
                                <div className="px-2 py-1 display-flex flex-col gap-1">
                                    <span className="text-base font-color-secondary font-semibold">Web search requires Beaver credits</span>
                                    <span className="text-sm font-color-tertiary">Use a Beaver model, or enable Plus Tools in Settings → API Keys</span>
                                </div>
                            ) : undefined}
                        >
                            <IconButton
                                icon={GlobalSearchIcon}
                                variant="ghost-secondary"
                                className="scale-12 mt-015"
                                iconClassName={isWebSearchEnabled ? 'font-color-accent-blue stroke-width-2' : ''}
                                onClick={() => setIsWebSearchEnabled(!isWebSearchEnabled)}
                                disabled={isAwaitingApproval || !isWebSearchAllowed}
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
