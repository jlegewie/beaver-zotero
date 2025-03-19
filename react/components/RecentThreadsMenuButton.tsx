import React from 'react';
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

    // Filter out current thread and limit to MAX_THREADS
    const filteredThreads = threads
        .filter(thread => thread.id !== currentThreadId)
        .slice(0, MAX_THREADS);
    
    // Group threads by date
    const groupedThreads = groupThreadsByDate(filteredThreads);
    
    // Create menu items with group headers
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
                menuItems.push({
                    label: thread.name || 'Unnamed conversation',
                    onClick: () => handleLoadThread(thread.id),
                    customContent: (
                        <div className="flex flex-col">
                            <span className="truncate font-color-secondary">
                                {thread.name || 'Unnamed conversation'}
                            </span>
                            {/* <span className="text-xs font-color-tertiary">
                                {formatRelativeDate(new Date(thread.updatedAt))}
                            </span> */}
                        </div>
                    )
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
            maxWidth="240px"
            maxHeight="260px"
            showArrow={true}
        />
    );
};

export default RecentThreadsMenuButton; 