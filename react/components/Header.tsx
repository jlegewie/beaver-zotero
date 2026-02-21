import React, { useRef, useCallback } from 'react';
import { CancelIcon, PlusSignIcon, Share05Icon } from './icons/icons';
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
import ThreadMenuButton from './ui/buttons/ThreadMenuButton';
import { hasCompletedOnboardingAtom, isDatabaseSyncSupportedAtom, updateRequiredAtom, isProfileLoadedAtom } from '../atoms/profile';
import { getWindowFromElement } from '../utils/windowContext';
import { currentMessageContentAtom } from '../atoms/messageComposition';
import { getPref } from '../../src/utils/prefs';


interface HeaderProps {
    onClose?: () => void;
    isWindow?: boolean;
}

const Header: React.FC<HeaderProps> = ({ onClose, isWindow = false }) => {
    const runsCount = useAtomValue(runsCountAtom);
    const newThread = useSetAtom(newThreadAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const isWaitingForProfile = useAtomValue(isWaitingForProfileAtom);
    const hasCompletedOnboarding = useAtomValue(hasCompletedOnboardingAtom);
    const isDatabaseSyncSupported = useAtomValue(isDatabaseSyncSupportedAtom);
    const updateRequired = useAtomValue(updateRequiredAtom);
    const isProfileLoaded = useAtomValue(isProfileLoadedAtom);
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
    const keyboardShortcut = getPref("keyboardShortcut").toUpperCase() || "J";
    const newChatShortcut = Zotero.isMac ? '⌘N' : 'Ctrl+N';
    const closeChatShortcut = Zotero.isMac ? `⌘${keyboardShortcut}` : `Ctrl+${keyboardShortcut}`;
    const openWindowShortcut = Zotero.isMac ? `⌘⇧${keyboardShortcut}` : `Ctrl+Shift+${keyboardShortcut}`;

    return (
        <div id="beaver-header" className="display-flex flex-row px-3 py-2">
            {/* Left side: Navigation & Workspace */}
            <div className="flex-1 display-flex gap-4">

                {/* Close chat */}
                {!isWindow && (
                    <Tooltip
                        content="Close chat"
                        secondaryContent={closeChatShortcut}
                        showArrow
                        singleLine
                    >
                        <IconButton
                            ref={closeButtonRef}
                            icon={CancelIcon}
                            onClick={handleClose}
                            className="scale-14"
                            ariaLabel="Close chat"
                        />
                    </Tooltip>
                )}

                {/* Chat history and new chat */}
                {isAuthenticated && hasCompletedOnboarding && !updateRequired && (!isWaitingForProfile || isProfileLoaded) && (
                    <>
                    <ThreadsMenu
                        className="scale-14"
                        ariaLabel="Show chat history"
                    />
                    <Tooltip content="New Chat" secondaryContent={newChatShortcut} showArrow singleLine>
                        <IconButton
                            icon={PlusSignIcon}
                            onClick={handleNewThread}
                            className="scale-14"
                            ariaLabel="New thread"
                            disabled={runsCount === 0}
                        />
                    </Tooltip>
                    <ThreadMenuButton
                        className="scale-14"
                        ariaLabel="Thread actions"
                    />
                    </>
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

            {/* Right side: Current Context & Global Actions */}
            {isAuthenticated && (
                <div className="display-flex gap-4">
                    {/* Embedding index status for users without databaseSync */}
                    {!isDatabaseSyncSupported && hasCompletedOnboarding && !updateRequired && (!isWaitingForProfile || isProfileLoaded) && (
                        <EmbeddingIndexStatusButton />
                    )}
                    {/* Database status for users with databaseSync */}
                    {isDatabaseSyncSupported && hasCompletedOnboarding && !updateRequired && (!isWaitingForProfile || isProfileLoaded) && (
                        <DatabaseStatusButton />
                    )}
                    {/* Open in separate window */}
                    {!isWindow && hasCompletedOnboarding && !updateRequired && (!isWaitingForProfile || isProfileLoaded) && (
                        <Tooltip content="Open in Separate Window" secondaryContent={openWindowShortcut} showArrow singleLine>
                            <IconButton
                                icon={Share05Icon}
                                onClick={openBeaverWindow}
                                className="scale-13"
                                ariaLabel="Open in Separate Window"
                            />
                        </Tooltip>
                    )}
                    {/* User account menu */}
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
