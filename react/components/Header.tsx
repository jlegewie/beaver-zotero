import React, { useRef, useCallback } from 'react';
import { CancelIcon, PlusSignIcon, SettingsIcon, Share05Icon } from './icons/icons';
import DatabaseStatusButton from './ui/buttons/DatabaseStatusButton';
import EmbeddingIndexStatusButton from './ui/buttons/EmbeddingIndexStatusButton';
import { triggerToggleChat } from '../../src/ui/toggleChat';
import { openBeaverWindow } from '../../src/ui/openBeaverWindow';
import { newThreadAtom } from '../atoms/threads';
import { runsCountAtom } from '../agents/atoms';
import { useAtomValue, useSetAtom } from 'jotai';
import IconButton from './ui/IconButton';
import Tooltip from './ui/Tooltip';
import { isAuthenticatedAtom, isWaitingForProfileAtom } from '../atoms/auth';
import ThreadsMenu from './ui/menus/ThreadsMenu';
import UserAccountMenuButton from './ui/buttons/UserAccountMenuButton';
import DevToolsMenuButton from './ui/buttons/DevToolsMenuButton';
import { isPreferencePageVisibleAtom } from '../atoms/ui';
import { hasCompletedOnboardingAtom, isDatabaseSyncSupportedAtom, updateRequiredAtom } from '../atoms/profile';
import Button from './ui/Button';
import { getWindowFromElement } from '../utils/windowContext';
import { currentMessageContentAtom } from '../atoms/messageComposition';
import { getPref } from '../../src/utils/prefs';


interface HeaderProps {
    onClose?: () => void;
    settingsPage?: boolean;
    isWindow?: boolean;
}

const Header: React.FC<HeaderProps> = ({ onClose, settingsPage, isWindow = false }) => {
    const runsCount = useAtomValue(runsCountAtom);
    const newThread = useSetAtom(newThreadAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const isWaitingForProfile = useAtomValue(isWaitingForProfileAtom);
    const isPreferencePageVisible = useAtomValue(isPreferencePageVisibleAtom);
    const setPreferencePageVisible = useSetAtom(isPreferencePageVisibleAtom);
    const hasCompletedOnboarding = useAtomValue(hasCompletedOnboardingAtom);
    const isDatabaseSyncSupported = useAtomValue(isDatabaseSyncSupportedAtom);
    const updateRequired = useAtomValue(updateRequiredAtom);
    const currentMessageContent = useAtomValue(currentMessageContentAtom);
    const closeButtonRef = useRef<HTMLButtonElement>(null);

    const handleNewThread = async () => {
        await newThread();
    }

    const handleClose = useCallback(() => {
        if (isWindow) {
            // Get the actual window where the button is rendered, not the main window
            const currentWindow = getWindowFromElement(closeButtonRef.current);
            currentWindow.close();
        } else {
            triggerToggleChat(Zotero.getMainWindow());
        }
    }, [isWindow]);

    // Get platform-specific shortcut text
    const keyboardShortcut = getPref("keyboardShortcut").toUpperCase() || "L";
    const newChatShortcut = Zotero.isMac ? '⌘N' : 'Ctrl+N';
    const closeChatShortcut = Zotero.isMac ? `⌘${keyboardShortcut}` : `Ctrl+${keyboardShortcut}`;
    const openWindowShortcut = Zotero.isMac ? `⌘⇧${keyboardShortcut}` : `Ctrl+Shift+${keyboardShortcut}`;

    return (
        <div id="beaver-header" className="display-flex flex-row px-3 py-2">
            <div className="flex-1 display-flex gap-4">

                {/* Close chat / Close window */}
                {!isWindow && (
                    <Tooltip 
                        content={isWindow ? "Close window" : "Close chat"} 
                        secondaryContent={isWindow ? undefined : closeChatShortcut} 
                        showArrow 
                        singleLine
                    >
                        <IconButton
                            ref={closeButtonRef}
                            icon={CancelIcon}
                            onClick={handleClose}
                            className="scale-14"
                            ariaLabel={isWindow ? "Close window" : "Close chat"}
                        />
                    </Tooltip>
                )}
                
                {/* New chat and chat history */}
                {isAuthenticated && hasCompletedOnboarding && !updateRequired && !isWaitingForProfile && (
                    <>
                    <Tooltip content="New Chat" secondaryContent={newChatShortcut} showArrow singleLine>
                        <IconButton
                            icon={PlusSignIcon}
                            onClick={handleNewThread}
                            className="scale-14"
                            ariaLabel="New thread"
                            disabled={runsCount === 0 && !isPreferencePageVisible}
                        />
                    </Tooltip>
                    </>
                )}

                {/* Only show "Open in Separate Window" button when not already in a separate window and user is authenticated and has completed onboarding */}
                {!isWindow && isAuthenticated && hasCompletedOnboarding && !updateRequired && !isWaitingForProfile && (
                    <Tooltip content="Open in Separate Window" secondaryContent={openWindowShortcut} showArrow singleLine>
                        <IconButton
                            icon={Share05Icon}
                            onClick={openBeaverWindow}
                            className="scale-13"
                            ariaLabel="Open in Separate Window"
                        />
                    </Tooltip>
                )}

                {/* Development tools */}
                {process.env.NODE_ENV === 'development' && (
                    <DevToolsMenuButton
                        className="scale-14"
                        ariaLabel="Development tools"
                        currentMessageContent={currentMessageContent}
                    />
                )}
            </div>

            {/* Database status, embedding index status, and user account menu */}
            {isAuthenticated && !settingsPage && (
                <div className="display-flex gap-4">
                    {/* Show embedding index status for users without databaseSync */}
                    {!isDatabaseSyncSupported && hasCompletedOnboarding && !updateRequired && !isWaitingForProfile && (
                        <EmbeddingIndexStatusButton />
                    )}
                    {/* Show database status for users with databaseSync */}
                    {isDatabaseSyncSupported && hasCompletedOnboarding && !updateRequired && !isWaitingForProfile && (
                        <DatabaseStatusButton />
                    )}
                    {/* Show chat history menu */}
                    {isAuthenticated && hasCompletedOnboarding && !updateRequired && !isWaitingForProfile && (
                        <ThreadsMenu
                            className="scale-14"
                            ariaLabel="Show chat history"
                        />
                    )}
                    {/* Show user account menu */}
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