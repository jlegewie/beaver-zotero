import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { currentThreadIdAtom, currentThreadNameAtom } from '@beaver/agent-core/run-state/atoms';
import { threadEntitiesAtom } from '../../atoms/threadList';
import { isAuthenticatedAtom, isWaitingForProfileAtom } from '../../atoms/auth';
import {
    hasCompletedOnboardingAtom,
    isDatabaseSyncSupportedAtom,
    isProfileLoadedAtom,
    profileSyncStatusAtom,
    updateRequiredAtom,
} from '../../atoms/profile';
import { isFirstRunVisibleAtom } from '../../atoms/firstRun';
import { currentMessageContentAtom } from '../../atoms/messageComposition';
import { toggleWindowNavAtom, windowNavCollapsedAtom } from '../../atoms/windowLayout';
import { SidebarLeftIcon } from '../icons/icons';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import ThreadMenuButton from '../ui/buttons/ThreadMenuButton';
import UserAccountMenuButton from '../ui/buttons/UserAccountMenuButton';
import DevToolsMenuButton from '../ui/buttons/DevToolsMenuButton';
import EmbeddingIndexStatusButton from '../ui/buttons/EmbeddingIndexStatusButton';
import DatabaseStatusButton from '../ui/buttons/DatabaseStatusButton';

interface WindowHeaderProps {
    /** Whether the sidebar toggle is offered. Off on the pages that have no history to show. */
    showNavToggle: boolean;
}

/**
 * The separate window's header: the sidebar toggle, the open chat's title and
 * its actions on the left, the account on the right. The sidebar itself is
 * not part of it.
 */
const WindowHeader: React.FC<WindowHeaderProps> = ({ showNavToggle }) => {
    const collapsed = useAtomValue(windowNavCollapsedAtom);
    const toggleNav = useSetAtom(toggleWindowNavAtom);
    const threadId = useAtomValue(currentThreadIdAtom);
    const threadName = useAtomValue(currentThreadNameAtom);
    const entities = useAtomValue(threadEntitiesAtom);
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const isWaitingForProfile = useAtomValue(isWaitingForProfileAtom);
    const isProfileLoaded = useAtomValue(isProfileLoadedAtom);
    const hasCompletedOnboarding = useAtomValue(hasCompletedOnboardingAtom);
    const isDatabaseSyncSupported = useAtomValue(isDatabaseSyncSupportedAtom);
    const updateRequired = useAtomValue(updateRequiredAtom);
    const isFirstRunVisible = useAtomValue(isFirstRunVisibleAtom);
    const profileSyncStatus = useAtomValue(profileSyncStatusAtom);
    const currentMessageContent = useAtomValue(currentMessageContentAtom);

    // The open chat's name: the run state's copy first, then the history
    // store's (a rename lands there first), then a placeholder.
    const title = threadId
        ? (threadName || entities.get(threadId)?.name || 'Unnamed conversation')
        : 'New chat';

    const showStatus = hasCompletedOnboarding && !updateRequired && (!isWaitingForProfile || isProfileLoaded) && !isFirstRunVisible;
    const showReconnectingIndicator = isAuthenticated && isProfileLoaded && profileSyncStatus.kind !== 'ok';
    const reconnectingTooltip =
        profileSyncStatus.kind === 'transient' && profileSyncStatus.offline
            ? "You're offline"
            : profileSyncStatus.kind === 'transient'
                ? `Reconnecting…${profileSyncStatus.attempt > 1 ? ` (attempt ${profileSyncStatus.attempt})` : ''}`
                : profileSyncStatus.kind === 'fatal'
                    ? 'Profile sync issue'
                    : '';

    return (
        <header id="beaver-window-header" className="beaver-window-header">
            <div className="beaver-window-header-lead">
                {showNavToggle && (
                    <Tooltip content={collapsed ? 'Show sidebar' : 'Hide sidebar'} showArrow singleLine>
                        <IconButton
                            icon={SidebarLeftIcon}
                            onClick={() => toggleNav()}
                            className="scale-14"
                            ariaLabel={collapsed ? 'Show sidebar' : 'Hide sidebar'}
                            ariaPressed={!collapsed}
                        />
                    </Tooltip>
                )}
                {isAuthenticated && showStatus && (
                    <div className="beaver-window-header-title-group">
                        <h1 className="beaver-window-header-title" title={title}>{title}</h1>
                        {threadId && (
                            <ThreadMenuButton className="scale-14 beaver-window-header-thread-menu" ariaLabel="Chat actions" inWindow />
                        )}
                    </div>
                )}
            </div>

            {isAuthenticated && (
                <div className="beaver-window-header-trail">
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
                    {showStatus && !isDatabaseSyncSupported && <EmbeddingIndexStatusButton />}
                    {showStatus && isDatabaseSyncSupported && <DatabaseStatusButton />}
                    {process.env.NODE_ENV === 'development' && (
                        <DevToolsMenuButton
                            className="scale-14"
                            ariaLabel="Development tools"
                            currentMessageContent={currentMessageContent}
                        />
                    )}
                    <UserAccountMenuButton className="scale-14" ariaLabel="Beaver settings" />
                </div>
            )}
        </header>
    );
};

export default WindowHeader;
