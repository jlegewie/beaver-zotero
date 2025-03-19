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
    formatRelativeDate, 
    isToday,
    isYesterday,
    isThisWeek,
    isThisMonth
} from '../utils/dateUtils';
import Tooltip from './Tooltip';
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
    const threads = useAtomValue(recentThreadsAtom);
    const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState<string>('');

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

    const handleDeleteThread = (threadId: string) => {
        // For now, just log the action
        console.log('Delete thread:', threadId);
    };

    const handleStartRename = (threadId: string, currentName: string) => {
        setEditingThreadId(threadId);
        setEditingName(currentName || 'Unnamed conversation');
    };

    const handleRenameComplete = (threadId: string, newName: string) => {
        // For now, just log the action
        console.log('Rename thread:', threadId, 'New name:', newName);
        setEditingThreadId(null);
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
                                    className="p-1 border rounded w-full text-sm"
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => setEditingName(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            handleRenameComplete(thread.id, editingName);
                                        } else if (e.key === 'Escape') {
                                            setEditingThreadId(null);
                                        }
                                    }}
                                    onBlur={() => handleRenameComplete(thread.id, editingName)}
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
                            icon: <ZoteroIcon icon={ZOTERO_ICONS.EDIT} size={12} />,
                            onClick: (e) => {
                                e.stopPropagation();
                                handleStartRename(thread.id, threadName);
                            },
                            tooltip: "Rename thread",
                            ariaLabel: "Rename thread",
                            className: "scale-90 flex"
                        },
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
    
    // Add "Show All" at the end if there are threads
    if (filteredThreads.length > 0) {
        // If we ended with a divider, remove it
        if (menuItems.length > 0 && menuItems[menuItems.length - 1].isDivider) {
            menuItems.pop();
        }
        
        // Add "Show All" button
        menuItems.push({
            label: 'Show all',
            onClick: () => console.log('show all'),
            customContent: (
                <div className="font-color-primary">
                    Show all
                </div>
            )
        });
    }

    return (
        <MenuButton
            menuItems={menuItems}
            variant="ghost"
            disabled={threads.length === 0}
            icon={ClockIcon}
            className={className}
            ariaLabel={ariaLabel}
            tooltipContent="Chat history"
            width="150px"
            maxHeight="260px"
            showArrow={true}
        />
    );
};

export default RecentThreadsMenuButton; 