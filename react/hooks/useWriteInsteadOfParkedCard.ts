import { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { openParkedRunAtom } from '@beaver/agent-core/run-state/parkedRun';
import { isThreadParkedAtom, setAsideParkedCardsAtom } from '../atoms/parkedRuns';

/**
 * For a takeover card of the parked run: set it aside so the composer shows,
 * to write a message instead of answering. Undefined for a card of a live
 * run, which offers Stop as before.
 */
export function useWriteInsteadOfParkedCard(toolCallId: string): (() => void) | undefined {
    const isParked = useAtomValue(isThreadParkedAtom);
    const isOpenCard = useAtomValue(openParkedRunAtom)?.toolCallIds.has(toolCallId) ?? false;
    const setSetAside = useSetAtom(setAsideParkedCardsAtom);
    const setAside = useCallback(() => {
        setSetAside((prev) => new Set([...prev, toolCallId]));
    }, [setSetAside, toolCallId]);
    return isParked && isOpenCard ? setAside : undefined;
}
