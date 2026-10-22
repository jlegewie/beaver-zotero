import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { wsReconnectingAtom, type ReconnectState } from '@beaver/agent-core/run-state/atoms';
import { msUntilReconnectPhaseChange, reconnectPhase } from '@beaver/agent-core/run-state/runStatusCopy';
import { isRunReconnectingAtom } from '../atoms/agentRunAtoms';

/**
 * The reconnect to show, or null while there is none or it is still a blip
 * too brief to mention. Re-renders whenever its phase changes, so copy from
 * `runStatusText` appears and escalates on time.
 *
 * Only for what the user sees: controls a reconnect makes unsafe are gated on
 * `isRunReconnectingAtom`, which turns on at once.
 */
export function useVisibleReconnect(): ReconnectState | null {
    const reconnect = useAtomValue(wsReconnectingAtom);
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (!reconnect) return;
        const delay = msUntilReconnectPhaseChange(reconnect, Date.now());
        if (delay === null) return;
        // A little past the boundary, so the re-render lands in the new phase.
        const timer = setTimeout(() => setTick((value) => value + 1), delay + 20);
        return () => clearTimeout(timer);
    }, [reconnect, tick]);
    return reconnect && reconnectPhase(reconnect, Date.now()) !== 'hidden' ? reconnect : null;
}

/** Whether the active run is reconnecting and has been long enough to say so. */
export function useRunReconnectShown(): boolean {
    const isRunReconnecting = useAtomValue(isRunReconnectingAtom);
    const visible = useVisibleReconnect();
    return isRunReconnecting && visible !== null;
}
