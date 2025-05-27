import React, { useEffect, useState }  from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { threadMessagesAtom, currentThreadIdAtom, recentThreadsAtom, addToolCallResponsesToToolAttachmentsAtom, userAttachmentsAtom } from '../../../atoms/threads';
import MenuButton from '../MenuButton';
import { MenuItem } from '../menu/ContextMenu';
import { threadService } from '../../../../src/services/threadService';
import { Thread } from '../../../types/chat/uiTypes';
import { ChattingIcon } from '../../icons/icons';
import { ZoteroIcon, ZOTERO_ICONS } from '../../icons/ZoteroIcon';
import { userAtom } from '../../../atoms/auth';
import Spinner from '../../icons/Spinner';
import { getDateGroup } from '../../../utils/dateUtils';
import { isPreferencePageVisibleAtom, userScrolledAtom } from '../../../atoms/ui';
import { currentSourcesAtom } from '../../../atoms/input';
import { currentMessageContentAtom } from '../../../atoms/input';
import { updateAttachmentCitationsAtom } from '../../../atoms/citations';

const MAX_THREADS = 10;

interface ThreadsMenuProps {
    className?: string;
    ariaLabel?: string;
}

/**
 * Groups threads by date: Today, Yesterday, This Week, This Month, Older
 */
const groupThreadsByDate = (threads: Thread[]) => {
    const groups: Record<string, Thread[]> = {
        'Today': [],
        'Yesterday': [],
        'This Week': [],
        'This Month': [],
        'Older': []
    };
    
    // Group threads using the utility function
    threads.forEach(thread => {
        const group = getDateGroup(thread.updatedAt);
        groups[group].push(thread);
    });
    
    return groups;
};

/**
 * Button component that shows recent threads in a dropdown menu
 */
const ThreadsMenu: React.FC<ThreadsMenuProps> = ({ 
    className = '',
    ariaLabel = 'Show chat history'
}) => {
    const user = useAtomValue(userAtom);
    const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false);
    const setThreadMessages = useSetAtom(threadMessagesAtom);
    const setUserAttachments = useSetAtom(userAttachmentsAtom);
    const updateAttachmentCitations = useSetAtom(updateAttachmentCitationsAtom);
    const setCurrentSources = useSetAtom(currentSourcesAtom);
    const setMessageContent = useSetAtom(currentMessageContentAtom);
    const setUserScrolled = useSetAtom(userScrolledAtom);
    const addToolCallResponsesToToolAttachments = useSetAtom(addToolCallResponsesToToolAttachmentsAtom);
    const setIsPreferencePageVisible = useSetAtom(isPreferencePageVisibleAtom);
    const [currentThreadId, setCurrentThreadId] = useAtom(currentThreadIdAtom);
    const [threads, setThreads] = useAtom(recentThreadsAtom);
    const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState<string>('');
    const [allowBlur, setAllowBlur] = useState<boolean>(true);
    
    // New state for pagination
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState<boolean>(false);

    // Fetch initial threads
    useEffect(() => {
        if (!user || !isMenuOpen) return;
        
        const fetchThreads = async () => {
            setIsLoading(true);
            try {
                const response = await threadService.getPaginatedThreads();
                
                setThreads(response.data.map(thread => ({
                    id: thread.id,
                    name: thread.name,
                    createdAt: thread.created_at,
                    updatedAt: thread.updated_at,
                } as Thread)));
                
                setNextCursor(response.next_cursor);
                setHasMore(response.has_more);
            } catch (error) {
                console.error('Error fetching recent threads:', error);
            } finally {
                setIsLoading(false);
            }
        };
        
        fetchThreads();
    }, [setThreads, user, isMenuOpen]);

    // Load more threads
    const loadMoreThreads = async () => {
        if (isLoading || !nextCursor) return;
        
        setIsLoading(true);
        try {
            const response = await threadService.getPaginatedThreads(10, nextCursor);
            
            // Append new threads to existing ones
            setThreads(prevThreads => [
                ...prevThreads,
                ...response.data.map(thread => ({
                    id: thread.id,
                    name: thread.name,
                    createdAt: thread.created_at,
                    updatedAt: thread.updated_at,
                } as Thread))
            ]);
            
            setNextCursor(response.next_cursor);
            setHasMore(response.has_more);
        } catch (error) {
            console.error('Error loading more threads:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleLoadThread = async (threadId: string) => {
        try {
            setUserScrolled(false);
            // Set the current thread ID
            setCurrentThreadId(threadId);
            setIsPreferencePageVisible(false);

            // Use the thread service to fetch messages
            const { messages, userAttachments, toolAttachments } = await threadService.getThreadMessages(threadId);
            
            // Update the thread messages and attachments state
            setThreadMessages(messages);
            await updateAttachmentCitations();
            setUserAttachments(userAttachments);
            // setToolAttachments(toolAttachments);
            addToolCallResponsesToToolAttachments({messages: messages});
            
            // Clear sources for now
            setCurrentSources([]);
            setMessageContent('');
        } catch (error) {
            console.error('Error loading thread:', error);
        }
    };

    const handleDeleteThread = async (threadId: string) => {
        await threadService.deleteThread(threadId);
        // Refresh the threads list
        setThreads((prev) => prev.filter(thread => thread.id !== threadId));
    };

    const handleStartRename = (threadId: string, currentName: string) => {
        setEditingThreadId(threadId);
        setEditingName(currentName || 'Unnamed conversation');
        setAllowBlur(true);
    };

    const handleRenameComplete = async (threadId: string, newName: string) => {
        if (!threadId || !newName.trim()) {
            setEditingThreadId(null);
            return;
        }

        try {
            await threadService.renameThread(threadId, newName);
        } catch (error) {
            console.error('Error renaming thread:', error);
        } finally {
            setEditingThreadId(null);
        }
    };

    // Filter out current thread and limit to MAX_THREADS
    const filteredThreads = threads
        .filter(thread => thread.id !== currentThreadId);
    
    // Group threads by date
    const groupedThreads = groupThreadsByDate(filteredThreads);
    
    // Create menu items with group headers and action buttons
    const menuItems: MenuItem[] = [];
    
    // Add groups in order
    Object.entries(groupedThreads).forEach(([groupName, groupThreads]) => {
        // Only add group if it has threads
        if (groupThreads.length > 0) {
            // Add group header
            menuItems.push({
                label: groupName,
                onClick: () => {}, // No action for headers
                isGroupHeader: true
            });
            
            // Add threads in group
            groupThreads.forEach(thread => {
                const threadName = thread.name || 'Unnamed conversation';
                
                menuItems.push({
                    label: threadName,
                    onClick: () => handleLoadThread(thread.id),
                    customContent: (
                        <div className="display-flex flex-col w-full">
                            {editingThreadId === thread.id ? (
                                // Edit mode
                                <input
                                    type="text"
                                    value={editingName}
                                    className="p-0 rounded w-full bg-transparent font-color-secondary outline-none ring-0 shadow-none"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        e.preventDefault();
                                    }}
                                    onChange={(e) => setEditingName(e.target.value)}
                                    onKeyDown={(e) => {
                                        e.stopPropagation();
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            handleRenameComplete(thread.id, editingName);
                                        } else if (e.key === 'Escape') {
                                            e.preventDefault();
                                            setEditingThreadId(null);
                                        }
                                    }}
                                    onBlur={() => {
                                        if (allowBlur) {
                                            handleRenameComplete(thread.id, editingName);
                                        }
                                    }}
                                    onFocus={() => setAllowBlur(true)}
                                    autoFocus
                                />
                            ) : (
                                <span className="truncate font-color-secondary">
                                    {threadName}
                                </span>
                            )}
                        </div>
                    ),
                    actionButtons: [
                        {
                            icon: <ZoteroIcon icon={ZOTERO_ICONS.TRASH} size={12} />,
                            onClick: (e) => {
                                e.stopPropagation();
                                handleDeleteThread(thread.id);
                            },
                            tooltip: "Delete thread",
                            ariaLabel: "Delete thread", 
                            className: "scale-90 flex"
                        }
                    ]
                });
            });
        }
    });

    return (
        <MenuButton
            menuItems={menuItems}
            variant="ghost"
            icon={ChattingIcon}
            className={className}
            ariaLabel={ariaLabel}
            tooltipContent="Chat history"
            width="200px"
            maxHeight="260px"
            showArrow={true}
            footer={
                <>
                {hasMore ? (
                    <button 
                        className="scale-85 variant-outline has-text mb-1 display-flex items-center justify-center"
                        onClick={loadMoreThreads}
                        disabled={isLoading}
                    >
                        {isLoading ? (
                            <Spinner size={12} className="mr-1" />
                        ) : (
                            "Show more"
                        )}
                    </button>
                ) : (threads.filter(thread => thread.id !== currentThreadId).length === 0) ? (
                    <div className="text-center font-color-tertiary p-2">
                        No threads
                    </div>
                ) : null}
                </>
            }
            toggleCallback={setIsMenuOpen}
        />
    );
};

export default ThreadsMenu; 