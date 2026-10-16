import React from 'react';
import { useAtomValue } from 'jotai';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import EmbeddingIndexStatusButton from './ui/buttons/EmbeddingIndexStatusButton';
import UserAccountMenuButton from './ui/buttons/UserAccountMenuButton';
import DevToolsMenuButton from './ui/buttons/DevToolsMenuButton';
import { isAuthenticatedAtom, isWaitingForProfileAtom } from '../atoms/auth';
import {
    isProfileLoadedAtom,
    profileSyncStatusAtom,
    updateRequiredAtom,
} from '../atoms/profile';
import { isFirstRunVisibleAtom } from '../atoms/firstRun';
import { currentMessageContentAtom } from '../atoms/messageComposition';

/**
 * Whether the header shows its status controls: only once the profile has
 * arrived, outside the update and first-run pages.
 */
export function useShowHeaderStatus(): boolean {
    const updateRequired = useAtomValue(updateRequiredAtom);
    const isWaitingForProfile = useAtomValue(isWaitingForProfileAtom);
    const isProfileLoaded = useAtomValue(isProfileLoadedAtom);
    const isFirstRunVisible = useAtomValue(isFirstRunVisibleAtom);
    return !updateRequired && (!isWaitingForProfile || isProfileLoaded) && !isFirstRunVisible;
}

/**
 * Reconnecting / sync-issue indicator: a subtle dot shown while a profile
 * refresh is failing or the browser reports offline. Only after the profile is
 * loaded (cold start is covered by ProfileLoadingPage); visible for both
 * transient retries and fatal non-transient errors.
 */
const ReconnectingIndicator: React.FC = () => {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const isProfileLoaded = useAtomValue(isProfileLoadedAtom);
    const profileSyncStatus = useAtomValue(profileSyncStatusAtom);
    if (!isAuthenticated || !isProfileLoaded || profileSyncStatus.kind === 'ok') return null;

    const tooltip =
        profileSyncStatus.kind === 'transient' && profileSyncStatus.offline
            ? "You're offline"
            : profileSyncStatus.kind === 'transient'
                ? `Reconnecting…${profileSyncStatus.attempt > 1 ? ` (attempt ${profileSyncStatus.attempt})` : ''}`
                : 'Profile sync issue';

    return (
        <Tooltip content={tooltip} showArrow singleLine>
            <div
                aria-label={tooltip}
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
    );
};

interface HeaderTrailingActionsProps {
    /** Rendered between the status controls and the account menu. */
    children?: React.ReactNode;
}

/**
 * The right-hand end of a Beaver header: the reconnecting indicator, the search
 * index status, the development tools and the account menu. Shared by
 * the pane header and the separate window's header, which differ only in what
 * they slot in before the account menu.
 */
const HeaderTrailingActions: React.FC<HeaderTrailingActionsProps> = ({ children }) => {
    const currentMessageContent = useAtomValue(currentMessageContentAtom);
    const showStatus = useShowHeaderStatus();

    return (
        <>
            <ReconnectingIndicator />
            {showStatus && <EmbeddingIndexStatusButton />}
            {/* Development tools */}
            {process.env.NODE_ENV === 'development' && (
                <DevToolsMenuButton
                    className="scale-14"
                    ariaLabel="Development tools"
                    currentMessageContent={currentMessageContent}
                />
            )}
            {children}
            {/* User account menu */}
            <UserAccountMenuButton
                className="scale-14"
                ariaLabel="Beaver settings"
            />
        </>
    );
};

export default HeaderTrailingActions;
