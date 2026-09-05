import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { StopIcon, GlobalSearchIcon, ArrowUpLineIcon } from '../icons/icons';
import { useAtom, useSetAtom, useAtomValue, useStore } from 'jotai';
import { newThreadAtom, currentThreadIdAtom } from '../../atoms/threads';
import { currentMessageContentAtom, currentMessagePillsAtom, pendingPillInsertsAtom, composerResetTokenAtom, pendingAttachmentTokensAtom, clearComposerAtom } from '../../atoms/messageComposition';
import { sendWSMessageAtom, isWSChatPendingAtom, closeWSConnectionAtom, answerPendingApprovalsAtom, setRunPermissionModeAtom, approvalVerdictInFlightAtom, beginApprovalVerdictAtom, releaseApprovalVerdictAtom } from '../../atoms/agentRunAtoms';
import { pendingApprovalsAtom, agentActionsByRunAtom } from '../../agents/agentActions';
import { isCoveredByFullAccess, runApprovalPolicyAtom } from '../../atoms/runApprovalPolicy';
import RunPermissionButton, { RunPermissionMode } from '../ui/buttons/RunPermissionButton';
import Button from '@beaver/agent-ui/primitives/Button';
import SearchMenu from '@beaver/agent-ui/primitives/SearchMenu';
import ModelSelectionButton from '../ui/buttons/ModelSelectionButton';
import MessageAttachmentDisplay from '../messages/MessageAttachmentDisplay';
import AddSourcesMenu from '../ui/menus/AddSourcesMenu';
import { logger } from '@beaver/agent-core/platform/logger';
import { isLibraryTabAtom, isWebSearchAllowedAtom, isWebSearchEnabledAtom } from '../../atoms/ui';
import { currentNoteItemAtom } from '../../atoms/zoteroContext';
import { selectedModelAtom, isUsingBeaverCreditsAtom } from '../../atoms/models';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import PendingActionsBar from './PendingActionsBar';
import BatchProgressPanel from './BatchProgressPanel';
import HighTokenUsageWarningBar from './HighTokenUsageWarningBar';
import NextStepsPanel from '../pages/firstRun/NextStepsPanel';
import BackToSuggestions, { FirstRunBackTarget } from '../pages/firstRun/BackToSuggestions';
import { hasWhereToStartRunAtom, lastRunSummaryAtom, threadRunIdsAtom } from '@beaver/agent-core/run-state/atoms';
import { PromptOrigin } from '@beaver/agent-core/agents/types';
import { firstRunNextStepsDismissedAtom } from '../../atoms/firstRun';
import { dismissHighTokenWarningForThreadAtom, dismissedHighTokenWarningByThreadAtom, backendHighTokenUsageRunsAtom } from '../../atoms/messageUIState';
import { getLastRequestInputTokens } from '../../utils/runUsage';
import { getPref } from '../../../src/utils/prefs';
import { LexicalEditorInput, LexicalEditorInputHandle, SlashCommandDescriptor } from '@beaver/agent-ui/composer/LexicalEditorInput';
import { isImeKeyEvent } from '@beaver/agent-ui/primitives/ime';
import { useSlashMenu } from '../../hooks/useSlashMenu';
import { useAddSourcesMenu, AddSourcesMenuHandle } from '@beaver/agent-ui/composer/useAddSourcesMenu';
import { useComposerPasteHandlers } from '../../hooks/useComposerPasteHandlers';
import { useActionPopupResolver } from '../../hooks/useActionPopupResolver';
import { sendComposedMessageAtom } from '../../atoms/actions';
import { dismissActiveEditNotePreview } from '../../host/zotero/editNotePreviewLifecycle';

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
    const [selectionRestoreTick, setSelectionRestoreTick] = useState(0);
    const isLibraryTab = useAtomValue(isLibraryTabAtom);
    const [isWebSearchEnabled, setIsWebSearchEnabled] = useAtom(isWebSearchEnabledAtom);
    // Projections of the thread's runs rather than the runs themselves: the
    // composer renders from the newest run's identity and outcome, not its
    // contents, and subscribing to the runs re-renders it on every streamed
    // frame of the response it sits under.
    const lastRun = useAtomValue(lastRunSummaryAtom);
    const runIds = useAtomValue(threadRunIdsAtom);
    const hasWhereToStartRun = useAtomValue(hasWhereToStartRunAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const dismissedHighTokenByThread = useAtomValue(dismissedHighTokenWarningByThreadAtom);
    const dismissHighTokenWarning = useSetAtom(dismissHighTokenWarningForThreadAtom);
    const backendHighTokenUsageRuns = useAtomValue(backendHighTokenUsageRunsAtom);
    const isWebSearchAllowed = useAtomValue(isWebSearchAllowedAtom);
    const currentNoteItem = useAtomValue(currentNoteItemAtom);
    // Only the oldest staged pill is claimable; the rest follow as it is
    // dequeued (see the claim effect below).
    const pendingPillInsert = useAtomValue(pendingPillInsertsAtom)[0] ?? null;
    const composerResetToken = useAtomValue(composerResetTokenAtom);
    const store = useStore();
    const webSearchDescriptionId = useId();

    // Turns a paste carrying files or image bytes into message attachments.
    const pasteHandlers = useComposerPasteHandlers();

    // Supplies the /command pill hover cards with the live action definitions.
    const resolveAction = useActionPopupResolver();

    // Imperative handle exposed by the Lexical editor (focus / clear).
    const editorHandleRef = useRef<LexicalEditorInputHandle | null>(null);
    const pendingSelectionRestoreRef = useRef<{ offset: number; skipFocus: boolean } | null>(null);
    const focusEditor = useCallback(() => {
        editorHandleRef.current?.focus();
    }, []);
    // The open Add Sources menu, for stepping back out of one of its submenus.
    const addSourcesMenuRef = useRef<AddSourcesMenuHandle | null>(null);
    const deleteTrailingQuery = useCallback((length: number) => {
        editorHandleRef.current?.deleteTrailingQuery(length);
    }, []);
    // Stable forwarder so the slash menu can insert a command pill into the
    // Lexical editor (the editor handle isn't available until after mount).
    const insertSlashCommand = useCallback((descriptor: SlashCommandDescriptor, queryLength: number | null) => {
        editorHandleRef.current?.insertSlashCommand(descriptor, queryLength);
    }, []);

    // A programmatic composer reset (new thread, thread switch, send) can write
    // the same empty value the editor already published, which its value sync
    // cannot see. Tell the editor explicitly, so text it is withholding for an
    // IME composition is dropped instead of resurfacing in the new context.
    useEffect(() => {
        editorHandleRef.current?.discardPendingText();
    }, [composerResetToken]);

    // WebSocket state
    const sendWSMessage = useSetAtom(sendWSMessageAtom);
    const sendComposedMessage = useSetAtom(sendComposedMessageAtom);
    const closeWSConnection = useSetAtom(closeWSConnectionAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);

    // A file staged for THIS composition is still being attached, so sending is
    // held until it lands. Work left over from a composition the user has since
    // replaced does not hold. Excludes the pending case, where the button is
    // "Stop" and must stay live.
    const pendingAttachmentTokens = useAtomValue(pendingAttachmentTokensAtom);
    const isAttachingFiles = pendingAttachmentTokens.includes(composerResetToken) && !isPending;

    // Pending approval state (for deferred tools)
    // With parallel tool calls, there can be multiple pending approvals
    const pendingApprovalsMap = useAtomValue(pendingApprovalsAtom);
    const answerPendingApprovals = useSetAtom(answerPendingApprovalsAtom);
    const clearComposer = useSetAtom(clearComposerAtom);
    const isAwaitingApproval = pendingApprovalsMap.size > 0;
    // The run holding a full-access grant, if one does. The policy is cleared at
    // every run boundary, so holding it means the grant is live right now — and
    // once it is, no further card is raised, so this bar is the only place left
    // that says so and the only way back to being asked.
    const runApprovalPolicy = useAtomValue(runApprovalPolicyAtom);
    const setRunPermissionMode = useSetAtom(setRunPermissionModeAtom);
    const fullAccessRunId = runApprovalPolicy.fullAccess ? runApprovalPolicy.runId : null;
    // A running tally for the band: with no cards raised, this count is the
    // only live sign of what the grant is doing until the changes card renders
    // at the end of the run. It counts every applied library change in the
    // run, the ones approved by hand before the switch included — "in this
    // response" is what the user is supervising, not the grant's bookkeeping.
    // Only changes the grant covers count, though: a confirmed extraction or
    // external search is recorded as an action too, and the band is making a
    // claim about library changes.
    //
    // Subscribed to the run map itself, not the getter atom: the getter's
    // closure reads the map only when called, after its own read has finished,
    // so Jotai would never see the map as a dependency and the count would sit
    // stale until something else re-rendered this component.
    const actionsByRun = useAtomValue(agentActionsByRunAtom);
    const fullAccessAppliedCount = useMemo(() => (
        fullAccessRunId
            ? (actionsByRun.get(fullAccessRunId) ?? []).filter((action) =>
                action.status === 'applied'
                && isCoveredByFullAccess(action.action_type, action.proposed_data)).length
            : 0
    ), [actionsByRun, fullAccessRunId]);
    // The verdict buttons stand in for Send whenever the composer holds text
    // and a decision is pending, whenever that text was typed; an approval
    // pending against an empty composer leaves Stop in place and the bar above
    // owns the decision. No rule can tell a follow-up written while the run
    // streamed from an instruction written for the cards — every one of them
    // is a diff between two arbitrary edits — and a rule that tried would
    // leave text sitting in the field that silently does not count.
    //
    // Both verdicts are offered, and neither is the default: a typed message is
    // the user telling Beaver what to do, and reading it as a decision on its
    // own inverts "you can apply all" into a rejection of exactly the changes
    // they were approving.
    const showVerdictButtons = isAwaitingApproval && messageContent.trim().length > 0;
    // Held from the click until the decision is delivered, so a second click
    // cannot overtake the first while a note preview is being torn down.
    const isVerdictInFlight = useAtomValue(approvalVerdictInFlightAtom);
    const beginApprovalVerdict = useSetAtom(beginApprovalVerdictAtom);
    const releaseApprovalVerdict = useSetAtom(releaseApprovalVerdictAtom);
    // Note: while an ask_user_question request is pending (and no approval is),
    // Sidebar renders AskUserQuestionPanel INSTEAD of this component, so no
    // question-mode handling is needed here.

    const lastRunUsage = lastRun?.totalUsage;
    const lastRequestInputTokens = lastRunUsage ? getLastRequestInputTokens(lastRunUsage) : null;
    const warningThreadId = lastRun?.threadId ?? currentThreadId;
    const isHighTokenDismissed = warningThreadId ? dismissedHighTokenByThread[warningThreadId] : false;
    const showHighTokenUsageWarningMessage = getPref('showHighTokenUsageWarningMessage');
    const threadHasHighTokenUsage = runIds.some(runId => backendHighTokenUsageRuns[runId])
        || (lastRequestInputTokens !== null && lastRequestInputTokens > HIGH_INPUT_TOKEN_WARNING_THRESHOLD);
    const canShowHighTokenWarning = Boolean(
        showHighTokenUsageWarningMessage &&
        warningThreadId &&
        threadHasHighTokenUsage &&
        !isHighTokenDismissed &&
        lastRequestInputTokens !== null
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
    const lastRunOriginKind = lastRun?.origin?.kind;
    const canShowNextSteps = Boolean(
        lastRun &&
        (lastRunOriginKind === 'first_run_card' || lastRunOriginKind === 'where_to_start') &&
        lastRun.status === 'completed' &&
        !nextStepsDismissedRunIds.has(lastRun.id)
    );
    const canShowBackToSuggestions = Boolean(
        lastRun &&
        lastRunOriginKind === 'first_run_followup' &&
        lastRun.status === 'completed' &&
        !nextStepsDismissedRunIds.has(lastRun.id)
    );
    // The follow-up run's origin
    const firstRunBackTarget: FirstRunBackTarget = hasWhereToStartRun ? 'launcher' : 'suggestions';

    // Counted labels, so the destructive verdict states its blast radius where
    // the decision is actually taken rather than only in the bar above.
    const verdictCountSuffix = pendingApprovalsMap.size > 1 ? ` all (${pendingApprovalsMap.size})` : '';
    const approveVerdictLabel = `Approve${verdictCountSuffix}`;
    const rejectVerdictLabel = `Reject${verdictCountSuffix}`;

    // Exactly one band between the batch panel and the attachment row.
    // Priority: blocked decision, then the standing grant that stops decisions
    // being asked for at all, then first-run guidance, then the cost warning.
    // One ordered list (not a suppression clause in each predicate) so a new
    // band takes a place here instead of stacking. Laid out lowest-priority
    // first so the winner sits nearest the composer.
    const composerBand: 'high-token' | 'next-steps' | 'back-to-suggestions' | 'approvals' | 'full-access' | null =
        isAwaitingApproval
            ? 'approvals'
            : fullAccessRunId
                ? 'full-access'
                : canShowNextSteps
                    ? 'next-steps'
                    : canShowBackToSuggestions
                        ? 'back-to-suggestions'
                        : canShowHighTokenWarning
                            ? 'high-token'
                            : null;

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

    // A `@` typed in the editor drives the Add Sources menu the same way: the
    // caret never leaves the editor and the text after the `@` is the menu's
    // search query. Opened from the "+" button, the menu brings its own
    // focused search field instead and the composer is left alone.
    const {
        isOpen: isAddSourcesMenuOpen,
        position: addSourcesMenuPosition,
        query: addSourcesSearchQuery,
        querySource: addSourcesQuerySource,
        setQuery: setAddSourcesSearchQuery,
        openFromButton: openAddSourcesMenu,
        handleTrigger: handleAddSourcesTrigger,
        handleChange: handleAddSourcesChange,
        handleKeyDown: handleAddSourcesKeyDown,
        dismiss: dismissAddSourcesMenu,
        commit: commitAddSourcesMenu,
        resetQuery: resetAddSourcesQuery,
    } = useAddSourcesMenu({
        verticalPosition,
        deleteTrailingQuery,
        focusEditor,
        setMessageContent,
        menuRef: addSourcesMenuRef,
    });

    useEffect(() => {
        if (isPending && getPref('focusResponseForScreenReaders')) {
            return;
        }
        // Focus on mount via the Lexical handle.
        focusEditor();
    }, []);

    // Approval hides the attachment row (and the Add Sources menu). Close the
    // menu so it does not unmount still open — that flag swallows Enter.
    useEffect(() => {
        if (isAwaitingApproval && isAddSourcesMenuOpen) {
            dismissAddSourcesMenu();
        }
    }, [dismissAddSourcesMenu, isAddSourcesMenuOpen, isAwaitingApproval]);

    // Same for the slash menu, which cards arriving mid-stream can leave open.
    // Picking an entry from it would insert a /command pill the decision path
    // cannot resolve, and while it is open it also suspends the editor's
    // keyboard navigation — over the very field the instructions go in.
    useEffect(() => {
        if (isAwaitingApproval && isSlashMenuOpen) {
            handleSlashDismiss();
        }
    }, [handleSlashDismiss, isSlashMenuOpen, isAwaitingApproval]);

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
    // not mounted). The synchronous re-check + dequeue of the live atom value
    // guarantees exactly one editor inserts the pill.
    //
    // Only the head of the queue is claimed; dequeuing it re-runs this effect
    // for the next entry, so pills staged in quick succession are all inserted,
    // in the order they were staged.
    useEffect(() => {
        const descriptor = pendingPillInsert?.descriptor;
        if (!descriptor) return;
        const claim = () => {
            const queue = store.get(pendingPillInsertsAtom);
            // Another editor may have claimed this pill already.
            if (queue[0] !== pendingPillInsert) return;
            store.set(pendingPillInsertsAtom, queue.slice(1));
            editorHandleRef.current?.insertSlashCommand(descriptor, null);
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
        // The open Add Sources menu owns every keystroke until it closes, so a
        // `/` typed into its query is a search term, not an actions trigger.
        if (handleAddSourcesChange(value)) {
            queueSelectionRestore(value.length, false);
            return;
        }

        if (handleSlashMenuChange(value)) {
            queueSelectionRestore(value.length, false);
            return;
        }

        const inputEl = inputRef.current;
        // No action pills while a decision is pending: this text is sent as the
        // instructions for that decision, and a pill's prompt and attachments
        // are resolved only on the send path.
        if (inputEl && !isAwaitingApproval && handleSlashTrigger(value, inputEl.getBoundingClientRect())) {
            queueSelectionRestore(value.length, false);
            return;
        }

        if (
            inputEl &&
            !isAwaitingApproval &&
            !hideAttachmentMenu &&
            handleAddSourcesTrigger(value, inputEl)
        ) {
            queueSelectionRestore(value.length, false);
            return;
        }

        setMessageContent(value);
    }, [
        handleAddSourcesChange,
        handleAddSourcesTrigger,
        handleSlashMenuChange,
        handleSlashTrigger,
        hideAttachmentMenu,
        inputRef,
        isAwaitingApproval,
        queueSelectionRestore,
        setMessageContent,
    ]);

    const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        // Keys owned by an active IME composition must not drive menus or
        // shortcuts (and must not be preventDefault'ed away from the IME).
        if (isImeKeyEvent(e.nativeEvent)) return;
        if (handleAddSourcesKeyDown(e)) return;
        if (handleSlashMenuKeyDown(e)) return;
        if ((e.key === 'n' || e.key === 'N') && ((Zotero.isMac && e.metaKey) || (!Zotero.isMac && e.ctrlKey))) {
            e.preventDefault();
            newThread();
        }
    }, [handleAddSourcesKeyDown, handleSlashMenuKeyDown, newThread]);

    const handleSubmit = async (
        e: React.FormEvent<HTMLFormElement> | React.MouseEvent
    ) => {
        e.preventDefault();
        // Guard against double submission
        if (isPending) {
            logger('handleSubmit: Blocked - request already in progress');
            return;
        }
        if (isAttachingFiles) return;
        sendMessage(messageContent);
    };

    const sendMessage = (composedMessage: string) => {
        // Text typed with an input method reaches `messageContent` one
        // composition at a time, and the last one lands shortly after the user
        // commits it. Publish anything still withheld so a send that follows
        // the commit immediately carries the committed text instead of the
        // state before it (see flushPendingText).
        const message = editorHandleRef.current?.flushPendingText() ?? composedMessage;
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

    /**
     * Answer every pending approval.
     *
     * The composer's verdict buttons and the docked bar both send what is in
     * the field as user instructions and empty it, the way sending does. The
     * cards' own Apply/Reject is a decision on the changes alone, so it
     * carries no message and leaves the field untouched.
     */
    const handleApprovalVerdict = (approved: boolean, withInstructions: boolean) => {
        if (pendingApprovalsMap.size === 0) return;
        // Claimed before the wait below, and synchronously, so the first of two
        // quick clicks is the one that decides.
        if (!beginApprovalVerdict()) return;
        // As in sendMessage: pick up a composition the user has just committed.
        const content = editorHandleRef.current?.flushPendingText() ?? messageContent;
        const instructions = withInstructions && content.trim().length > 0 ? content : null;
        // The cards the user was actually answering, taken now. Tearing down a
        // note preview below can take over a second, and a parallel approval
        // arriving in that window was neither counted on the button they
        // pressed nor on screen for them to read.
        const actionIds = [...pendingApprovalsMap.keys()];
        logger(`${approved ? 'Approving' : 'Rejecting'} ${actionIds.length} pending approval(s)${instructions ? ' with instructions' : ''}`);
        void (async () => {
            try {
                // Runs in this tick — the body before the first await does.
                if (instructions) clearComposer();
                await dismissActiveEditNotePreview();
                answerPendingApprovals({ actionIds, approved, userInstructions: instructions });
            } finally {
                releaseApprovalVerdict();
            }
        })();
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
        // Enter belongs to the open Add Sources menu (it picks the focused row).
        if (isAddSourcesMenuOpen) return;
        if (isAttachingFiles) return;
        sendMessage(messageContent);
    }, [isPending, isAwaitingApproval, isSlashMenuOpen, isAddSourcesMenuOpen, isAttachingFiles, messageContent]);

    const handleDismissHighTokenWarning = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!warningThreadId) return;
        dismissHighTokenWarning(warningThreadId);
    };

    const handleWebSearchToggle = () => {
        if (isAwaitingApproval || !isWebSearchAllowed) return;
        setIsWebSearchEnabled(!isWebSearchEnabled);
    };

    const getPlaceholderText = () => {
        if (placeholder !== undefined) return placeholder;
        if (isAwaitingApproval) return "Optional instructions, then approve or reject";
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
            {/* Live batch progress. Above the band so it stacks as: what the
                run is doing, then what it wants from the user. */}
            <BatchProgressPanel />

            {/* One band, chosen by `composerBand`. Lowest priority first so
                the winner sits on the composer. */}
            {composerBand === 'high-token' && (
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

            {/* First-run "Next steps" panel — shown after a run that originated
                from a first-run suggestion card. Auto-dismisses on type. */}
            {composerBand === 'next-steps' && lastRun && (
                <NextStepsPanel
                    origin={lastRun.origin as Extract<PromptOrigin, { kind: 'first_run_card' | 'where_to_start' }>}
                    onDismiss={handleDismissNextSteps}
                />
            )}

            {/* After a first-run follow-up run, offer a path back to the
                originating surface (suggestion grid or launcher). */}
            {composerBand === 'back-to-suggestions' && (
                <div className="composer-docked-bar next-steps-panel px-3 py-2">
                    <BackToSuggestions onDismiss={handleDismissNextSteps} backTarget={firstRunBackTarget} />
                </div>
            )}

            {/* The standing grant, while it is in force. Nothing else reports
                it: with full access no card is raised, so without this bar the
                user has no sign that library changes are applying unasked and
                no way to switch back. */}
            {composerBand === 'full-access' && fullAccessRunId && (
                <div className="composer-docked-bar pending-actions-bar display-flex flex-row items-center px-3 py-2 border-bottom-quinary gap-2">
                    <span className="font-color-secondary text-sm truncate">
                        Applying library changes without asking
                    </span>
                    {fullAccessAppliedCount > 0 && (
                        <span className="font-color-secondary opacity-70 text-sm flex-none">
                            {fullAccessAppliedCount === 1 ? '1 applied' : `${fullAccessAppliedCount} applied`}
                        </span>
                    )}
                    <div className="flex-1" />
                    <RunPermissionButton
                        mode="full_access"
                        onChange={(mode: RunPermissionMode) => setRunPermissionMode({
                            runId: fullAccessRunId,
                            fullAccess: mode === 'full_access',
                        })}
                    />
                </div>
            )}

            {/* Pending approvals. Last of the bands so it sits on the composer
                — the field is where the instructions for the decision go. */}
            {composerBand === 'approvals' && (
                <PendingActionsBar
                    onDecide={(approved) => handleApprovalVerdict(approved, true)}
                    disabled={isVerdictInFlight}
                />
            )}

            {/* Message attachments — absent entirely when nothing is attached.
                Hidden during approval: the message cannot be sent until the
                decision is made. */}
            {!hideAttachmentMenu && !isAwaitingApproval && <MessageAttachmentDisplay />}

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
                <div className="mb-2">
                    <LexicalEditorInput
                        ref={editorHandleRef}
                        value={messageContent}
                        onChange={handleEditorChange}
                        pills={messagePills}
                        onPillsChange={setMessagePills}
                        onSubmit={handleEditorSubmit}
                        pasteHandlers={pasteHandlers}
                        resolveAction={resolveAction}
                        // Nothing else tells the user that what they type after
                        // the `@` searches — that menu has no input of its own.
                        // Drops away the moment they start typing.
                        inlineHint={
                            isAddSourcesMenuOpen &&
                            addSourcesQuerySource === 'editor' &&
                            addSourcesSearchQuery.length === 0
                                ? 'Type to search'
                                : null
                        }
                        placeholder={getPlaceholderText()}
                        ariaLabel="Message Beaver"
                        // Never disabled while an approval is pending: with the
                        // run blocked, this field is the only channel to the
                        // model, and its text is what the verdict carries.
                        onKeyDown={handleEditorKeyDown}
                        suspendKeyboardNavigation={isSlashMenuOpen || isAddSourcesMenuOpen}
                        onContentEditableRef={(el) => {
                            // Forward the Lexical content-editable element to the
                            // parent's inputRef so legacy `.focus()` callers work.
                            (inputRef as React.MutableRefObject<HTMLElement | null>).current = el;
                        }}
                    />
                </div>

                {/* Control row: add sources and the model on the left, web
                    search and send after the flexible gap. */}
                <div className="composer-controls">
                    {!hideAttachmentMenu && (
                        <AddSourcesMenu
                            ref={addSourcesMenuRef}
                            isMenuOpen={isAddSourcesMenuOpen}
                            menuPosition={addSourcesMenuPosition}
                            searchQuery={addSourcesSearchQuery}
                            querySource={addSourcesQuerySource}
                            onQueryChange={setAddSourcesSearchQuery}
                            onOpen={openAddSourcesMenu}
                            onDismiss={dismissAddSourcesMenu}
                            onCommit={commitAddSourcesMenu}
                            onResetQuery={resetAddSourcesQuery}
                            menuPortalContainer={menuPortalContainer}
                            disabled={isAwaitingApproval}
                            verticalPosition={verticalPosition}
                        />
                    )}
                    {!hideModelSelector && (
                        <ModelSelectionButton inputRef={inputRef} focusInput={focusEditor} disabled={isAwaitingApproval} />
                    )}
                    <div className="flex-1" />
                    <span id={webSearchDescriptionId} className="sr-only">
                        {webSearchDescription}
                    </span>
                    {!showVerdictButtons && (
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
                            className="composer-web-search"
                            iconClassName={isWebSearchEnabled ? 'font-color-accent-blue stroke-width-2' : ''}
                            ariaLabel="Web search"
                            ariaPressed={isWebSearchEnabled}
                            ariaDescribedBy={webSearchDescriptionId}
                            onClick={handleWebSearchToggle}
                            disabled={isAwaitingApproval || !isWebSearchAllowed}
                        />
                    </Tooltip>
                    )}

                    {/* Send, and the two things that take its place: Stop while
                        a run is live, and the pair of verdict buttons once
                        there are instructions for a pending approval. */}
                    {showVerdictButtons ? (
                        <>
                            <Button
                                type="button"
                                variant="surface"
                                className="composer-reject"
                                ariaLabel={rejectVerdictLabel}
                                disabled={isVerdictInFlight}
                                onClick={() => handleApprovalVerdict(false, true)}
                            >
                                {rejectVerdictLabel}
                            </Button>
                            <Button
                                type="button"
                                variant="solid"
                                className="composer-approve"
                                ariaLabel={approveVerdictLabel}
                                disabled={isVerdictInFlight}
                                onClick={() => handleApprovalVerdict(true, true)}
                            >
                                {approveVerdictLabel}
                            </Button>
                        </>
                    ) : isPending ? (
                        <IconButton
                            icon={StopIcon}
                            variant="surface"
                            className="composer-send composer-send-stop"
                            ariaLabel="Stop generating"
                            onClick={handleStop}
                        />
                    ) : (
                        <IconButton
                            icon={ArrowUpLineIcon}
                            variant="solid"
                            className="composer-send"
                            ariaLabel="Send message"
                            onClick={handleSubmit}
                            disabled={messageContent.length === 0 || !selectedModel || isSlashMenuOpen || isAttachingFiles}
                        />
                    )}
                </div>
            </form>
        </div>
    );
};

export default InputArea;
