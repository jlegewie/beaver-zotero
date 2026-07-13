import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { StopIcon, GlobalSearchIcon } from '../icons/icons';
import { useAtom, useSetAtom, useAtomValue, useStore } from 'jotai';
import { newThreadAtom, currentThreadIdAtom } from '../../atoms/threads';
import { currentMessageContentAtom, currentMessagePillsAtom, pendingPillInsertAtom } from '../../atoms/messageComposition';
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
import BackToSuggestions, { FirstRunBackTarget } from '../pages/firstRun/BackToSuggestions';
import { allRunsAtom } from '../../agents/atoms';
import { PromptOrigin } from '../../agents/types';
import { firstRunNextStepsDismissedAtom } from '../../atoms/firstRun';
import { dismissHighTokenWarningForThreadAtom, dismissedHighTokenWarningByThreadAtom, dismissSoftCapWarningForThreadAtom, dismissedSoftCapWarningByThreadAtom, backendHighTokenUsageRunsAtom, softCapTriggeredRunsAtom } from '../../atoms/messageUIState';
import { getLastRequestInputTokens } from '../../utils/runUsage';
import { getPref, setPref } from '../../../src/utils/prefs';
import { LexicalEditorInput, LexicalEditorInputHandle, SlashCommandDescriptor } from './lexical/LexicalEditorInput';
import { useSlashMenu } from '../../hooks/useSlashMenu';
import { sendComposedMessageAtom } from '../../atoms/actions';
import { pendingComposerFocusTransferAtom } from '../../atoms/composerFocus';
import {
    getComposerWindowToken,
    registerComposerSelectionProvider,
} from '../../utils/composerSelection';

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
    const [messagePills, setMessagePills] = useAtom(currentMessagePillsAtom);
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
    const pendingPillInsert = useAtomValue(pendingPillInsertAtom);
    const pendingFocusTransfer = useAtomValue(pendingComposerFocusTransferAtom);
    const store = useStore();
    const webSearchDescriptionId = useId();

    // Imperative handle exposed by the Lexical editor (focus / clear).
    const editorHandleRef = useRef<LexicalEditorInputHandle | null>(null);
    const pendingSelectionRestoreRef = useRef<{ offset: number; skipFocus: boolean } | null>(null);
    const sourceMenuSelectionRestoreRef = useRef<{ offset: number } | null>(null);
    const unregisterSelectionProviderRef = useRef<(() => void) | null>(null);
    const focusEditor = useCallback(() => {
        editorHandleRef.current?.focus();
    }, []);
    // Stable forwarder so the slash menu can insert a command pill into the
    // Lexical editor (the editor handle isn't available until after mount).
    const insertSlashCommand = useCallback((descriptor: SlashCommandDescriptor, queryLength: number) => {
        editorHandleRef.current?.insertSlashCommand(descriptor, queryLength);
    }, []);
    const handleContentEditableRef = useCallback((el: HTMLElement | null) => {
        unregisterSelectionProviderRef.current?.();
        unregisterSelectionProviderRef.current = null;
        (inputRef as React.MutableRefObject<HTMLElement | null>).current = el;
        if (el) {
            unregisterSelectionProviderRef.current = registerComposerSelectionProvider(
                el,
                () => editorHandleRef.current?.getSelection() ?? null,
            );
        }
    }, [inputRef]);

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
    // Guided next steps surface after a suggestion-card run or a "Where should
    // we start?" launcher run — both carry the context NextStepsPanel needs.
    const lastRunOriginKind = lastRun?.user_prompt.origin?.kind;
    const showNextSteps = Boolean(
        !isAwaitingApproval &&
        lastRun &&
        (lastRunOriginKind === 'first_run_card' || lastRunOriginKind === 'where_to_start') &&
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
    // The follow-up run's origin
    const firstRunBackTarget: FirstRunBackTarget = allRuns.some(
        (r) => r.user_prompt?.origin?.kind === 'where_to_start',
    ) ? 'launcher' : 'suggestions';

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
        const inputEl = inputRef.current;
        const ownWindow = inputEl?.ownerDocument.defaultView;
        const ownSurface = inputEl?.closest('#beaver-react-root-library')
            ? 'library'
            : inputEl?.closest('#beaver-react-root-reader')
                ? 'reader'
                : null;
        if (
            pendingFocusTransfer
            && ownWindow
            && getComposerWindowToken(ownWindow) === pendingFocusTransfer.targetWindowToken
            && ownSurface === pendingFocusTransfer.targetSurface
        ) {
            // The transfer effect below owns focus timing. In particular, a
            // loading reader must finish before either mount autofocus or the
            // transfer can focus the composer.
            return;
        }
        // Focus on mount via the Lexical handle.
        focusEditor();
    }, []);

    // Zotero replaces the library composer with a separately mounted reader
    // composer, and also schedules its own content refocus after announcing a
    // tab change. Consume the host's one-shot handoff after that refocus so
    // the composer deterministically keeps both focus and its Lexical
    // selection. Other mounted composers (notably the separate Beaver window)
    // ignore transfers that do not target their window and surface.
    useEffect(() => {
        if (!pendingFocusTransfer) return;
        const inputEl = inputRef.current;
        const ownWindow = inputEl?.ownerDocument.defaultView ?? null;
        const ownSurface = inputEl?.closest('#beaver-react-root-library')
            ? 'library'
            : inputEl?.closest('#beaver-react-root-reader')
                ? 'reader'
                : null;
        if (
            !ownWindow
            || getComposerWindowToken(ownWindow) !== pendingFocusTransfer.targetWindowToken
            || ownSurface !== pendingFocusTransfer.targetSurface
        ) {
            return;
        }
        if (pendingFocusTransfer.deferred) return;

        const timer = ownWindow.setTimeout(() => {
            if (store.get(pendingComposerFocusTransferAtom) !== pendingFocusTransfer) {
                return;
            }
            store.set(pendingComposerFocusTransferAtom, null);
            if (isAwaitingApproval) return;
            if (isPending && getPref('focusResponseForScreenReaders')) return;
            editorHandleRef.current?.setSelection(
                pendingFocusTransfer.selection,
                { skipFocus: true },
            );
            focusEditor();
        }, pendingFocusTransfer.restoreDelayMs);
        return () => ownWindow.clearTimeout(timer);
    }, [focusEditor, inputRef, isAwaitingApproval, isPending, pendingFocusTransfer, store]);

    // Consume a staged /command pill (home launcher, context menu, reader
    // toolbar). This component owns the editor handle, so the pill is inserted
    // here; running on mount as well covers the sidebar-just-opened case.
    // The user submits the message themselves (no auto-send).
    //
    // Multiple InputAreas can be mounted at once (main-window sidebar + the
    // separate Beaver window), all subscribed to the same atom. Consumption is
    // therefore a CLAIM: the editor in the payload's `targetWindow` (where the
    // user triggered the action) claims immediately; other editors act only as
    // a delayed fallback in case the target never consumes (e.g. its editor is
    // not mounted). The synchronous re-check + clear of the live atom value
    // guarantees exactly one editor inserts the pill.
    useEffect(() => {
        if (!pendingPillInsert) return;
        const claim = () => {
            // Another editor may have claimed this pill already.
            if (store.get(pendingPillInsertAtom) !== pendingPillInsert) return;
            store.set(pendingPillInsertAtom, null);
            editorHandleRef.current?.insertSlashCommand(pendingPillInsert.descriptor, null);
            focusEditor();
        };
        const ownWindow = inputRef.current?.ownerDocument.defaultView ?? null;
        const isTarget = pendingPillInsert.targetWindow
            ? pendingPillInsert.targetWindow === ownWindow
            : (inputRef.current?.ownerDocument.hasFocus() ?? false);
        const timer = setTimeout(claim, isTarget ? 0 : 150);
        return () => clearTimeout(timer);
    }, [focusEditor, inputRef, pendingPillInsert, store]);

    const queueSelectionRestore = useCallback((offset: number, skipFocus: boolean) => {
        pendingSelectionRestoreRef.current = { offset, skipFocus };
        setSelectionRestoreTick((tick) => tick + 1);
    }, []);

    // Runs when the attachment menu closes (its search input owned DOM focus
    // while open). Refocuses the editor and puts the caret back where the `@`
    // trigger was typed. Restoring while the menu is still open would fight
    // its search input: even a skip-focus selection update moves the native
    // DOM selection into the contenteditable, which Zotero's chrome focus
    // manager treats as focus movement, yanking focus out of the menu.
    const restoreSourceMenuSelection = useCallback(() => {
        const pendingRestore = sourceMenuSelectionRestoreRef.current;
        if (pendingRestore) {
            editorHandleRef.current?.selectRange(pendingRestore.offset, pendingRestore.offset);
            return;
        }
        // Menu was opened without an `@` trigger (e.g. the "+" button).
        focusEditor();
    }, [focusEditor]);

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
            sourceMenuSelectionRestoreRef.current = { offset: nextValue.length };
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

    const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (handleSlashMenuKeyDown(e)) return;
        if ((e.key === 'n' || e.key === 'N') && ((Zotero.isMac && e.metaKey) || (!Zotero.isMac && e.ctrlKey))) {
            e.preventDefault();
            newThread();
        }
    }, [handleSlashMenuKeyDown, newThread]);

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
                    origin={lastRun.user_prompt.origin as Extract<PromptOrigin, { kind: 'first_run_card' | 'where_to_start' }>}
                    onDismiss={handleDismissNextSteps}
                />
            )}

            {/* After a first-run follow-up run, offer a path back to the
                originating surface (suggestion grid or launcher). */}
            {showBackToSuggestions && (
                <div className="next-steps-panel px-3 py-2">
                    <BackToSuggestions onDismiss={handleDismissNextSteps} backTarget={firstRunBackTarget} />
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
                    focusInput={restoreSourceMenuSelection}
                    menuPortalContainer={menuPortalContainer}
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
                selectOnTab={true}
                portalContainer={menuPortalContainer}
                groupHeaderClassName="font-color-primary opacity-70"
            />

            {/* Input Form */}
            <form onSubmit={handleSubmit} className="display-flex flex-col">
                {/* Message Input - Lexical-backed rich input with inline pills */}
                <div className="mb-2 -ml-1">
                    <LexicalEditorInput
                        ref={editorHandleRef}
                        value={messageContent}
                        onChange={handleEditorChange}
                        pills={messagePills}
                        onPillsChange={setMessagePills}
                        onSubmit={handleEditorSubmit}
                        placeholder={getPlaceholderText()}
                        ariaLabel="Message Beaver"
                        disabled={isAwaitingApproval}
                        onKeyDown={handleEditorKeyDown}
                        suspendKeyboardNavigation={isSlashMenuOpen || isAddAttachmentMenuOpen}
                        onContentEditableRef={handleContentEditableRef}
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
