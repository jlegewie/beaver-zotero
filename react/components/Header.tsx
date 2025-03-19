import React from 'react';
import { CancelIcon, PlusSignIcon, UserIcon } from './icons';
import DatabaseStatusIndicator from './DatabaseStatusIndicator';
import { triggerToggleChat } from '../../src/ui/toggleChat';
import { newThreadAtom, threadMessagesAtom } from '../atoms/threads';
import { useAtomValue, useSetAtom } from 'jotai';
import IconButton from './IconButton';
import Tooltip from './Tooltip';
import { isAuthenticatedAtom } from '../atoms/auth';
import RecentThreadsMenuButton from './RecentThreadsMenuButton';
import UserAccountMenuButton from './UserAccountMenuButton';

interface HeaderProps {
    onClose?: () => void;
}

const Header: React.FC<HeaderProps> = ({ onClose }) => {
    const threadMessages = useAtomValue(threadMessagesAtom);
    const newThread = useSetAtom(newThreadAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    
    const handleNewThread = async () => {
        await newThread();
    }

    // Get platform-specific shortcut text
    const newChatShortcut = Zotero.isMac ? '⌘N' : 'Ctrl+N';
    const closeChatShortcut = Zotero.isMac ? '⌘L' : 'Ctrl+L';

    return (
        <div id="beaver-header" className="flex flex-row px-3 py-2">
            <div className="flex-1 flex gap-4">
                <Tooltip content="Close chat" secondaryContent={closeChatShortcut} showArrow singleLine>
                    <IconButton
                        icon={CancelIcon}
                        onClick={() => triggerToggleChat(Zotero.getMainWindow())}
                        className="scale-14"
                        ariaLabel="Close chat"
                    />
                </Tooltip>
                <Tooltip content="New Chat" secondaryContent={newChatShortcut} showArrow singleLine>
                    <IconButton
                        icon={PlusSignIcon}
                        onClick={handleNewThread}
                        className="scale-14"
                        ariaLabel="New thread"
                        disabled={threadMessages.length === 0}
                    />
                </Tooltip>
                <RecentThreadsMenuButton
                    className="scale-14"
                    ariaLabel="Show chat history"
                />
            </div>
            {isAuthenticated && (
                <div className="flex gap-4">
                    <DatabaseStatusIndicator />
                    <UserAccountMenuButton
                        className="scale-14"
                        ariaLabel="User settings"
                    />
                </div>
            )}
        </div>
    );
};

export default Header;