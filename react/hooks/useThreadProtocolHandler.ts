/**
 * Hook that listens for "loadThread" events dispatched by the zotero://beaver
 * protocol handler and loads the requested thread in the sidebar.
 */

import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { userAtom } from '../atoms/auth';
import { loadThreadAtom, pendingScrollToRunAtom } from '../atoms/threads';
import { eventManager } from '../events/eventManager';
import { useEventSubscription } from './useEventSubscription';
import { logger } from '../../src/utils/logger';

interface PendingProtocolTarget {
    threadId: string;
    runId?: string;
}

export function useThreadProtocolHandler() {
    const user = useAtomValue(userAtom);
    const loadThread = useSetAtom(loadThreadAtom);
    const setPendingScrollToRun = useSetAtom(pendingScrollToRunAtom);
    const pendingTargetRef = useRef<PendingProtocolTarget | null>(null);

    const loadTargetThread = (threadId: string, userId: string, runId?: string) => {
        logger(`useThreadProtocolHandler: Loading thread ${threadId}${runId ? ` / run ${runId}` : ''}`);

        // Set scroll target before loading so ThreadView can pick it up
        if (runId) {
            setPendingScrollToRun(runId);
        }

        // Load the thread
        loadThread({ user_id: userId, threadId });
    };

    useEventSubscription('loadThread', (detail) => {
        const { threadId, runId } = detail;

        // Always open Beaver, even when the user is logged out.
        eventManager.dispatch('toggleChat', { forceOpen: true });

        if (!user) {
            pendingTargetRef.current = { threadId, runId };
            logger('useThreadProtocolHandler: No authenticated user, opening sidebar and deferring thread load');
            return;
        }

        loadTargetThread(threadId, user.id, runId);
    }, [user, loadThread, setPendingScrollToRun]);

    useEffect(() => {
        if (!user || !pendingTargetRef.current) return;

        const { threadId, runId } = pendingTargetRef.current;
        pendingTargetRef.current = null;
        logger(`useThreadProtocolHandler: Resuming deferred thread load ${threadId}${runId ? ` / run ${runId}` : ''}`);
        loadTargetThread(threadId, user.id, runId);
    }, [user, loadThread, setPendingScrollToRun]);
}
