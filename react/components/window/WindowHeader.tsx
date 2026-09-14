import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { currentThreadIdAtom, currentThreadNameAtom } from '@beaver/agent-core/run-state/atoms';
import { isAuthenticatedAtom } from '../../atoms/auth';
import { toggleWindowNavAtom, windowNavCollapsedAtom } from '../../atoms/windowLayout';
import { SidebarLeftIcon } from '../icons/icons';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import ThreadMenuButton from '../ui/buttons/ThreadMenuButton';
import HeaderTrailingActions from '../HeaderTrailingActions';

interface WindowHeaderProps {
    /**
     * Whether a chat is on screen. Decides the sidebar toggle and the title
     * together, so the two cannot disagree.
     */
    showChat: boolean;
}

/**
 * The separate window's header: the sidebar toggle, the open chat's title and
 * its actions on the left, the account on the right. The sidebar itself is
 * not part of it.
 */
const WindowHeader: React.FC<WindowHeaderProps> = ({ showChat }) => {
    const collapsed = useAtomValue(windowNavCollapsedAtom);
    const toggleNav = useSetAtom(toggleWindowNavAtom);
    const threadId = useAtomValue(currentThreadIdAtom);
    // Kept current by the thread projection on every store snapshot, so a
    // rename lands here without another subscription.
    const threadName = useAtomValue(currentThreadNameAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);

    const title = threadId ? (threadName || 'Unnamed conversation') : 'New chat';

    return (
        <header id="beaver-window-header" className="beaver-window-header">
            <div className="beaver-window-header-lead">
                {showChat && (
                    <>
                        <Tooltip content={collapsed ? 'Show sidebar' : 'Hide sidebar'} showArrow singleLine>
                            <IconButton
                                icon={SidebarLeftIcon}
                                onClick={() => toggleNav()}
                                className="scale-14"
                                ariaLabel={collapsed ? 'Show sidebar' : 'Hide sidebar'}
                                ariaPressed={!collapsed}
                            />
                        </Tooltip>
                        <div className="beaver-window-header-title-group">
                            <h1 className="beaver-window-header-title" title={title}>{title}</h1>
                            {threadId && (
                                <ThreadMenuButton className="scale-14 beaver-window-header-thread-menu" ariaLabel="Chat actions" inWindow />
                            )}
                        </div>
                    </>
                )}
            </div>

            {isAuthenticated && (
                <div className="beaver-window-header-trail">
                    <HeaderTrailingActions />
                </div>
            )}
        </header>
    );
};

export default WindowHeader;
