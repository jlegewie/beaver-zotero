import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { BeaverAgentPrompt } from '../../agents/types';
import ContextMenu from '../ui/menu/ContextMenu';
import useSelectionContextMenu from '../../hooks/useSelectionContextMenu';
import { RequestChips } from './requestChips';
import { EditIcon, Spinner } from '../icons/icons';
import Button from '../ui/Button';
import ModelSelectionButton from '../ui/buttons/ModelSelectionButton';
import { regenerateWithEditedPromptAtom, isWSChatPendingAtom } from '../../atoms/agentRunAtoms';
import { selectedModelAtom } from '../../atoms/models';
import { isStreamingAtom } from '../../agents/atoms';

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
    const isStreaming = useAtomValue(isStreamingAtom);
    
    // Editing is only allowed when canEdit is true AND no run is streaming
    const canEditNow = canEdit && !isStreaming;

    const {
        isMenuOpen: isSelectionMenuOpen, 
        menuPosition: selectionMenuPosition,
        closeMenu: closeSelectionMenu,
        handleContextMenu,
        menuItems: selectionMenuItems
    } = useSelectionContextMenu(contentRef);

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
    }, [isEditing, userPrompt.content]);

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
            setIsEditing(true);
        }
    }, [isEditing, canEditNow]);

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
                    {userPrompt.content}
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
