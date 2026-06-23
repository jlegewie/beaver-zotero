import { useEffect } from 'react';
import { isWSChatPendingAtom } from '../atoms/agentRunAtoms';
import { store } from '../store';
import {
    cancelScheduledResume,
    resumeSyncNow,
    scheduleResumeAfterRun,
} from '../../src/services/syncPause';

/** Release Zotero sync suppression when mutating agent runs finish. */
export function useSyncSuppression(): void {
    useEffect(() => {
        const apply = () => {
            if (store.get(isWSChatPendingAtom)) {
                cancelScheduledResume();
            } else {
                scheduleResumeAfterRun();
            }
        };

        const unsub = store.sub(isWSChatPendingAtom, apply);
        return () => {
            unsub();
            resumeSyncNow();
        };
    }, []);
}
