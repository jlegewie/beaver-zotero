import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { useEffect } from 'react';
import {
    cancelScheduledResume,
    scheduleResumeAfterRun,
} from '../../src/services/syncPause';
import { isWSChatPendingAtom } from '../atoms/agentRunAtoms';
import { getWindowRuntime } from '../runtime/windowRuntime';
import { store } from '../store';

/** Release Zotero sync suppression when mutating agent runs finish. */
export function useSyncSuppression(): void {
    useEffect(() => {
        const runtimeId = getWindowRuntime().id;
        let owner: string | undefined;
        const apply = () => {
            const runId = store.get(activeRunAtom)?.id;
            const next = runId ? `chat:${runtimeId}:${runId}` : undefined;
            if (owner && next !== owner) scheduleResumeAfterRun(owner);
            owner = next;
            if (!owner) return;
            if (store.get(isWSChatPendingAtom)) {
                cancelScheduledResume(owner);
            } else {
                scheduleResumeAfterRun(owner);
            }
        };

        const unsub = store.sub(isWSChatPendingAtom, apply);
        const unsubRun = store.sub(activeRunAtom, apply);
        apply();
        return () => {
            unsub();
            unsubRun();
            if (owner) scheduleResumeAfterRun(owner);
        };
    }, []);
}
