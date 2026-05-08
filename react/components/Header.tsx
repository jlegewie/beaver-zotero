import React, { useRef, useCallback } from 'react';
import { CancelIcon, PlusSignIcon, PictureInPictureIcon, ChattingIcon } from './icons/icons';
import DatabaseStatusButton from './ui/buttons/DatabaseStatusButton';
import EmbeddingIndexStatusButton from './ui/buttons/EmbeddingIndexStatusButton';
import { triggerToggleChat } from '../../src/ui/toggleChat';
import { openBeaverWindow } from '../../src/ui/openBeaverWindow';
import { newThreadAtom } from '../atoms/threads';
import { currentThreadIdAtom, runsCountAtom } from '../agents/atoms';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import IconButton from './ui/IconButton';
import Tooltip from './ui/Tooltip';
import { isAuthenticatedAtom, isWaitingForProfileAtom } from '../atoms/auth';
import { isThreadListViewAtom } from '../atoms/ui';
import UserAccountMenuButton from './ui/buttons/UserAccountMenuButton';
import DevToolsMenuButton from './ui/buttons/DevToolsMenuButton';
import ThreadMenuButton from './ui/buttons/ThreadMenuButton';
import { hasCompletedOnboardingAtom, isDatabaseSyncSupportedAtom, updateRequiredAtom, isProfileLoadedAtom, profileSyncStatusAtom } from '../atoms/profile';
import { isFirstRunVisibleAtom } from '../atoms/firstRun';
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
    const threadId = useAtomValue(currentThreadIdAtom);
    const [isThreadListView, setIsThreadListView] = useAtom(isThreadListViewAtom);
    const isFirstRunVisible = useAtomValue(isFirstRunVisibleAtom);
    const profileSyncStatus = useAtomValue(profileSyncStatusAtom);
    const closeButtonRef = useRef<HTMLButtonElement>(null);

    // Reconnecting / sync-issue indicator: only shown after the profile is loaded
    // (cold-start covered by ProfileLoadingPage). Visible for both transient retries
    // and fatal non-transient errors.
    const showReconnectingIndicator = isAuthenticated && isProfileLoaded && profileSyncStatus.kind !== 'ok';
    const reconnectingTooltip =
        profileSyncStatus.kind === 'transient' && profileSyncStatus.offline
            ? "You're offline"
            : profileSyncStatus.kind === 'transient'
                ? `Reconnecting…${profileSyncStatus.attempt > 1 ? ` (attempt ${profileSyncStatus.attempt + 1})` : ''}`
                : profileSyncStatus.kind === 'fatal'
                    ? 'Profile sync issue'
                    : '';

    const handleNewThread = async () => {
        setIsThreadListView(false);
        await newThread();
    }

    const handleClose = useCallback(() => {
        setIsThreadListView(false);
        if (isWindow) {
            // Get the actual window where the button is rendered, not the main window
            const currentWindow = getWindowFromElement(closeButtonRef.current);
            currentWindow.close();
        } else {
            triggerToggleChat(Zotero.getMainWindow());
        }
    }, [isWindow, setIsThreadListView]);

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
                {isAuthenticated && hasCompletedOnboarding && !updateRequired && (!isWaitingForProfile || isProfileLoaded) && !isFirstRunVisible && (
                    <>
                    <Tooltip content="Chat history" showArrow singleLine>
                        <IconButton
                            icon={ChattingIcon}
                            onClick={() => setIsThreadListView(!isThreadListView)}
                            className={`scale-14 ${isThreadListView ? 'thread-list-toggle-active' : ''}`}
                            ariaLabel="Show chat history"
                        />
                    </Tooltip>
                    <Tooltip content="New chat" secondaryContent={newChatShortcut} showArrow singleLine>
                        <IconButton
                            icon={PlusSignIcon}
                            onClick={handleNewThread}
                            className="scale-14"
                            ariaLabel="New chat"
                            disabled={runsCount === 0}
                        />
                    </Tooltip>
                    </>
                )}
            </div>

            {/* Right side: Current Context & Global Actions */}
            {isAuthenticated && (
                <div className="display-flex gap-4 items-center">
                    {/* Reconnecting indicator: subtle dot shown while a profile refresh is failing
                        or the browser reports offline. Hidden during initial load and on success. */}
                    {showReconnectingIndicator && (
                        <Tooltip content={reconnectingTooltip} showArrow singleLine>
                            <div
                                aria-label={reconnectingTooltip}
                                className="reconnecting-indicator"
                                style={{
                                    width: 8,
                                    height: 8,
                                    borderRadius: 8,
                                    backgroundColor: 'var(--color-yellow-50, #d9a300)',
                                    opacity: 0.8,
                                }}
                            />
                        </Tooltip>
                    )}
                    {/* Embedding index status for users without databaseSync */}
                    {!isDatabaseSyncSupported && hasCompletedOnboarding && !updateRequired && (!isWaitingForProfile || isProfileLoaded) && !isFirstRunVisible && (
                        <EmbeddingIndexStatusButton />
                    )}
                    {/* Database status for users with databaseSync */}
                    {isDatabaseSyncSupported && hasCompletedOnboarding && !updateRequired && (!isWaitingForProfile || isProfileLoaded) && !isFirstRunVisible && (
                        <DatabaseStatusButton />
                    )}
                    {/* Development tools */}
                    {process.env.NODE_ENV === 'development' && (
                        <DevToolsMenuButton
                            className="scale-14"
                            ariaLabel="Development tools"
                            currentMessageContent={currentMessageContent}
                        />
                    )}
                    {threadId && !isFirstRunVisible && (
                        <ThreadMenuButton
                            className="scale-14"
                            ariaLabel="Chat actions"
                        />
                    )}
                    {/* Open in separate window */}
                    {!isWindow && hasCompletedOnboarding && !updateRequired && (!isWaitingForProfile || isProfileLoaded) && !isFirstRunVisible && (
                        <Tooltip content="Open in separate window" secondaryContent={openWindowShortcut} showArrow singleLine>
                            <IconButton
                                icon={PictureInPictureIcon}
                                onClick={openBeaverWindow}
                                className="scale-14"
                                ariaLabel="Open in separate window"
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
