import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { StopIcon, GlobalSearchIcon } from '../icons/icons';
import { useAtom, useSetAtom, useAtomValue } from 'jotai';
import { newThreadAtom, currentThreadIdAtom } from '../../atoms/threads';
import { currentMessageContentAtom, pendingActionInputFocusAtom } from '../../atoms/messageComposition';
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
import { LexicalEditorInput, LexicalEditorInputHandle, SlashCommandDescriptor } from './lexical/LexicalEditorInput';
import { useSlashMenu } from '../../hooks/useSlashMenu';
import { sendComposedMessageAtom } from '../../atoms/actions';

const HIGH_INPUT_TOKEN_WARNING_THRESHOLD = 100_000;

interface InputAreaProps {
    // Kept for backward-compat with callers that only need `.focus()`.
    // The underlying element is now a contenteditable div managed by Lexical.
    inputRef: React.RefObject<HTMLElement | null>;
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
    const selectedModel = useAtomValue(selectedModelAtom);
    const isUsingBeaverCredits = useAtomValue(isUsingBeaverCreditsAtom);
    const newThread = useSetAtom(newThreadAtom);
    const [isAddAttachmentMenuOpen, setIsAddAttachmentMenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const [selectionRestoreTick, setSelectionRestoreTick] = useState(0);
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
    const webSearchDescriptionId = useId();

    // Imperative handle exposed by the Lexical editor (focus / clear).
    const editorHandleRef = useRef<LexicalEditorInputHandle | null>(null);
    const pendingSelectionRestoreRef = useRef<{ offset: number; skipFocus: boolean } | null>(null);
    const sourceMenuSelectionRestoreRef = useRef<{ offset: number; skipFocus: boolean } | null>(null);
    const focusEditor = useCallback(() => {
        editorHandleRef.current?.focus();
    }, []);
    // Stable forwarder so the slash menu can insert a command pill into the
    // Lexical editor (the editor handle isn't available until after mount).
    const insertSlashCommand = useCallback((descriptor: SlashCommandDescriptor, queryLength: number) => {
        editorHandleRef.current?.insertSlashCommand(descriptor, queryLength);
    }, []);

    // WebSocket state
    const sendWSMessage = useSetAtom(sendWSMessageAtom);
    const sendComposedMessage = useSetAtom(sendComposedMessageAtom);
    const closeWSConnection = useSetAtom(closeWSConnectionAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);

    // Pending approval state (for deferred tools)
    // With parallel tool calls, there can be multiple pending approvals
    const pendingApprovalsMap = useAtomValue(pendingApprovalsAtom);
    const sendApprovalResponse = useSetAtom(sendApprovalResponseAtom);
    const removePendingApproval = useSetAtom(removePendingApprovalAtom);
    const isAwaitingApproval = pendingApprovalsMap.size > 0;
    // Note: while an ask_user_question request is pending (and no approval is),
    // Sidebar renders AskUserQuestionPanel INSTEAD of this component, so no
    // question-mode handling is needed here.

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
    } = useSlashMenu(inputRef, verticalPosition, focusEditor, insertSlashCommand);

    useEffect(() => {
        if (isPending && getPref('focusResponseForScreenReaders')) {
            return;
        }
        // Focus on mount via the Lexical handle.
        focusEditor();
    }, []);

    // When an action with `[[name]]` placeholders is staged, focus the editor so
    // the user can start typing. Placeholder selection (previously done via the
    // textarea's setSelectionRange) is now handled inside the Lexical editor.
    useEffect(() => {
        if (pendingActionFocus === 0) return;
        const timer = setTimeout(() => {
            focusEditor();
            const first = findNextUserInputVariable(messageContent, 0);
            if (first) {
                editorHandleRef.current?.selectRange(first.start, first.end);
            } else {
                editorHandleRef.current?.selectRange(messageContent.length, messageContent.length);
            }
        }, 0);
        return () => clearTimeout(timer);
    }, [focusEditor, messageContent, pendingActionFocus]);

    const queueSelectionRestore = useCallback((offset: number, skipFocus: boolean) => {
        pendingSelectionRestoreRef.current = { offset, skipFocus };
        setSelectionRestoreTick((tick) => tick + 1);
    }, []);

    const restoreSourceMenuSelection = useCallback(() => {
        const pendingRestore = sourceMenuSelectionRestoreRef.current;
        if (!pendingRestore) return;
        editorHandleRef.current?.selectRange(
            pendingRestore.offset,
            pendingRestore.offset,
            { skipFocus: pendingRestore.skipFocus },
        );
    }, []);

    useEffect(() => {
        if (!isAddAttachmentMenuOpen) {
            sourceMenuSelectionRestoreRef.current = null;
        }
    }, [isAddAttachmentMenuOpen]);

    useEffect(() => {
        const pendingRestore = pendingSelectionRestoreRef.current;
        if (!pendingRestore) return;
        pendingSelectionRestoreRef.current = null;
        const win = inputRef.current?.ownerDocument.defaultView;
        const timer = win?.setTimeout(() => {
            editorHandleRef.current?.selectRange(
                pendingRestore.offset,
                pendingRestore.offset,
                { skipFocus: pendingRestore.skipFocus },
            );
        }, 0);
        return () => {
            if (timer !== undefined) win?.clearTimeout(timer);
        };
    }, [inputRef, selectionRestoreTick]);

    const handleEditorChange = useCallback((value: string) => {
        if (handleSlashMenuChange(value)) {
            queueSelectionRestore(value.length, false);
            return;
        }

        const inputEl = inputRef.current;
        if (
            inputEl &&
            !isAddAttachmentMenuOpen &&
            handleSlashTrigger(value, inputEl.getBoundingClientRect())
        ) {
            queueSelectionRestore(value.length, false);
            return;
        }

        if (value.endsWith('@') && !isAwaitingApproval && !hideAttachmentMenu) {
            const nextValue = value.slice(0, -1);
            if (inputEl) {
                const rect = inputEl.getBoundingClientRect();
                const y = verticalPosition === 'above' ? rect.top - 5 : rect.bottom - 10;
                setMenuPosition({
                    x: rect.left,
                    y,
                });
            }
            setIsAddAttachmentMenuOpen(true);
            setMessageContent(nextValue);
            // Delete just the trailing `@` in place rather than rebuilding the
            // editor from the string, so any colored /command nodes survive.
            editorHandleRef.current?.deleteTrailingCharacter();
            sourceMenuSelectionRestoreRef.current = { offset: nextValue.length, skipFocus: true };
            return;
        }

        setMessageContent(value);
    }, [
        handleSlashMenuChange,
        handleSlashTrigger,
        hideAttachmentMenu,
        inputRef,
        isAddAttachmentMenuOpen,
        isAwaitingApproval,
        queueSelectionRestore,
        setMessageContent,
        verticalPosition,
    ]);

    /** Tab selects the next `[[name]]` after the cursor, or falls through. */
    const handleVariableTab = useCallback((e: React.KeyboardEvent<HTMLElement>): boolean => {
        if (e.key !== 'Tab' || e.shiftKey) return false;
        const cursor = editorHandleRef.current?.getSelectionOffset();
        const next = findNextUserInputVariable(messageContent, cursor ?? 0);
        if (!next) return false;
        e.preventDefault();
        editorHandleRef.current?.selectRange(next.start, next.end);
        return true;
    }, [messageContent]);

    const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (handleSlashMenuKeyDown(e)) return;
        if (handleVariableTab(e)) return;
        if ((e.key === 'n' || e.key === 'N') && ((Zotero.isMac && e.metaKey) || (!Zotero.isMac && e.ctrlKey))) {
            e.preventDefault();
            newThread();
        }
    }, [handleSlashMenuKeyDown, handleVariableTab, newThread]);

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
        // If the message contains /command pills, resolve each back to its
        // action's prompt (and attach its items/collection) before sending.
        const pills = editorHandleRef.current?.getSlashCommands() ?? [];
        if (pills.length > 0) {
            logger(`Sending composed message with ${pills.length} action pill(s)`);
            sendComposedMessage({ baseText: message, pills });
            return;
        }
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
        const target = e.target as Element;
        const isButtonClick = target.closest('button') !== null;
        const isEditorClick = target.closest('.beaver-lexical-content') !== null;

        // Only focus if not clicking a button and editing is enabled
        if (!isButtonClick && !isEditorClick) {
            focusEditor();
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

    const handleWebSearchToggle = () => {
        if (isAwaitingApproval || !isWebSearchAllowed) return;
        setIsWebSearchEnabled(!isWebSearchEnabled);
    };

    const getPlaceholderText = () => {
        if (placeholder !== undefined) return placeholder;
        if (isAwaitingApproval) return "Add instructions to reject";
        if (showSoftCapWarningBar) return "Yes to continue, or add instructions to adjust";
        if (isLibraryTab) return "@ to add a source, / for actions";
        if (currentNoteItem) return "@ to add a source, / for actions";
        return "@ to add a source, / for actions, drag to add annotations";
    }

    const webSearchTooltipContent = isWebSearchAllowed
        ? (isWebSearchEnabled ? 'Stop requesting web search' : 'Request web search')
        : 'Web search requires Beaver credits';
    const webSearchDescription = isWebSearchAllowed
        ? (isWebSearchEnabled ? 'Web search is enabled.' : 'Web search is disabled.')
        : 'Web search is unavailable. It requires Beaver credits. Use a Beaver model, or enable Plus Tools in Settings, API Keys.';
    const menuPortalContainer = inputRef.current?.closest('[id^="beaver-react-root-"], #beaver-pane-window') as HTMLElement | null;

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
                    inputRef={inputRef}
                    focusInput={focusEditor}
                    menuPortalContainer={menuPortalContainer}
                    onAfterMenuInitialFocus={restoreSourceMenuSelection}
                    disabled={isAwaitingApproval}
                    verticalPosition={verticalPosition}
                />
            )}

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
                portalContainer={menuPortalContainer}
            />

            {/* Input Form */}
            <form onSubmit={handleSubmit} className="display-flex flex-col">
                {/* Message Input - Lexical-backed rich input with inline pills */}
                <div className="mb-2 -ml-1">
                    <LexicalEditorInput
                        ref={editorHandleRef}
                        value={messageContent}
                        onChange={handleEditorChange}
                        onSubmit={handleEditorSubmit}
                        placeholder={getPlaceholderText()}
                        ariaLabel="Message Beaver"
                        disabled={isAwaitingApproval}
                        onKeyDown={handleEditorKeyDown}
                        suspendKeyboardNavigation={isSlashMenuOpen || isAddAttachmentMenuOpen}
                        onContentEditableRef={(el) => {
                            // Forward the Lexical content-editable element to the
                            // parent's inputRef so legacy `.focus()` callers work.
                            (inputRef as React.MutableRefObject<HTMLElement | null>).current = el;
                        }}
                    />
                </div>

                {/* Button Row */}
                <div className="display-flex flex-row items-center pt-2">
                    {!hideModelSelector && (
                        <ModelSelectionButton inputRef={inputRef} focusInput={focusEditor} disabled={isAwaitingApproval} />
                    )}
                    <div className="flex-1" />
                    <div className="display-flex flex-row items-center gap-4">
                        <span id={webSearchDescriptionId} className="sr-only">
                            {webSearchDescription}
                        </span>
                        <Tooltip
                            key={String(isWebSearchAllowed)}
                            content={webSearchTooltipContent}
                            padding={false}
                            width={!isWebSearchAllowed ? '250px' : isWebSearchEnabled ? '220px' : '190px'}
                            customContent={
                                !isWebSearchAllowed ? (
                                    <div className="px-2 py-1 display-flex flex-col gap-1">
                                        <span className="text-base font-color-secondary font-medium">Web search requires Beaver credits</span>
                                        <span className="text-sm font-color-tertiary">Use a Beaver model, or enable Plus Tools in Settings → API Keys</span>
                                    </div>
                                ) : isWebSearchEnabled ? (
                                    <div className="px-2 py-1 display-flex flex-col gap-1">
                                        <span className="text-base font-color-secondary font-medium">Stop requesting web search</span>
                                        <span className="text-sm font-color-tertiary">May still search the web when helpful</span>
                                    </div>
                                ) : (
                                    <div className="px-2 py-1 display-flex flex-col gap-1">
                                        <span className="text-base font-color-secondary font-medium">Request web search</span>
                                        <span className="text-sm font-color-tertiary">May search the web either way</span>
                                    </div>
                                )
                            }
                        >
                            <IconButton
                                icon={GlobalSearchIcon}
                                variant="ghost-secondary"
                                className="scale-12 mt-015"
                                iconClassName={isWebSearchEnabled ? 'font-color-accent-blue stroke-width-2' : ''}
                                ariaLabel="Web search"
                                ariaPressed={isWebSearchEnabled}
                                ariaDescribedBy={webSearchDescriptionId}
                                onClick={handleWebSearchToggle}
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
