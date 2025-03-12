import React from 'react';
import { Thread } from '../types/messages';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { threadMessagesAtom, threadSourcesAtom, currentThreadIdAtom, recentThreadsAtom } from '../atoms/threads';
import MenuButton from './MenuButton';
import { MenuItem } from './ContextMenu';
import { threadService } from '../../src/services/threadService';
import { ClockIcon } from './icons';

interface RecentThreadsMenuButtonProps {
    className?: string;
    ariaLabel?: string;
}

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

    // Create menu items from threads
    const menuItems: MenuItem[] = threads.length === 0
        ? [{ 
            label: 'No recent conversations', 
            onClick: () => {}, 
            disabled: true 
          }] 
        : threads.filter(thread => thread.id !== currentThreadId).map(thread => ({
            label: thread.name || 'Unnamed conversation',
            onClick: () => handleLoadThread(thread.id),
            customContent: (
                <div className="flex flex-col">
                    <span className="truncate font-color-secondary">
                        {thread.name || 'Unnamed conversation'}
                    </span>
                    <span className="text-xs font-color-tertiary">
                        {new Date(thread.updatedAt).toLocaleString()}
                    </span>
                </div>
            )
        }));

    return (
        <MenuButton
            menuItems={menuItems}
            variant="ghost"
            disabled={threads.length === 0}
            icon={ClockIcon}
            className={className}
            ariaLabel={ariaLabel}
            maxWidth="280px"
        />
    );
};

export default RecentThreadsMenuButton; 