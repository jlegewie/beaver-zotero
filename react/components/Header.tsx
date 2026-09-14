import { useSurfaceWindow } from '../runtime/SurfaceWindowContext';
import React, { useRef, useCallback } from 'react';
import { CancelIcon, PlusSignIcon, PictureInPictureIcon, ChattingIcon } from './icons/icons';
import { triggerToggleChat } from '../../src/ui/toggleChat';
import { openBeaverWindow } from '../ui/openBeaverWindow';
import { newThreadAtom } from '../atoms/threads';
import { currentThreadIdAtom, runsCountAtom } from '@beaver/agent-core/run-state/atoms';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { isAuthenticatedAtom } from '../atoms/auth';
import { isThreadListViewAtom } from '../atoms/ui';
import ThreadMenuButton from './ui/buttons/ThreadMenuButton';
import HeaderTrailingActions, { useShowHeaderStatus } from './HeaderTrailingActions';
import { isFirstRunVisibleAtom } from '../atoms/firstRun';
import { getWindowFromElement } from '@beaver/agent-ui/utils/windowContext';
import { getPref } from '../../src/utils/prefs';


interface HeaderProps {
    onClose?: () => void;
    isWindow?: boolean;
}

const Header: React.FC<HeaderProps> = ({ onClose, isWindow = false }) => {
    const surfaceWindow = useSurfaceWindow();
    const runsCount = useAtomValue(runsCountAtom);
    const newThread = useSetAtom(newThreadAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const showStatus = useShowHeaderStatus();
    const threadId = useAtomValue(currentThreadIdAtom);
    const [isThreadListView, setIsThreadListView] = useAtom(isThreadListViewAtom);
    const isFirstRunVisible = useAtomValue(isFirstRunVisibleAtom);
    const closeButtonRef = useRef<HTMLButtonElement>(null);

    const handleNewThread = async () => {
        setIsThreadListView(false);
        await newThread({ window: surfaceWindow });
    }

    const handleClose = useCallback(() => {
        setIsThreadListView(false);
        if (isWindow) {
            // Get the actual window where the button is rendered, not the main window
            const currentWindow = getWindowFromElement(closeButtonRef.current);
            currentWindow?.close();
        } else {
            triggerToggleChat(surfaceWindow);
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
                            ariaLabel="Close Beaver panel"
                        />
                    </Tooltip>
                )}

                {/* Chat history and new chat */}
                {isAuthenticated && showStatus && (
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
                    <HeaderTrailingActions>
                        {threadId && !isFirstRunVisible && (
                            <ThreadMenuButton
                                className="scale-14"
                                ariaLabel="Chat actions"
                            />
                        )}
                        {/* Open in separate window */}
                        {!isWindow && showStatus && (
                            <Tooltip content="Open in separate window" secondaryContent={openWindowShortcut} showArrow singleLine>
                                <IconButton
                                    icon={PictureInPictureIcon}
                                    onClick={() => openBeaverWindow()}
                                    className="scale-14"
                                    ariaLabel="Open in separate window"
                                />
                            </Tooltip>
                        )}
                    </HeaderTrailingActions>
                </div>
            )}
        </div>
    );
};

export default Header;
