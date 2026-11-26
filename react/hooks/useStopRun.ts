import { useCallback } from 'react';
import { atom, useAtomValue, useSetAtom } from 'jotai';
import { logger } from '@beaver/agent-core/platform/logger';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { closeWSConnectionAtom } from '../atoms/agentRunAtoms';

/** The id of the run the window shows; streamed text does not change it. */
const shownRunIdAtom = atom((get) => get(activeRunAtom)?.id ?? null);

/**
 * Stop the active run: cancel it on the server and leave it locally. Clears
 * every pending approval, question, confirmation and batch card, so a panel
 * that offers Stop unmounts with it. `source` names the control in the log.
 * The Stop names the run the control was rendered for, so it never stops a
 * run that has replaced it meanwhile.
 */
export function useStopRun(source: string): () => void {
    const shownRunId = useAtomValue(shownRunIdAtom);
    const closeWSConnection = useSetAtom(closeWSConnectionAtom);
    return useCallback(() => {
        logger(`${source}: Stopping run`);
        void closeWSConnection(shownRunId);
    }, [closeWSConnection, source, shownRunId]);
}
