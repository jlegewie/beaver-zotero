/**
 * Hook that listens for "loadThread" events dispatched by the zotero://beaver
 * protocol handler and loads the requested thread in the sidebar.
 */

import { useAtomValue, useSetAtom } from 'jotai';
import { userAtom } from '../atoms/auth';
import { loadThreadAtom, pendingScrollToRunAtom } from '../atoms/threads';
import { eventManager } from '../events/eventManager';
import { useEventSubscription } from './useEventSubscription';
import { logger } from '../../src/utils/logger';

export function useThreadProtocolHandler() {
    const user = useAtomValue(userAtom);
    const loadThread = useSetAtom(loadThreadAtom);
    const setPendingScrollToRun = useSetAtom(pendingScrollToRunAtom);

    useEventSubscription('loadThread', (detail) => {
        const { threadId, runId } = detail;

        if (!user) {
            logger('useThreadProtocolHandler: No authenticated user, ignoring loadThread event');
            return;
        }

        logger(`useThreadProtocolHandler: Loading thread ${threadId}${runId ? ` / run ${runId}` : ''}`);

        // Open the sidebar
        eventManager.dispatch('toggleChat', { forceOpen: true });

        // Set scroll target before loading so ThreadView can pick it up
        if (runId) {
            setPendingScrollToRun(runId);
        }

        // Load the thread
        loadThread({ user_id: user.id, threadId });
    }, [user, loadThread, setPendingScrollToRun]);
}
