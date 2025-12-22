import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { BeaverAgentPrompt } from '../../agents/types';
import ContextMenu from '../ui/menu/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';
import { MessageItemButton } from '../input/MessageItemButton';
import { LibraryButton } from '../library/LibraryButton';
import { CollectionButton } from '../library/CollectionButton';
import { TagButton } from '../library/TagButton';
import { LinkBackwardIcon } from '../icons/icons';
import Button from '../ui/Button';
import ModelSelectionButton from '../ui/buttons/ModelSelectionButton';
import { regenerateWithEditedPromptAtom, isWSChatPendingAtom } from '../../atoms/agentRunAtoms';
import { selectedModelAtom } from '../../atoms/models';

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
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    // Edit mode state
    const [isEditing, setIsEditing] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [editedContent, setEditedContent] = useState(userPrompt.content);
    const [needsFade, setNeedsFade] = useState(false);

    // Atoms
    const regenerateWithEditedPrompt = useSetAtom(regenerateWithEditedPromptAtom);
    const isPending = useAtomValue(isWSChatPendingAtom);
    const selectedModel = useAtomValue(selectedModelAtom);

    const {
        isMenuOpen: isSelectionMenuOpen, 
        menuPosition: selectionMenuPosition,
        closeMenu: closeSelectionMenu,
        handleContextMenu,
        menuItems: selectionMenuItems
    } = useSelectionContextMenu(contentRef);

    // Get Zotero items for attachments
    const attachmentItems = useMemo(() => {
        if (!userPrompt.attachments) return [];
        return userPrompt.attachments
            .map((att) => {
                const item = Zotero.Items.getByLibraryAndKey(att.library_id, att.zotero_key);
                return item ? { attachment: att, item } : null;
            })
            .filter((a): a is { attachment: typeof userPrompt.attachments[0]; item: Zotero.Item } => a !== null);
    }, [userPrompt.attachments]);

    // Initialize edited content when opening edit mode
    useEffect(() => {
        if (isEditing) {
            setEditedContent(userPrompt.content);
        }
    }, [isEditing, userPrompt.content]);

    // Check if content needs fade effect
    useEffect(() => {
        if (contentRef.current) {
            const contentHeight = contentRef.current.scrollHeight;
            setNeedsFade(contentHeight > maxContentHeight);
        }
    }, [userPrompt.content, maxContentHeight]);

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
            setEditedContent(userPrompt.content);
        };

        // Use capture phase to catch events before they bubble
        doc.addEventListener('mousedown', handleClickOutside, true);
        return () => {
            doc.removeEventListener('mousedown', handleClickOutside, true);
        };
    }, [isEditing]);

    const editMaxHeight = maxContentHeight + 50;

    // Focus textarea and resize when entering edit mode
    useEffect(() => {
        if (isEditing) {
            // Use requestAnimationFrame to ensure DOM is ready
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.focus();
                    // Move cursor to end
                    textareaRef.current.selectionStart = textareaRef.current.value.length;
                    textareaRef.current.selectionEnd = textareaRef.current.value.length;
                    // Resize to fit content
                    textareaRef.current.style.height = 'auto';
                    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, editMaxHeight)}px`;
                }
            });
        }
    }, [isEditing, editMaxHeight]);

    // Auto-resize textarea on content change (max editMaxHeight, then scroll)
    useEffect(() => {
        if (isEditing && textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, editMaxHeight)}px`;
        }
    }, [editedContent, isEditing, editMaxHeight]);

    // Check if we have content to display in the filters/attachments section
    const hasFiltersOrAttachments = 
        attachmentItems.length > 0 ||
        (userPrompt.filters?.libraries && userPrompt.filters.libraries.length > 0) ||
        (userPrompt.filters?.collections && userPrompt.filters.collections.length > 0) ||
        (userPrompt.filters?.tags && userPrompt.filters.tags.length > 0);

    const handleClick = useCallback(() => {
        if (!isEditing && canEdit) {
            setIsEditing(true);
        }
    }, [isEditing, canEdit]);

    const handleSubmit = useCallback(async (e: React.FormEvent | React.MouseEvent) => {
        e.preventDefault();
        if (isPending || editedContent.length === 0) return;

        // Build the edited prompt
        const editedPrompt: BeaverAgentPrompt = {
            ...userPrompt,
            content: editedContent,
        };

        setIsEditing(false);
        await regenerateWithEditedPrompt({ runId, editedPrompt });
    }, [isPending, editedContent, userPrompt, runId, regenerateWithEditedPrompt]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Submit on Enter (without Shift)
        if (e.key === 'Enter' && !e.shiftKey && !isPending) {
            e.preventDefault();
            handleSubmit(e);
        }
        // Close on Escape
        if (e.key === 'Escape') {
            e.preventDefault();
            setIsEditing(false);
        }
    }, [isPending, handleSubmit]);

    return (
        <div className="px-3 py-1 relative" ref={containerRef}>
            {/* Main display (always in DOM for layout) */}
            <div 
                id={`user-request-${runId}`} 
                className={`user-message-display user-request-view ${isHovered && !isEditing && canEdit ? 'user-request-view-hover' : ''} ${isEditing ? 'user-request-view-editing' : ''}`}
                onMouseEnter={() => canEdit && setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
                onClick={handleClick}
                style={{ cursor: canEdit ? 'pointer' : 'default' }}
            >
                {/* Message attachments and filters */}
                {hasFiltersOrAttachments && (
                    <div className="display-flex flex-wrap gap-col-3 gap-row-2 mb-2">
                        {/* Library filters */}
                        {userPrompt.filters?.libraries && (
                            userPrompt.filters.libraries
                                .map((library) => Zotero.Libraries.get(library.library_id))
                                .filter((library): library is Zotero.Library => Boolean(library))
                                .map((library) => (
                                    <LibraryButton key={library.libraryID} library={library} canEdit={false} />
                                ))
                        )}

                        {/* Collection filters */}
                        {userPrompt.filters?.collections && (
                            userPrompt.filters.collections
                                .map((collection) => Zotero.Collections.getByLibraryAndKey(collection.library_id, collection.zotero_key))
                                .filter((collection): collection is Zotero.Collection => Boolean(collection))
                                .map((collection) => (
                                    <CollectionButton key={collection.id} collection={collection} canEdit={false} />
                                ))
                        )}

                        {/* Tag filters */}
                        {userPrompt.filters?.tags?.map((tag) => (
                            <TagButton key={tag.id} tag={tag} canEdit={false} />
                        ))}

                        {/* Attachments */}
                        {attachmentItems.map(({ item }, index) => (
                            <MessageItemButton
                                key={index}
                                item={item}
                                canEdit={false}
                            />
                        ))}
                    </div>
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
                    {userPrompt.content}
                </div>

                {/* Edit icon (visible on hover) */}
                {isHovered && !isEditing && canEdit && (
                    <div className="user-request-edit-icon">
                        <LinkBackwardIcon width={14} height={14} />
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
                        <div className="display-flex flex-wrap gap-col-3 gap-row-2 mb-2">
                            {/* Library filters (read-only in edit mode) */}
                            {userPrompt.filters?.libraries && (
                                userPrompt.filters.libraries
                                    .map((library) => Zotero.Libraries.get(library.library_id))
                                    .filter((library): library is Zotero.Library => Boolean(library))
                                    .map((library) => (
                                        <LibraryButton key={library.libraryID} library={library} canEdit={false} />
                                    ))
                            )}

                            {/* Collection filters (read-only in edit mode) */}
                            {userPrompt.filters?.collections && (
                                userPrompt.filters.collections
                                    .map((collection) => Zotero.Collections.getByLibraryAndKey(collection.library_id, collection.zotero_key))
                                    .filter((collection): collection is Zotero.Collection => Boolean(collection))
                                    .map((collection) => (
                                        <CollectionButton key={collection.id} collection={collection} canEdit={false} />
                                    ))
                            )}

                            {/* Tag filters (read-only in edit mode) */}
                            {userPrompt.filters?.tags?.map((tag) => (
                                <TagButton key={tag.id} tag={tag} canEdit={false} />
                            ))}

                            {/* Attachments (read-only in edit mode) */}
                            {attachmentItems.map(({ item }) => (
                                <MessageItemButton
                                    key={item.key}
                                    item={item}
                                    canEdit={false}
                                />
                            ))}
                        </div>
                    )}

                    {/* Textarea input */}
                    <form onSubmit={handleSubmit} className="display-flex flex-col">
                        <div className="mb-2 -ml-1">
                            <textarea
                                ref={textareaRef}
                                value={editedContent}
                                onChange={(e) => setEditedContent(e.target.value)}
                                onInput={(e) => {
                                    e.currentTarget.style.height = 'auto';
                                    e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, editMaxHeight)}px`;
                                }}
                                style={{ maxHeight: `${editMaxHeight}px` }}
                                placeholder="Edit your message..."
                                className="chat-input user-request-edit-textarea"
                                onKeyDown={handleKeyDown}
                                rows={1}
                            />
                        </div>

                        {/* Button Row */}
                        <div className="display-flex flex-row items-center pt-2">
                            <ModelSelectionButton inputRef={textareaRef} />
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
                                    disabled={editedContent.length === 0 || isPending || !selectedModel}
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
