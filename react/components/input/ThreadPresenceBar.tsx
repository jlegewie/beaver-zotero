import {
    serverThreadBlockedAtom,
    threadConflictAtom,
} from "../../runtime/threadAdmission";
import React, { useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { otherThreadWriterAtom, threadDeletedAtom, threadHistoryStaleAtom } from '../../runtime/threadProjection';
import { currentThreadIdAtom, loadThreadAtom, newThreadAtom } from '../../atoms/threads';
import { userIdAtom } from '../../atoms/auth';
import { useSurfaceWindow } from '../../runtime/SurfaceWindowContext';
import { retryPendingRunIdAtom } from '../../atoms/agentRunAtoms';
import Button from '@beaver/agent-ui/primitives/Button';
import { Icon, ArrowUpRightIcon, DeleteIcon, PictureInPictureIcon, SyncIcon } from '../icons/icons';

/** Compact button sizing shared by the composer's docked bars. */
const BAR_BUTTON_STYLE: React.CSSProperties = { padding: '2px 8px', fontSize: '0.875rem' };

/**
 * Bar docked above the composer while this window cannot write to the open
 * chat: another window is responding in it, it was deleted, or its history
 * changed elsewhere and this window is still showing the old one. Each state
 * names the one thing that gets the user unstuck.
 *
 * Renders nothing while the window owns the chat; the caller does not need
 * to gate it.
 */
const ThreadPresenceBar: React.FC = () => {
    const surfaceWindow = useSurfaceWindow();
    const otherWriter = useAtomValue(otherThreadWriterAtom);
    const chatDeleted = useAtomValue(threadDeletedAtom);
    const serverBlocked = useAtomValue(serverThreadBlockedAtom);
    const conflict = useAtomValue(threadConflictAtom);
    // This window's own retry marks the chat busy while it waits for the
    // server to settle; the retry control already shows that progress.
    const retryPending = useAtomValue(retryPendingRunIdAtom) !== null;
    const historyStale = useAtomValue(threadHistoryStaleAtom);
    const viewerUserId = useAtomValue(userIdAtom);
    const viewerThreadId = useAtomValue(currentThreadIdAtom);
    const refreshThread = useSetAtom(loadThreadAtom);
    const newThread = useSetAtom(newThreadAtom);
    const [isRefreshing, setIsRefreshing] = useState(false);

    const handleGoToWindow = (e: React.FormEvent | React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!otherWriter) return;
        const target = Zotero.Beaver.runtime.resolveWindow(otherWriter.windowId);
        if (!target) return;
        target.hostWindow.focus();
        target.hostWindow.__beaverEventBus?.dispatchEvent(
            new target.hostWindow.CustomEvent('toggleChat', { detail: { forceOpen: true } }),
        );
    };

    const handleRefresh = async (e: React.FormEvent | React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!viewerUserId || !viewerThreadId || isRefreshing) return;
        setIsRefreshing(true);
        try {
            await refreshThread({ user_id: viewerUserId, threadId: viewerThreadId, preserveDraft: true, window: surfaceWindow });
        } finally {
            setIsRefreshing(false);
        }
    };

    const handleNewChat = (e: React.FormEvent | React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        newThread({ window: surfaceWindow });
    };

    // Deletion wins: it blocks every viewer regardless of who was writing.
    let content: React.ReactNode;
    if (chatDeleted) {
        content = (
            <>
                <Icon icon={DeleteIcon} className="font-color-secondary flex-none" size={15} />
                <span className="font-color-primary text-sm truncate">
                    This chat was deleted
                </span>
                <div className="flex-1" />
                <Button variant="outline" onClick={handleNewChat} style={BAR_BUTTON_STYLE}>
                    New chat
                </Button>
            </>
        );
    } else if (otherWriter) {
        content = (
            <>
                <Icon icon={PictureInPictureIcon} className="font-color-secondary flex-none" size={15} />
                <span className="font-color-primary text-sm truncate">
                    Responding in another window
                </span>
                <div className="flex-1" />
                <Button variant="outline" rightIcon={ArrowUpRightIcon} onClick={handleGoToWindow} style={BAR_BUTTON_STYLE}>
                    Go to window
                </Button>
            </>
        );
    } else if (serverBlocked && !retryPending) {
        content = (
            <span className="font-color-primary text-sm">
                A response is still running in this chat
            </span>
        );
    } else if (historyStale || conflict) {
        content = (
            <>
                <Icon
                    icon={SyncIcon}
                    className="font-color-secondary flex-none"
                    size={12}
                />
                <span className="font-color-primary text-sm truncate">
                    This chat was updated in another window
                </span>
                <div className="flex-1" />
                <Button
                    variant="outline"
                    onClick={(e) => {
                        void handleRefresh(e);
                    }}
                    disabled={!viewerUserId || !viewerThreadId}
                    loading={isRefreshing}
                    style={BAR_BUTTON_STYLE}
                >
                    Refresh
                </Button>
            </>
        );
    } else {
        return null;
    }

    return (
        <div className="composer-docked-bar thread-presence-bar display-flex flex-row items-center px-3 py-2 gap-2" role="status">
            {content}
        </div>
    );
};

export default ThreadPresenceBar;
