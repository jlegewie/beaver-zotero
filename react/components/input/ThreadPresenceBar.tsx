import { admissionUnreachableAtom, describeAdmissionWait, refreshThreadAdmission } from "../../runtime/threadAdmission";
import { serverThreadBlockedAtom, threadAdmissionAtom, threadConflictAtom } from "../../../src/services/agentRuns/threadAdmission";
import React, { useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { threadDeletedAtom, threadHistoryStaleAtom } from '../../runtime/threadProjection';
import { currentThreadIdAtom, loadThreadAtom, newThreadAtom } from '../../atoms/threads';
import { userIdAtom } from '../../atoms/auth';
import { useSurfaceWindow } from '../../runtime/SurfaceWindowContext';
import { retryPendingRunIdAtom, stoppingPreviousRunAtom } from '../../atoms/agentRunAtoms';
import Button from '@beaver/agent-ui/primitives/Button';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import { Icon, AlertIcon, DeleteIcon, SyncIcon } from '../icons/icons';

/** Compact button sizing shared by the composer's docked bars. */
const BAR_BUTTON_STYLE: React.CSSProperties = { padding: '2px 8px', fontSize: '0.875rem' };

/**
 * What the bar says when the server refused a write to the chat: what
 * happened, so the user knows why a refresh is needed.
 */
function conflictMessage(conflict: string): string {
    switch (conflict) {
        case 'thread_tail_mismatch':
            return 'This chat has newer messages on the server';
        case 'thread_busy':
            return 'The server is still finishing a response in this chat';
        default:
            // The server lost the chat's reservation, or could not admit the
            // write: its history may differ from what is shown.
            return 'Refresh this chat to continue';
    }
}

/**
 * Bar docked above the composer while this window cannot write to the open
 * chat: it was deleted, the server has not settled a response in it, the
 * server refused a write, or its history changed elsewhere in this Zotero and
 * this window is still showing the old one. Each state names the one thing that
 * gets the user unstuck. It also explains a new message that waits for a
 * stopped response to end.
 *
 * Renders nothing while the window owns the chat; the caller does not need
 * to gate it.
 */
const ThreadPresenceBar: React.FC = () => {
    const surfaceWindow = useSurfaceWindow();
    const chatDeleted = useAtomValue(threadDeletedAtom);
    const serverBlocked = useAtomValue(serverThreadBlockedAtom);
    const admission = useAtomValue(threadAdmissionAtom);
    const unreachable = useAtomValue(admissionUnreachableAtom);
    const stoppingPrevious = useAtomValue(stoppingPreviousRunAtom);
    const conflict = useAtomValue(threadConflictAtom);
    // This window's own retry marks the chat busy while it waits for the
    // server to settle; the retry control already shows that progress,
    // unless the retry first had to stop a running response.
    const retryPending = useAtomValue(retryPendingRunIdAtom) !== null
        && admission?.reason !== 'stopping_previous';
    const historyStale = useAtomValue(threadHistoryStaleAtom);
    const viewerUserId = useAtomValue(userIdAtom);
    const viewerThreadId = useAtomValue(currentThreadIdAtom);
    const refreshThread = useSetAtom(loadThreadAtom);
    const newThread = useSetAtom(newThreadAtom);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isPolling, setIsPolling] = useState(false);

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

    // Read the server again now rather than at the next backoff step.
    const handleRetryReach = async (e: React.FormEvent | React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (isPolling) return;
        setIsPolling(true);
        try {
            await refreshThreadAdmission();
        } finally {
            setIsPolling(false);
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
    } else if (stoppingPrevious) {
        content = (
            <>
                <Spinner size={12} className="flex-none" />
                <span className="font-color-primary text-sm truncate">
                    Stopping the previous response…
                </span>
            </>
        );
    } else if (serverBlocked && unreachable && admission) {
        // Writes stay blocked; the poller keeps trying in the background and
        // the first answer restores the normal state.
        content = (
            <>
                <Icon icon={AlertIcon} className="font-color-secondary flex-none" size={15} />
                {/* Wraps rather than truncates: the advice is the point. */}
                <span className="font-color-primary text-sm min-w-0">
                    {describeAdmissionWait(admission, true)}
                </span>
                <div className="flex-1" />
                <Button
                    variant="outline"
                    onClick={(e) => {
                        void handleRetryReach(e);
                    }}
                    loading={isPolling}
                    style={BAR_BUTTON_STYLE}
                >
                    Refresh
                </Button>
            </>
        );
    } else if (serverBlocked && admission && !retryPending) {
        content = (
            <>
                <Spinner size={12} className="flex-none" />
                <span className="font-color-primary text-sm truncate">
                    {describeAdmissionWait(admission)}
                </span>
            </>
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
                    {conflict ? conflictMessage(conflict) : 'This chat was updated in another window'}
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
