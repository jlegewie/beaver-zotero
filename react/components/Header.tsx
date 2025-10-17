import React from 'react';
import { CancelIcon, PlusSignIcon, SettingsIcon } from './icons/icons';
import DatabaseStatusButton from './ui/buttons/DatabaseStatusButton';
import { triggerToggleChat } from '../../src/ui/toggleChat';
import { newThreadAtom, threadMessagesAtom } from '../atoms/threads';
import { useAtomValue, useSetAtom } from 'jotai';
import IconButton from './ui/IconButton';
import Tooltip from './ui/Tooltip';
import { isAuthenticatedAtom } from '../atoms/auth';
import ThreadsMenu from './ui/menus/ThreadsMenu';
import UserAccountMenuButton from './ui/buttons/UserAccountMenuButton';
import { isPreferencePageVisibleAtom } from '../atoms/ui';
import { planFeaturesAtom, hasCompletedOnboardingAtom } from '../atoms/profile';
import Button from './ui/Button';

interface HeaderProps {
    onClose?: () => void;
    settingsPage?: boolean;
}

const Header: React.FC<HeaderProps> = ({ onClose, settingsPage }) => {
    const threadMessages = useAtomValue(threadMessagesAtom);
    const newThread = useSetAtom(newThreadAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const isPreferencePageVisible = useAtomValue(isPreferencePageVisibleAtom);
    const planFeatures = useAtomValue(planFeaturesAtom);
    const setPreferencePageVisible = useSetAtom(isPreferencePageVisibleAtom);
    const hasCompletedOnboarding = useAtomValue(hasCompletedOnboardingAtom);

    const handleNewThread = async () => {
        await newThread();
    }

    // Get platform-specific shortcut text
    const newChatShortcut = Zotero.isMac ? '⌘N' : 'Ctrl+N';
    const closeChatShortcut = Zotero.isMac ? '⌘L' : 'Ctrl+L';

    return (
        <div id="beaver-header" className="display-flex flex-row px-3 py-2">
            <div className="flex-1 display-flex gap-4">

                {/* Close chat */}
                <Tooltip content="Close chat" secondaryContent={closeChatShortcut} showArrow singleLine>
                    <IconButton
                        icon={CancelIcon}
                        onClick={() => triggerToggleChat(Zotero.getMainWindow())}
                        className="scale-14"
                        ariaLabel="Close chat"
                    />
                </Tooltip>

                {/* New chat and chat history */}
                {isAuthenticated && hasCompletedOnboarding && (
                    <>
                    <Tooltip content="New Chat" secondaryContent={newChatShortcut} showArrow singleLine>
                        <IconButton
                            icon={PlusSignIcon}
                            onClick={handleNewThread}
                            className="scale-14"
                            ariaLabel="New thread"
                            disabled={threadMessages.length === 0 && !isPreferencePageVisible}
                        />
                    </Tooltip>
                    <ThreadsMenu
                        className="scale-14"
                        ariaLabel="Show chat history"
                    />
                    </>
                )}
            </div>

            {/* Database status and user account menu */}
            {isAuthenticated && !settingsPage && (
                <div className="display-flex gap-4">
                    {planFeatures.databaseSync && hasCompletedOnboarding &&
                        <Tooltip content="Sync with Beaver" showArrow singleLine>
                            <DatabaseStatusButton />
                        </Tooltip>
                    }
                    <UserAccountMenuButton
                        className="scale-14"
                        ariaLabel="User settings"
                    />
                </div>
            )}

            {/* Close settings page */}
            {isAuthenticated && settingsPage && (
                <Button
                    variant="outline"
                    rightIcon={SettingsIcon}
                    onClick={() => setPreferencePageVisible((prev) => !prev)}
                    iconClassName="scale-12"
                >
                    <span className="text-base">Close</span>
                </Button>
            )}
        </div>
    );
};

export default Header;