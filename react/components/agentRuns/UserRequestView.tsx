import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { BeaverAgentPrompt, MessageSearchFilters } from '@beaver/agent-core/agents/types';
import {
    messageAttachmentIdentity,
    mergeMessageAttachments,
    type MessageAttachment,
} from '@beaver/agent-core/types/attachments/apiTypes';
import ContextMenu from '@beaver/agent-ui/primitives/ContextMenu';
import { getHost } from '@beaver/agent-ui/host';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';
import {
    RequestChips,
    requestFilterCollectionKey,
    requestFilterTagKey,
    type RequestChipRef,
} from './requestChips';
import { EditIcon, Spinner, ArrowUpLineIcon } from '../icons/icons';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import ModelSelectionButton from '../ui/buttons/ModelSelectionButton';
import SearchMenu from '@beaver/agent-ui/primitives/SearchMenu';
import { regenerateWithEditedPromptAtom, isWSChatPendingAtom, retryPendingRunIdAtom } from '../../atoms/agentRunAtoms';
import { selectedModelAtom } from '../../atoms/models';
import { isStreamingAtom } from '@beaver/agent-core/run-state/atoms';
import { actionsAtom, buildEditedPromptActionsAtom } from '../../atoms/actions';
import { clearPromptEditDraftAtom, promptEditDraftsAtom, setPromptEditDraftAtom } from '../../atoms/promptEdits';
import { ensurePromptActionTokens, promptActionsToDescriptors, type SlashCommandDescriptor } from '@beaver/agent-ui/composer/slashCommands';
import { hasProseFindMatch, renderContentWithSlashPills } from './slashCommandRendering';
import { useFindQuery } from '@beaver/agent-ui/chat/findContext';
import { highlightText } from '@beaver/agent-ui/chat/highlightText';
import { LexicalEditorInput, LexicalEditorInputHandle } from '@beaver/agent-ui/composer/LexicalEditorInput';
import { useSlashMenu } from '../../hooks/useSlashMenu';
import { useAddSourcesMenu, AddSourcesMenuHandle } from '@beaver/agent-ui/composer/useAddSourcesMenu';
import { useActionPopupResolver } from '../../hooks/useActionPopupResolver';

interface UserRequestViewProps {
    userPrompt: BeaverAgentPrompt;
    runId: string;
    /** Max height in pixels before content fades out (default: 400) */
    maxContentHeight?: number;
    /** Whether the user can edit the prompt (should match AgentRunFooter visibility) */
    canEdit?: boolean;
}

const EMPTY_ATTACHMENTS: MessageAttachment[] = [];

function filterChipCount(filters: MessageSearchFilters | null): number {
    if (!filters) return 0;
    return (filters.libraries?.length ?? 0)
        + (filters.collections?.length ?? 0)
        + (filters.tags?.length ?? 0);
}

/**
 * Identity of the chips on a prompt. Tracks which chips are present, not their
 * contents — used only to tell a dirty edit from an untouched one.
 */
function attachmentIdentity(
    attachments: MessageAttachment[],
    filters: MessageSearchFilters | null,
): string {
    return [
        attachments.map(messageAttachmentIdentity).join(','),
        (filters?.libraries ?? []).map((library) => library.library_id).join(','),
        (filters?.collections ?? []).map(requestFilterCollectionKey).join(','),
        (filters?.tags ?? []).map(requestFilterTagKey).join(','),
    ].join(';');
}

/**
 * Identity of a message's `/command` pills. Deduped and sorted so it tracks
 * which actions the message invokes, not token position. `persisted` is part
 * of the identity: removing and reinserting a pill rebinds the action even
 * though the token text is unchanged.
 */
function pillIdentity(pills: SlashCommandDescriptor[]): string {
    const signatures = pills.map((pill) => `${pill.commandName}:${pill.actionId}:${pill.persisted ? 1 : 0}`);
    return [...new Set(signatures)].sort().join(',');
}

function normalizeFilters(filters: MessageSearchFilters | null): MessageSearchFilters | undefined {
    if (!filters || filterChipCount(filters) === 0) return undefined;
    return filters;
}

/**
 * Renders the user's request in an agent run.
 * Displays attachments, filters, and the userPrompt content.
 *
 * Features:
 * - Limited height with fade-out effect when content exceeds maxContentHeight
 * - Hover effect showing the message is editable (when canEdit is true)
 * - Click to open edit overlay for modifying the message (when canEdit is true)
 *
 * The edit overlay uses the same Lexical editor as the chat input: persisted
 * `/command` tokens are rebuilt as pill nodes from the prompt's `actions`
 * field (pills whose action no longer exists render greyed out), and the
 * slash menu is available for adding new action pills. Attachments and
 * filters are editable too (remove on chips, "+" picker via the host).
 *
 * Unsubmitted edits are stashed per message (`promptEditDraftsAtom`) and
 * restored when the overlay reopens — it closes on incidental click or scroll.
 */
export const UserRequestView: React.FC<UserRequestViewProps> = ({
    userPrompt,
    runId,
    maxContentHeight = 200,
    canEdit = true
}) => {
    const contentRef = useRef<HTMLDivElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    // Lexical contenteditable root (for menu positioning / legacy focus) and
    // the editor's imperative handle.
    const editInputRef = useRef<HTMLElement | null>(null);
    const editorHandleRef = useRef<LexicalEditorInputHandle | null>(null);

    // Edit mode state
    const [isEditing, setIsEditing] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [editedContent, setEditedContent] = useState(userPrompt.content);
    const [editedPills, setEditedPills] = useState<SlashCommandDescriptor[]>([]);
    const [editedAttachments, setEditedAttachments] = useState<MessageAttachment[]>(EMPTY_ATTACHMENTS);
    const [editedFilters, setEditedFilters] = useState<MessageSearchFilters | null>(null);
    const [needsFade, setNeedsFade] = useState(false);
    // Hold sending while a pick is still being staged (file copy, item load).
    const [isStagingSources, setIsStagingSources] = useState(false);
    // Shown in place of the sent message while a submitted edit commits, so
    // closing the overlay does not flash the old text and chips back.
    const [submittedPrompt, setSubmittedPrompt] = useState<BeaverAgentPrompt | null>(null);

    // Identifies the edit session, so an asynchronous pick can be matched to the
    // session that started it (the picker echoes the id back on completion).
    const [editSessionId, setEditSessionId] = useState(0);
    const sessionCounterRef = useRef(0);
    // The session currently open, or null while the overlay is closed. Kept in
    // a ref and written synchronously by both helpers below: staging can finish
    // in the same tick as a close, before React has re-rendered anything.
    const openSessionRef = useRef<number | null>(null);
    const openEditSession = useCallback(() => {
        const id = ++sessionCounterRef.current;
        openSessionRef.current = id;
        setEditSessionId(id);
    }, []);
    const closeEditSession = useCallback(() => {
        openSessionRef.current = null;
    }, []);

    // Atoms
    const regenerateWithEditedPrompt = useSetAtom(regenerateWithEditedPromptAtom);
    const buildEditedPromptActions = useSetAtom(buildEditedPromptActionsAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const selectedModel = useAtomValue(selectedModelAtom);
    const isStreaming = useAtomValue(isStreamingAtom);
    // Loading state after an edited prompt was submitted: the edit overlay is
    // already closed while the retry commits its removal on the backend
    // (truncate POST + undo), before the replacement run replaces this view.
    const isRetryPending = useAtomValue(retryPendingRunIdAtom) === runId;
    const allActions = useAtomValue(actionsAtom);
    const promptEditDraft = useAtomValue(promptEditDraftsAtom)[runId] ?? null;
    const setPromptEditDraft = useSetAtom(setPromptEditDraftAtom);
    const clearPromptEditDraft = useSetAtom(clearPromptEditDraftAtom);
    // Supplies the edit overlay's /command pill hover cards with the live
    // action definitions, matching the chat composer.
    const resolveAction = useActionPopupResolver();
    const displayContent = useMemo(
        () => ensurePromptActionTokens(userPrompt.content, userPrompt.actions),
        [userPrompt.content, userPrompt.actions],
    );

    // Editing is only allowed when canEdit is true AND no run is streaming
    const canEditNow = canEdit && !isStreaming;

    // Find-in-chat: `''` unless a find session is highlighting this thread.
    const findQuery = useFindQuery();
    // Whether this message holds at least one hit. Measured over the same
    // string the body renders, and with the same pill rule, so this can never
    // disagree with the highlighting the renderers produce.
    const hasFindMatch = useMemo(
        () => hasProseFindMatch(displayContent, userPrompt.actions ?? [], findQuery),
        [displayContent, userPrompt.actions, findQuery],
    );
    // A hit past the fold would otherwise be highlighted, counted by the find
    // bar, and unreachable: the message body is clamped and does not scroll. So
    // a matching message drops its clamp for as long as the query stands.
    // Editing is excluded — the display keeps its box (invisible, behind the
    // absolutely positioned overlay), and an unclamped one would push the run's
    // layout open behind the editor.
    const releaseHeightClamp = hasFindMatch && !isEditing;

    const {
        isMenuOpen: isSelectionMenuOpen,
        menuPosition: selectionMenuPosition,
        closeMenu: closeSelectionMenu,
        handleContextMenu,
        menuItems: selectionMenuItems
    } = useSelectionContextMenu(contentRef);

    const focusEditor = useCallback(() => {
        editorHandleRef.current?.focus();
    }, []);
    // Stable forwarder so the slash menu can insert a command pill into the
    // Lexical editor (the editor handle isn't available until after mount).
    const insertSlashCommand = useCallback((descriptor: SlashCommandDescriptor, queryLength: number | null) => {
        editorHandleRef.current?.insertSlashCommand(descriptor, queryLength);
    }, []);

    // Lets a menu consume the `@query` / `/query` it used as its search box.
    const deleteTrailingQuery = useCallback((length: number) => {
        editorHandleRef.current?.deleteTrailingQuery(length);
    }, []);
    const addSourcesMenuRef = useRef<AddSourcesMenuHandle | null>(null);
    const requestSourcesMenu = getHost().components?.requestSourcesMenu;

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
    } = useSlashMenu(editInputRef, 'below', focusEditor, insertSlashCommand, {
        setContent: setEditedContent,
        // The overlay edits a sent message's own attachment list; targets an
        // action pulls in are added to it on submit, not to the composer.
        attachTargets: false,
    });

    // Typed `@` opens the picker with the editor as its search box (same as
    // the composer). The "+" button opens the same menu with its own field.
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
        verticalPosition: 'below',
        deleteTrailingQuery,
        focusEditor,
        setMessageContent: setEditedContent,
        menuRef: addSourcesMenuRef,
    });

    // Check if content needs fade effect.
    // This stays a pure measurement of "the content overflows", never of "the
    // clamp is on": `scrollHeight` reports the untruncated height whether or not
    // the max height applies, so releasing the clamp cannot flip the flag and
    // the fade returns unchanged once the query is cleared. `findQuery` is a
    // dependency only because highlighting re-renders the body.
    useEffect(() => {
        if (contentRef.current) {
            const contentHeight = contentRef.current.scrollHeight;
            setNeedsFade(contentHeight > maxContentHeight);
        }
    }, [displayContent, maxContentHeight, findQuery]);

    const sentPillIdentity = useMemo(
        () => pillIdentity(promptActionsToDescriptors(userPrompt.actions, allActions)),
        [userPrompt.actions, allActions],
    );

    // Whether the edit differs from the message as sent (drives stash vs drop).
    const isDirty = useCallback((
        content: string,
        pills: SlashCommandDescriptor[],
        attachments: MessageAttachment[],
        filters: MessageSearchFilters | null,
    ) => (
        content !== displayContent
        || pillIdentity(pills) !== sentPillIdentity
        || attachmentIdentity(attachments, filters)
            !== attachmentIdentity(userPrompt.attachments ?? EMPTY_ATTACHMENTS, userPrompt.filters ?? null)
    ), [displayContent, sentPillIdentity, userPrompt.attachments, userPrompt.filters]);

    const stashEdits = useCallback((content: string, pills: SlashCommandDescriptor[]) => {
        if (isDirty(content, pills, editedAttachments, editedFilters)) {
            setPromptEditDraft({
                runId,
                draft: { content, pills, attachments: editedAttachments, filters: editedFilters },
            });
        } else {
            clearPromptEditDraft(runId);
        }
    }, [clearPromptEditDraft, editedAttachments, editedFilters, isDirty, runId, setPromptEditDraft]);

    /** Close the overlay, stashing dirty edits. Used by incidental closes
     *  (click outside, Escape, scrolled out of view) — not Cancel. */
    const closeAndStash = useCallback(() => {
        // Text typed with an input method is withheld until its composition
        // ends; publish it so it is stashed rather than lost.
        const content = editorHandleRef.current?.flushPendingText() ?? editedContent;
        const pills = editorHandleRef.current?.getSlashCommands() ?? editedPills;
        stashEdits(content, pills);
        closeEditSession();
        setIsEditing(false);
    }, [closeEditSession, editedContent, editedPills, stashEdits]);

    // The listeners below are registered once per edit session but must run the
    // current closure, which changes with every keystroke.
    const closeAndStashRef = useRef(closeAndStash);
    closeAndStashRef.current = closeAndStash;

    // Handle click outside to close edit mode
    useEffect(() => {
        if (!isEditing) return;

        // Get the document from the container element (works in both sidebar and separate window)
        const doc = containerRef.current?.ownerDocument;
        if (!doc) return;

        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node;

            // Don't close if clicking inside the overlay
            if (overlayRef.current?.contains(target)) {
                return;
            }

            // Don't close if clicking inside a menu
            const isMenuClick = (target as Element).closest?.('.context-menu, .search-menu, .dropdown-menu, [role="menu"]');
            if (isMenuClick) {
                return;
            }

            closeAndStashRef.current();
        };

        // Use capture phase to catch events before they bubble
        doc.addEventListener('mousedown', handleClickOutside, true);
        return () => {
            doc.removeEventListener('mousedown', handleClickOutside, true);
        };
    }, [isEditing]);

    // Close edit mode when scrolled out of view
    useEffect(() => {
        if (!isEditing || !containerRef.current) return;

        const observer = new IntersectionObserver(
            ([entry]) => {
                // Close if the element is not intersecting (out of view)
                if (!entry.isIntersecting) {
                    closeAndStashRef.current();
                }
            },
            {
                // Use the thread view as root to detect scrolling within the container
                root: containerRef.current.closest('#beaver-thread-view'),
                threshold: 0
            }
        );

        observer.observe(containerRef.current);

        return () => observer.disconnect();
    }, [isEditing]);

    // Focus the editor when entering edit mode (caret lands at the end).
    useEffect(() => {
        if (isEditing) {
            // Use requestAnimationFrame to ensure the editor is mounted
            requestAnimationFrame(() => {
                editorHandleRef.current?.focus();
            });
        }
    }, [isEditing]);

    const shownPrompt = submittedPrompt ?? userPrompt;
    const shownContent = useMemo(
        () => (submittedPrompt
            ? ensurePromptActionTokens(submittedPrompt.content, submittedPrompt.actions)
            : displayContent),
        [submittedPrompt, displayContent],
    );

    // Check if we have content to display in the filters/attachments section
    const hasFiltersOrAttachments =
        (shownPrompt.attachments?.length ?? 0) > 0 ||
        (shownPrompt.filters?.libraries?.length ?? 0) > 0 ||
        (shownPrompt.filters?.collections?.length ?? 0) > 0 ||
        (shownPrompt.filters?.tags?.length ?? 0) > 0;

    const handleClick = useCallback((e: React.MouseEvent) => {
        // Gecko dispatches click for non-primary buttons too, so a right-click
        // (e.g. opening a chip's context menu) must not enter edit mode and
        // hide the view.
        if (e.button !== 0) return;
        // A submitted edit is already committing; do not reopen it.
        if (isRetryPending || submittedPrompt) return;
        if (!isEditing && canEditNow) {
            // Content and pills must be staged BEFORE the editor mounts: the
            // editor materializes /command tokens as pill nodes only while
            // syncing the content string in, so pills arriving a commit later
            // would leave the tokens as plain text.
            setEditedContent(promptEditDraft ? promptEditDraft.content : displayContent);
            setEditedPills(promptEditDraft
                ? promptEditDraft.pills
                : promptActionsToDescriptors(userPrompt.actions, allActions));
            setEditedAttachments(promptEditDraft
                ? promptEditDraft.attachments
                : (userPrompt.attachments ?? EMPTY_ATTACHMENTS));
            setEditedFilters(promptEditDraft ? promptEditDraft.filters : (userPrompt.filters ?? null));
            openEditSession();
            setIsEditing(true);
        }
    }, [isEditing, canEditNow, isRetryPending, submittedPrompt, displayContent, promptEditDraft, userPrompt.actions, userPrompt.attachments, userPrompt.filters, allActions, openEditSession]);

    // After the slash menu consumed an editor change (open/close/query), the
    // menu re-render can clobber the caret in Zotero's chrome document; put it
    // back at the end of the content like the main input does.
    const queueCaretToEnd = useCallback((offset: number) => {
        const win = editInputRef.current?.ownerDocument.defaultView;
        win?.setTimeout(() => {
            editorHandleRef.current?.selectRange(offset, offset);
        }, 0);
    }, []);

    const handleEditorChange = useCallback((value: string) => {
        // An open Add Sources menu owns keystrokes, so `/` in its query is a
        // search term, not an actions trigger.
        if (requestSourcesMenu && handleAddSourcesChange(value)) {
            queueCaretToEnd(value.length);
            return;
        }
        if (handleSlashMenuChange(value)) {
            queueCaretToEnd(value.length);
            return;
        }
        const inputEl = editInputRef.current;
        if (inputEl && handleSlashTrigger(value, inputEl.getBoundingClientRect())) {
            queueCaretToEnd(value.length);
            return;
        }
        if (requestSourcesMenu && inputEl && handleAddSourcesTrigger(value, inputEl.getBoundingClientRect())) {
            queueCaretToEnd(value.length);
            return;
        }
        setEditedContent(value);
    }, [
        handleAddSourcesChange,
        handleAddSourcesTrigger,
        handleSlashMenuChange,
        handleSlashTrigger,
        queueCaretToEnd,
        requestSourcesMenu,
    ]);

    /**
     * Apply a finished pick, unless the session that started it has closed.
     *
     * Staging is asynchronous (a file is copied and hashed, an item's data is
     * loaded, a collection is serialized) and outlives the overlay, so a pick
     * can land after the user has closed or reopened the message. Rather than
     * try to reroute it, such a pick is dropped: sending is held while staging
     * runs (see `onPendingChange`), so the only thing this can discard is a
     * pick the user navigated away from before it landed.
     */
    const handleAddAttachments = useCallback((added: MessageAttachment[], sessionId: number) => {
        if (sessionId !== openSessionRef.current) return;
        setEditedAttachments((prev) => mergeMessageAttachments(prev, added));
    }, []);

    const handleFiltersChange = useCallback((filters: MessageSearchFilters, sessionId: number) => {
        if (sessionId !== openSessionRef.current) return;
        setEditedFilters(filters);
    }, []);

    const handleRemoveAttachment = useCallback((attachmentKey: string) => {
        setEditedAttachments((prev) => prev.filter((a) => messageAttachmentIdentity(a) !== attachmentKey));
    }, []);

    const handleRemoveChip = useCallback((ref: RequestChipRef) => {
        if (ref.kind === 'attachment') {
            handleRemoveAttachment(ref.key);
            return;
        }
        setEditedFilters((prev) => {
            if (!prev) return prev;
            const next: MessageSearchFilters = ref.kind === 'library'
                ? { ...prev, libraries: (prev.libraries ?? []).filter((l) => l.library_id !== ref.libraryId) }
                : ref.kind === 'collection'
                    ? { ...prev, collections: (prev.collections ?? []).filter((c) => requestFilterCollectionKey(c) !== ref.key) }
                    : { ...prev, tags: (prev.tags ?? []).filter((t) => requestFilterTagKey(t) !== ref.key) };
            return normalizeFilters(next) ?? null;
        });
    }, [handleRemoveAttachment]);

    const handleRemoveAllChips = useCallback(() => {
        setEditedAttachments(EMPTY_ATTACHMENTS);
        setEditedFilters(null);
    }, []);

    const editableChipCount = editedAttachments.length + filterChipCount(editedFilters);

    // RequestChips takes a prompt; only attachments and filters are read.
    const editedChipPrompt = useMemo<BeaverAgentPrompt>(() => ({
        ...userPrompt,
        attachments: editedAttachments,
        filters: editedFilters ?? undefined,
    }), [userPrompt, editedAttachments, editedFilters]);

    const handleSubmit = useCallback(async (e: React.FormEvent | React.MouseEvent) => {
        e.preventDefault();
        // Text typed with an input method reaches `editedContent` one
        // composition at a time, and the last one lands shortly after the user
        // commits it. Publish anything still withheld so saving right after the
        // commit keeps the committed text (see flushPendingText).
        const content = editorHandleRef.current?.flushPendingText() ?? editedContent;
        if (isPending || content.length === 0 || isStagingSources) return;

        // Build the edited prompt from the editor's pills: surviving pills
        // reuse their persisted wire action, new pills resolve like a fresh
        // compose (possibly pulling in attachments), and pills whose token
        // the user deleted drop out.
        const pills = editorHandleRef.current?.getSlashCommands() ?? [];
        const result = await buildEditedPromptActions({
            pills,
            persistedActions: userPrompt.actions,
            // Dedup against the edited attachment list, not the sent one, so
            // a kept chip is not duplicated and a removed chip is not restored.
            existingAttachments: editedAttachments,
        });
        if (!result) return; // Cannot run right now — a popup explains why

        const attachments = mergeMessageAttachments(editedAttachments, result.addedAttachments);

        const editedPrompt: BeaverAgentPrompt = {
            ...userPrompt,
            content,
            actions: result.actions,
            attachments: attachments.length > 0 ? attachments : undefined,
            filters: normalizeFilters(editedFilters),
        };

        // Stash rather than clear: regeneration can still bail out (undo-confirm
        // Cancel, failed truncate, chat switch). A successful truncate drops
        // the stash with the removed runs, so nothing clears it here.
        stashEdits(content, pills);
        closeEditSession();
        setSubmittedPrompt(editedPrompt);
        setIsEditing(false);
        await regenerateWithEditedPrompt({ runId, editedPrompt });
        // Regeneration bailed out and this message is still the thread's. On
        // the committed path this component is already gone.
        setSubmittedPrompt(null);
    }, [
        isPending,
        isStagingSources,
        editedContent,
        editedAttachments,
        editedFilters,
        userPrompt,
        runId,
        regenerateWithEditedPrompt,
        buildEditedPromptActions,
        stashEdits,
        closeEditSession,
    ]);

    /** Cancel is the one close that discards the stash — and with it any pick
     *  still being staged, which the user has just said they do not want. */
    const handleCancel = useCallback(() => {
        clearPromptEditDraft(runId);
        closeEditSession();
        setIsEditing(false);
    }, [clearPromptEditDraft, closeEditSession, runId]);

    // Enter in the editor submits (Shift+Enter inserts a newline; handled by
    // the editor). Suppressed while a slash or Add Sources menu owns the keyboard.
    const handleEditorSubmit = useCallback(() => {
        if (isPending || isSlashMenuOpen || isStagingSources) return;
        if (isAddSourcesMenuOpen) return;
        const fakeEvent = { preventDefault: () => {} } as React.FormEvent;
        handleSubmit(fakeEvent);
    }, [isPending, isSlashMenuOpen, isAddSourcesMenuOpen, isStagingSources, handleSubmit]);

    const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        // While a menu is open it owns navigation/selection keys (including
        // Escape, which closes just that menu).
        if (requestSourcesMenu && handleAddSourcesKeyDown(e)) return;
        if (handleSlashMenuKeyDown(e)) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeAndStash();
        }
    }, [requestSourcesMenu, handleAddSourcesKeyDown, handleSlashMenuKeyDown, closeAndStash]);

    // The editor's element is not attached on the render that opens the
    // overlay, so fall back to this view's own container, which is.
    const menuPortalContainer = (editInputRef.current ?? containerRef.current)
        ?.closest('[id^="beaver-react-root-"], #beaver-pane-window') as HTMLElement | null;

    const sourcesMenu = isEditing
        ? requestSourcesMenu?.({
            attachments: editedAttachments,
            filters: editedFilters,
            onAddAttachments: handleAddAttachments,
            onRemoveAttachment: handleRemoveAttachment,
            onFiltersChange: handleFiltersChange,
            onPendingChange: setIsStagingSources,
            editSessionId,
            isMenuOpen: isAddSourcesMenuOpen,
            menuPosition: addSourcesMenuPosition,
            searchQuery: addSourcesSearchQuery,
            querySource: addSourcesQuerySource,
            onQueryChange: setAddSourcesSearchQuery,
            onOpen: openAddSourcesMenu,
            onDismiss: dismissAddSourcesMenu,
            onCommit: commitAddSourcesMenu,
            onResetQuery: resetAddSourcesQuery,
            menuRef: addSourcesMenuRef,
            menuPortalContainer,
            verticalPosition: 'below',
        })
        : null;

    // Corner badge: spinner while a retry/stream blocks editing, accent pencil
    // when unsent edits are stashed (visible without hover), else hover-to-edit.
    const hasStashedEdits = Boolean(promptEditDraft);
    const editAffordance: 'none' | 'spinner' | 'edit' | 'stashed' =
        isEditing ? 'none'
            : (isRetryPending || submittedPrompt) ? 'spinner'
                : hasStashedEdits ? 'stashed'
                    : !canEditNow ? (isHovered ? 'spinner' : 'none')
                        : isHovered ? 'edit'
                            : 'none';

    return (
        <div className="px-3 py-1 relative" ref={containerRef}>
            {/* Main display (always in DOM for layout) */}
            <div
                id={`user-request-${runId}`}
                className={`
                    user-message-display user-request-view
                    ${!hasFiltersOrAttachments ? 'user-message-display-text' : ''}
                    ${isHovered && !isEditing ? 'user-request-view-hover' : ''}
                    ${isEditing ? 'user-request-view-editing' : ''}
                `}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                onClick={handleClick}
                style={{ cursor: canEditNow ? 'pointer' : 'not-allowed' }}
            >
                {/* Message attachments and filters */}
                {hasFiltersOrAttachments && (
                    <RequestChips userPrompt={shownPrompt} />
                )}

                {/* Message content with max height and fade (both released
                    while a find hit is showing, so the hit can be scrolled to) */}
                <div
                    className={`-ml-1 user-select-text user-request-content border-transparent ${needsFade && !releaseHeightClamp ? 'user-request-content-fade' : ''}`}
                    style={{
                        maxHeight: releaseHeightClamp ? undefined : `${maxContentHeight}px`,
                        overflow: 'hidden',
                        whiteSpace: 'pre-wrap',
                        display: 'block'
                    }}
                    ref={contentRef}
                    onContextMenu={handleContextMenu}
                >
                    {shownPrompt.actions?.length
                        ? renderContentWithSlashPills(shownContent, shownPrompt.actions, findQuery)
                        : highlightText(shownContent, findQuery)}
                </div>

                {editAffordance !== 'none' && (
                    <div
                        className={`user-request-edit-icon mb-075 ${editAffordance === 'stashed' ? 'user-request-edit-icon-stashed' : ''}`}
                        title={editAffordance === 'stashed' ? 'Unsent edits. Click to continue editing' : undefined}
                    >
                        {editAffordance === 'spinner'
                            ? <Spinner size={12} />
                            : <EditIcon width={12} height={12} />}
                    </div>
                )}

                {/* Text selection context menu */}
                <ContextMenu
                    menuItems={selectionMenuItems}
                    isOpen={isSelectionMenuOpen}
                    onClose={closeSelectionMenu}
                    position={selectionMenuPosition}
                    useFixedPosition={true}
                />
            </div>

            {/* Edit overlay (absolute positioned on top) */}
            {isEditing && (
                <div
                    ref={overlayRef}
                    className="user-request-edit-overlay user-message-display"
                    onClick={(e) => e.stopPropagation()}
                >
                    {editableChipCount > 0 && (
                        <RequestChips
                            userPrompt={editedChipPrompt}
                            editing={{
                                onRemove: handleRemoveChip,
                                onRemoveAll: editableChipCount > 1 ? handleRemoveAllChips : undefined,
                            }}
                        />
                    )}

                    {/* Slash-command menu (opened by typing "/") */}
                    <SearchMenu
                        menuItems={slashMenuItems}
                        isOpen={isSlashMenuOpen}
                        onClose={handleSlashDismiss}
                        position={slashMenuPosition}
                        verticalPosition="below"
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

                    {/* Lexical editor input */}
                    <form onSubmit={handleSubmit} className="display-flex flex-col">
                        <div className="mb-2">
                            <LexicalEditorInput
                                ref={editorHandleRef}
                                value={editedContent}
                                onChange={handleEditorChange}
                                pills={editedPills}
                                onPillsChange={setEditedPills}
                                onSubmit={handleEditorSubmit}
                                resolveAction={resolveAction}
                                placeholder="Edit your message..."
                                ariaLabel="Edit message"
                                // The `@` menu has no search field of its own.
                                inlineHint={
                                    isAddSourcesMenuOpen
                                    && addSourcesQuerySource === 'editor'
                                    && addSourcesSearchQuery.length === 0
                                        ? 'Type to search'
                                        : null
                                }
                                onKeyDown={handleEditorKeyDown}
                                suspendKeyboardNavigation={isSlashMenuOpen || isAddSourcesMenuOpen}
                                onContentEditableRef={(el) => {
                                    editInputRef.current = el;
                                }}
                            />
                        </div>

                        {/* Control row — the composer's, minus the controls
                            that do not apply to an edit (no web-search toggle). */}
                        <div className="composer-controls">
                            {sourcesMenu}
                            <ModelSelectionButton inputRef={editInputRef} focusInput={focusEditor} />
                            <div className="flex-1" />
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={handleCancel}
                            >
                                Cancel
                            </Button>
                            <IconButton
                                icon={ArrowUpLineIcon}
                                variant="solid"
                                className="composer-send"
                                ariaLabel="Send edited message"
                                onClick={handleSubmit}
                                disabled={
                                    editedContent.length === 0
                                    || isPending
                                    || isStagingSources
                                    || !selectedModel
                                    || isSlashMenuOpen
                                }
                            />
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
};

export default UserRequestView;
