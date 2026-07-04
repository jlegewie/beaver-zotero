import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { BeaverAgentPrompt } from '../../agents/types';
import ContextMenu from '../ui/menu/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';
import { RequestChips } from './requestChips';
import { EditIcon, Spinner } from '../icons/icons';
import Button from '../ui/Button';
import ModelSelectionButton from '../ui/buttons/ModelSelectionButton';
import SearchMenu from '../ui/menus/SearchMenu';
import { regenerateWithEditedPromptAtom, isWSChatPendingAtom } from '../../atoms/agentRunAtoms';
import { selectedModelAtom } from '../../atoms/models';
import { isStreamingAtom } from '../../agents/atoms';
import { actionsAtom, buildEditedPromptActionsAtom } from '../../atoms/actions';
import { ensurePromptActionTokens, promptActionsToDescriptors, type SlashCommandDescriptor } from '../../utils/slashCommands';
import { renderContentWithSlashPills } from './slashCommandRendering';
import { LexicalEditorInput, LexicalEditorInputHandle } from '../input/lexical/LexicalEditorInput';
import { useSlashMenu } from '../../hooks/useSlashMenu';

interface UserRequestViewProps {
    userPrompt: BeaverAgentPrompt;
    runId: string;
    /** Max height in pixels before content fades out (default: 400) */
    maxContentHeight?: number;
    /** Whether the user can edit the prompt (should match AgentRunFooter visibility) */
    canEdit?: boolean;
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
 * slash menu is available for adding new action pills.
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
    const [needsFade, setNeedsFade] = useState(false);

    // Atoms
    const regenerateWithEditedPrompt = useSetAtom(regenerateWithEditedPromptAtom);
    const buildEditedPromptActions = useSetAtom(buildEditedPromptActionsAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const selectedModel = useAtomValue(selectedModelAtom);
    const isStreaming = useAtomValue(isStreamingAtom);
    const allActions = useAtomValue(actionsAtom);
    const displayContent = useMemo(
        () => ensurePromptActionTokens(userPrompt.content, userPrompt.actions),
        [userPrompt.content, userPrompt.actions],
    );

    // Editing is only allowed when canEdit is true AND no run is streaming
    const canEditNow = canEdit && !isStreaming;

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
    const insertSlashCommand = useCallback((descriptor: SlashCommandDescriptor, queryLength: number) => {
        editorHandleRef.current?.insertSlashCommand(descriptor, queryLength);
    }, []);

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
    } = useSlashMenu(editInputRef, 'below', focusEditor, insertSlashCommand, setEditedContent);

    // Check if content needs fade effect
    useEffect(() => {
        if (contentRef.current) {
            const contentHeight = contentRef.current.scrollHeight;
            setNeedsFade(contentHeight > maxContentHeight);
        }
    }, [displayContent, maxContentHeight]);

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

            setIsEditing(false);
            setEditedContent(displayContent);
        };

        // Use capture phase to catch events before they bubble
        doc.addEventListener('mousedown', handleClickOutside, true);
        return () => {
            doc.removeEventListener('mousedown', handleClickOutside, true);
        };
    }, [isEditing, displayContent]);

    // Close edit mode when scrolled out of view
    useEffect(() => {
        if (!isEditing || !containerRef.current) return;

        const observer = new IntersectionObserver(
            ([entry]) => {
                // Close if the element is not intersecting (out of view)
                if (!entry.isIntersecting) {
                    setIsEditing(false);
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

    // Check if we have content to display in the filters/attachments section
    const hasFiltersOrAttachments =
        (userPrompt.attachments?.length ?? 0) > 0 ||
        (userPrompt.filters?.libraries?.length ?? 0) > 0 ||
        (userPrompt.filters?.collections?.length ?? 0) > 0 ||
        (userPrompt.filters?.tags?.length ?? 0) > 0;

    const handleClick = useCallback((e: React.MouseEvent) => {
        // Gecko dispatches click for non-primary buttons too, so a right-click
        // (e.g. opening a chip's context menu) must not enter edit mode and
        // hide the view.
        if (e.button !== 0) return;
        if (!isEditing && canEditNow) {
            // Content and pills must be staged BEFORE the editor mounts: the
            // editor materializes /command tokens as pill nodes only while
            // syncing the content string in, so pills arriving a commit later
            // would leave the tokens as plain text.
            setEditedContent(displayContent);
            setEditedPills(promptActionsToDescriptors(userPrompt.actions, allActions));
            setIsEditing(true);
        }
    }, [isEditing, canEditNow, displayContent, userPrompt.actions, allActions]);

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
        if (handleSlashMenuChange(value)) {
            queueCaretToEnd(value.length);
            return;
        }
        const inputEl = editInputRef.current;
        if (inputEl && handleSlashTrigger(value, inputEl.getBoundingClientRect())) {
            queueCaretToEnd(value.length);
            return;
        }
        setEditedContent(value);
    }, [handleSlashMenuChange, handleSlashTrigger, queueCaretToEnd]);

    const handleSubmit = useCallback(async (e: React.FormEvent | React.MouseEvent) => {
        e.preventDefault();
        if (isPending || editedContent.length === 0) return;

        // Build the edited prompt from the editor's pills: surviving pills
        // reuse their persisted wire action, new pills resolve like a fresh
        // compose (possibly pulling in attachments), and pills whose token
        // the user deleted drop out.
        const pills = editorHandleRef.current?.getSlashCommands() ?? [];
        const result = await buildEditedPromptActions({
            pills,
            persistedActions: userPrompt.actions,
            existingAttachments: userPrompt.attachments,
        });
        if (!result) return; // Cannot run right now — a popup explains why

        const editedPrompt: BeaverAgentPrompt = {
            ...userPrompt,
            content: editedContent,
            actions: result.actions,
            attachments: result.addedAttachments.length > 0
                ? [...(userPrompt.attachments ?? []), ...result.addedAttachments]
                : userPrompt.attachments,
        };

        setIsEditing(false);
        await regenerateWithEditedPrompt({ runId, editedPrompt });
    }, [isPending, editedContent, userPrompt, runId, regenerateWithEditedPrompt, buildEditedPromptActions]);

    // Enter in the editor submits (Shift+Enter inserts a newline; handled by
    // the editor). Suppressed while the slash menu owns the keyboard.
    const handleEditorSubmit = useCallback(() => {
        if (isPending || isSlashMenuOpen) return;
        const fakeEvent = { preventDefault: () => {} } as React.FormEvent;
        handleSubmit(fakeEvent);
    }, [isPending, isSlashMenuOpen, handleSubmit]);

    const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        // While the slash menu is open it owns navigation/selection keys
        // (including Escape, which closes just the menu).
        if (handleSlashMenuKeyDown(e)) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            setIsEditing(false);
        }
    }, [handleSlashMenuKeyDown]);

    const menuPortalContainer = editInputRef.current?.closest('[id^="beaver-react-root-"], #beaver-pane-window') as HTMLElement | null;

    return (
        <div className="px-3 py-1 relative" ref={containerRef}>
            {/* Main display (always in DOM for layout) */}
            <div
                id={`user-request-${runId}`}
                className={`
                    user-message-display user-request-view
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
                    <RequestChips userPrompt={userPrompt} />
                )}

                {/* Message content with max height and fade */}
                <div
                    className={`-ml-1 user-select-text user-request-content border-transparent ${needsFade ? 'user-request-content-fade' : ''}`}
                    style={{
                        maxHeight: `${maxContentHeight}px`,
                        overflow: 'hidden',
                        whiteSpace: 'pre-wrap',
                        display: 'block'
                    }}
                    ref={contentRef}
                    onContextMenu={handleContextMenu}
                >
                    {userPrompt.actions?.length
                        ? renderContentWithSlashPills(displayContent, userPrompt.actions)
                        : displayContent}
                </div>

                {/* Edit icon (visible on hover) */}
                {isHovered && !isEditing && canEditNow && (
                    <div className="user-request-edit-icon mb-075">
                        <EditIcon width={12} height={12} />
                    </div>
                )}
                {isHovered && !isEditing && !canEditNow && (
                    <div className="user-request-edit-icon mb-075">
                        <Spinner size={12} />
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
                    {/* Attachments and filters display (read-only) */}
                    {hasFiltersOrAttachments && (
                        <RequestChips userPrompt={userPrompt} />
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
                        <div className="mb-2 -ml-1">
                            <LexicalEditorInput
                                ref={editorHandleRef}
                                value={editedContent}
                                onChange={handleEditorChange}
                                pills={editedPills}
                                onPillsChange={setEditedPills}
                                onSubmit={handleEditorSubmit}
                                placeholder="Edit your message..."
                                ariaLabel="Edit message"
                                onKeyDown={handleEditorKeyDown}
                                suspendKeyboardNavigation={isSlashMenuOpen}
                                onContentEditableRef={(el) => {
                                    editInputRef.current = el;
                                }}
                            />
                        </div>

                        {/* Button Row */}
                        <div className="display-flex flex-row items-center pt-2">
                            <ModelSelectionButton inputRef={editInputRef} focusInput={focusEditor} />
                            <div className="flex-1" />
                            <div className="display-flex flex-row items-center gap-4">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    style={{ padding: '2px 5px' }}
                                    onClick={() => setIsEditing(false)}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    type="submit"
                                    variant="solid"
                                    style={{ padding: '2px 5px' }}
                                    onClick={handleSubmit}
                                    disabled={editedContent.length === 0 || isPending || !selectedModel || isSlashMenuOpen}
                                >
                                    <span>Send <span className="opacity-50">⏎</span></span>
                                </Button>
                            </div>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
};

export default UserRequestView;
