import { useAtomValue } from 'jotai';
import { openParkedRunAtom } from '@beaver/agent-core/run-state/parkedRun';
import { isThreadParkedAtom } from '../atoms/parkedRuns';

/**
 * Whether a takeover card belongs to the thread's parked run and still waits
 * for its answer. Such a card has no run to stop, so it offers no Stop.
 */
export function useIsOpenParkedCard(toolCallId: string): boolean {
    const isParked = useAtomValue(isThreadParkedAtom);
    const isOpenCard = useAtomValue(openParkedRunAtom)?.toolCallIds.has(toolCallId) ?? false;
    return isParked && isOpenCard;
}
