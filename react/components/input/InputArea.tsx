import React, { useState, useEffect, useCallback } from 'react';
import { StopIcon, GlobalSearchIcon } from '../icons/icons';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { newThreadAtom, currentThreadIdAtom } from '../../atoms/threads';
import { currentMessageContentAtom, currentMessageItemsAtom, pendingActionInputFocusAtom } from '../../atoms/messageComposition';
import { findNextUserInputVariable } from '../../utils/userInputVariables';
import { sendWSMessageAtom, isWSChatPendingAtom, closeWSConnectionAtom, sendApprovalResponseAtom } from '../../atoms/agentRunAtoms';
import { pendingApprovalsAtom, removePendingApprovalAtom } from '../../agents/agentActions';
import Button from '../ui/Button';
import SearchMenu, { MenuPosition } from '../ui/menus/SearchMenu';
import ModelSelectionButton from '../ui/buttons/ModelSelectionButton';
import MessageAttachmentDisplay from '../messages/MessageAttachmentDisplay';
import { logger } from '../../../src/utils/logger';
import { isLibraryTabAtom, isWebSearchAllowedAtom, isWebSearchEnabledAtom } from '../../atoms/ui';
import { currentNoteItemAtom } from '../../atoms/zoteroContext';
import { selectedModelAtom, isUsingBeaverCreditsAtom } from '../../atoms/models';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import PendingActionsBar from './PendingActionsBar';
import HighTokenUsageWarningBar from './HighTokenUsageWarningBar';
import SoftCapWarningBar from './SoftCapWarningBar';
import NextStepsPanel from '../pages/firstRun/NextStepsPanel';
import BackToSuggestions from '../pages/firstRun/BackToSuggestions';
import { allRunsAtom } from '../../agents/atoms';
import { PromptOrigin } from '../../agents/types';
import { firstRunNextStepsDismissedAtom } from '../../atoms/firstRun';
import { dismissHighTokenWarningForThreadAtom, dismissedHighTokenWarningByThreadAtom, dismissSoftCapWarningForThreadAtom, dismissedSoftCapWarningByThreadAtom, backendHighTokenUsageRunsAtom, softCapTriggeredRunsAtom } from '../../atoms/messageUIState';
import { getLastRequestInputTokens } from '../../utils/runUsage';
import { getPref, setPref } from '../../../src/utils/prefs';
import { useSlashMenu } from '../../hooks/useSlashMenu';

const HIGH_INPUT_TOKEN_WARNING_THRESHOLD = 100_000;

interface InputAreaProps {
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
    verticalPosition?: 'above' | 'below';
    placeholder?: string;
    hideModelSelector?: boolean;
    hideAttachmentMenu?: boolean;
}

const InputArea: React.FC<InputAreaProps> = ({
    inputRef,
    verticalPosition = 'above',
    placeholder,
    hideModelSelector = false,
    hideAttachmentMenu = false,
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
    const currentNoteItem = useAtomValue(currentNoteItemAtom);
    const pendingActionFocus = useAtomValue(pendingActionInputFocusAtom);

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

    // First-run next steps — driven by persisted origin on the last run, with
    // session-only dismissal tracked in a Set atom. Mirrors the predicates
    // previously used in AgentRunView.
    const nextStepsDismissedRunIds = useAtomValue(firstRunNextStepsDismissedAtom);
    const setNextStepsDismissedRunIds = useSetAtom(firstRunNextStepsDismissedAtom);
    const lastRunId = lastRun?.id;
    const handleDismissNextSteps = useCallback(() => {
        if (!lastRunId) return;
        setNextStepsDismissedRunIds((prev) => {
            if (prev.has(lastRunId)) return prev;
            const next = new Set(prev);
            next.add(lastRunId);
            return next;
        });
    }, [setNextStepsDismissedRunIds, lastRunId]);
    const showNextSteps = Boolean(
        !isAwaitingApproval &&
        lastRun &&
        lastRun.user_prompt.origin?.kind === 'first_run_card' &&
        lastRun.status === 'completed' &&
        !nextStepsDismissedRunIds.has(lastRun.id)
    );
    const showBackToSuggestions = Boolean(
        !isAwaitingApproval &&
        lastRun &&
        lastRun.user_prompt.origin?.kind === 'first_run_followup' &&
        lastRun.status === 'completed' &&
        !nextStepsDismissedRunIds.has(lastRun.id)
    );

    // Mutual exclusion: NextSteps/BackToSuggestions take precedence over the
    // token/soft-cap warning bars; HighToken takes precedence over SoftCap.
    const firstRunPanelVisible = showNextSteps || showBackToSuggestions;
    const showHighTokenWarningBar = shouldShowHighTokenWarning && !firstRunPanelVisible;
    const canRenderHighTokenWarningBar = showHighTokenWarningBar && lastRequestInputTokens !== null;
    const showSoftCapWarningBar = shouldShowSoftCapWarning && !firstRunPanelVisible && !canRenderHighTokenWarningBar;

    // Slash menu hook
    const {
        isSlashMenuOpen,
        slashMenuPosition,
        slashSearchQuery,
        setSlashSearchQuery,
        slashMenuItems,
        handleSlashDismiss,
        handleSlashMenuChange,
        handleSlashTrigger,
        handleSlashMenuKeyDown,
    } = useSlashMenu(inputRef, verticalPosition);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            inputRef.current.style.height = `${inputRef.current.scrollHeight}px`;
        }
    }, [messageContent]);

    // When an action with `[[name]]` placeholders is staged, focus the textarea
    // and select the first placeholder so the user can replace it by typing.
    useEffect(() => {
        if (pendingActionFocus === 0) return;
        const ta = inputRef.current;
        if (!ta) return;
        // Defer to next tick so messageContent has propagated to the textarea value.
        const timer = setTimeout(() => {
            const first = findNextUserInputVariable(ta.value, 0);
            ta.focus();
            if (first) {
                ta.setSelectionRange(first.start, first.end);
            } else {
                const end = ta.value.length;
                ta.setSelectionRange(end, end);
            }
        }, 0);
        return () => clearTimeout(timer);
    }, [pendingActionFocus]);

    /** Tab → select the next `[[name]]` after the cursor, or fall through. */
    const handleVariableTab = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (e.key !== 'Tab' || e.shiftKey) return false;
        const ta = e.currentTarget;
        const cursor = ta.selectionEnd;
        const next = findNextUserInputVariable(ta.value, cursor);
        if (!next) return false;
        e.preventDefault();
        ta.setSelectionRange(next.start, next.end);
        return true;
    };

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
    };

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
        if (placeholder !== undefined) return placeholder;
        if (isAwaitingApproval) return "Add instructions to reject";
        if (showSoftCapWarningBar) return "Yes to continue, or add instructions to adjust";
        if (isLibraryTab) return "@ to add a source, / for actions";
        if (currentNoteItem) return "@ to add a source, / for actions";
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
            {canRenderHighTokenWarningBar && (
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
            {showSoftCapWarningBar && (
                <SoftCapWarningBar
                    onEnableLongRunning={handleEnableLongRunning}
                    onDismiss={handleDismissSoftCapWarning}
                />
            )}

            {/* First-run "Next steps" panel — shown after a run that originated
                from a first-run suggestion card. Auto-dismisses on type. */}
            {showNextSteps && lastRun && (
                <NextStepsPanel
                    origin={lastRun.user_prompt.origin as Extract<PromptOrigin, { kind: 'first_run_card' }>}
                    onDismiss={handleDismissNextSteps}
                />
            )}

            {/* After a first-run follow-up run, offer a path back to the
                suggestion grid. */}
            {showBackToSuggestions && (
                <div className="next-steps-panel px-3 py-2">
                    <BackToSuggestions onDismiss={handleDismissNextSteps} />
                </div>
            )}

            {/* Message attachments */}
            {!hideAttachmentMenu && (
                <MessageAttachmentDisplay
                    isAddAttachmentMenuOpen={isAddAttachmentMenuOpen}
                    setIsAddAttachmentMenuOpen={setIsAddAttachmentMenuOpen}
                    menuPosition={menuPosition}
                    setMenuPosition={setMenuPosition}
                    inputRef={inputRef as React.RefObject<HTMLTextAreaElement>}
                    disabled={isAwaitingApproval}
                    verticalPosition={verticalPosition}
                />
            )}

            {/* Slash command menu */}
            <SearchMenu
                menuItems={slashMenuItems}
                isOpen={isSlashMenuOpen}
                onClose={handleSlashDismiss}
                position={slashMenuPosition}
                verticalPosition={verticalPosition}
                useFixedPosition={true}
                width="250px"
                searchQuery={slashSearchQuery}
                setSearchQuery={setSlashSearchQuery}
                onSearch={() => {}}
                noResultsText="No actions found"
                placeholder="Search actions..."
                closeOnSelect={false}
                showSearchInput={false}
            />

            {/* Input Form */}
            <form onSubmit={handleSubmit} className="display-flex flex-col">
                {/* Message Input  */}
                <div className="mb-2 -ml-1">
                    <textarea
                        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                        value={messageContent}
                        onChange={(e) => {
                            const value = e.target.value;

                            // When slash menu is open, track search query from typed text
                            if (handleSlashMenuChange(value)) return;

                            // Detect `/` trigger: at start or after whitespace/newline
                            if (!isAddAttachmentMenuOpen && handleSlashTrigger(value, e.currentTarget.getBoundingClientRect())) return;

                            // Don't open attachment menu when awaiting approval, or when explicitly hidden
                            if (e.target.value.endsWith('@') && !isAwaitingApproval && !hideAttachmentMenu) {
                                const rect = e.currentTarget.getBoundingClientRect();
                                const y = verticalPosition === 'above' ? rect.top - 5 : rect.bottom - 10;
                                setMenuPosition({
                                    x: rect.left,
                                    y,
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
                        placeholder={getPlaceholderText()}
                        aria-label="Message Beaver"
                        className="chat-input"
                        onKeyDown={(e) => {
                            // When slash menu is open, handle navigation and dismiss keys
                            if (handleSlashMenuKeyDown(e)) return;
                            // Tab cycles through [[name]] placeholders before any other handling
                            if (handleVariableTab(e)) return;
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
                    {!hideModelSelector && (
                        <ModelSelectionButton inputRef={inputRef as React.RefObject<HTMLTextAreaElement>} disabled={isAwaitingApproval} />
                    )}
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
                            ariaLabel={
                                isAwaitingApproval && messageContent.trim().length > 0
                                    ? pendingApprovalsMap.size > 1 ? 'Reject all proposed actions' : 'Reject proposed action'
                                    : isPending
                                        ? 'Stop generating'
                                        : 'Send message'
                            }
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
