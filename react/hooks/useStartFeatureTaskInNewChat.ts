import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { startFeatureTaskAtom } from '../atoms/featureCredits';
import { newThreadAtom } from '../atoms/threads';
import { eventManager } from '../events/eventManager';

/**
 * Starts a feature-credit task from outside the chat (Plan & Usage, a release
 * note): opens this window's chat on a new thread, whose home screen shows the
 * task's setup card, and stages its action there. Does nothing when the user
 * cancels leaving the current chat.
 */
export function useStartFeatureTaskInNewChat(): (key: string) => Promise<void> {
    const startTask = useSetAtom(startFeatureTaskAtom);
    const newThread = useSetAtom(newThreadAtom);
    return useCallback(async (key: string) => {
        eventManager.dispatch('toggleChat', { forceOpen: true });
        if ((await newThread({})) === undefined) return;
        startTask({ key });
    }, [newThread, startTask]);
}
