import React from 'react';
// @ts-ignore no idea why this is needed
import { useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { threadMessagesAtom, threadSourcesAtom, currentThreadIdAtom, recentThreadsAtom } from '../atoms/threads';
import MenuButton from './MenuButton';
import { MenuItem } from './ContextMenu';
import { threadService } from '../../src/services/threadService';
import { Thread } from '../types/messages';
import { ClockIcon } from './icons';
import { 
    isToday,
    isYesterday,
    isThisWeek,
    isThisMonth
} from '../utils/dateUtils';
import { ZoteroIcon, ZOTERO_ICONS } from './icons/ZoteroIcon';

const MAX_THREADS = 15;

interface RecentThreadsMenuButtonProps {
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
    
    threads.forEach(thread => {
        const date = new Date(thread.updatedAt);
        if (isToday(date)) {
            groups['Today'].push(thread);
        } else if (isYesterday(date)) {
            groups['Yesterday'].push(thread);
        } else if (isThisWeek(date)) {
            groups['This Week'].push(thread);
        } else if (isThisMonth(date)) {
            groups['This Month'].push(thread);
        } else {
            groups['Older'].push(thread);
        }
    });
    
    return groups;
};

/**
 * Button component that shows recent threads in a dropdown menu
 */
const RecentThreadsMenuButton: React.FC<RecentThreadsMenuButtonProps> = ({ 
    className = '',
    ariaLabel = 'Show chat history'
}) => {
    const setThreadMessages = useSetAtom(threadMessagesAtom);
    const setThreadSources = useSetAtom(threadSourcesAtom);
    const [currentThreadId, setCurrentThreadId] = useAtom(currentThreadIdAtom);
    const [threads, setThreads] = useAtom(recentThreadsAtom);
    const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState<string>('');
    const [allowBlur, setAllowBlur] = useState<boolean>(false);

    const handleLoadThread = async (threadId: string) => {
        try {
            // Set the current thread ID
            setCurrentThreadId(threadId);

            // Use the thread service to fetch messages
            const messages = await threadService.getThreadMessages(threadId);
            
            // Update the messages state
            setThreadMessages(messages);
            
            // Clear sources for now
            setThreadSources([]);
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
        .filter(thread => thread.id !== currentThreadId)
        .slice(0, MAX_THREADS);
    
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
                        <div className="flex flex-col w-full">
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
                        // {
                        //     icon: <ZoteroIcon icon={ZOTERO_ICONS.EDIT} size={12} />,
                        //     onClick: (e) => {
                        //         e.stopPropagation();
                        //         e.preventDefault();
                                
                        //         if (editingThreadId === thread.id) {
                        //             setAllowBlur(false);
                        //         }
                                
                        //         handleStartRename(thread.id, threadName);
                        //     },
                        //     tooltip: "Rename thread",
                        //     ariaLabel: "Rename thread",
                        //     className: "scale-90 flex edit-button"
                        // },
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
            // disabled={threads.length === 0}
            icon={ClockIcon}
            className={className}
            ariaLabel={ariaLabel}
            tooltipContent="Chat history"
            width="200px"
            maxHeight="260px"
            showArrow={true}
            footer={
                <button className="scale-85 variant-outline has-text mb-1">
                    Show more
                </button>
            }
        />
    );
};

export default RecentThreadsMenuButton; 