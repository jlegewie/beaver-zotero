import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { logger } from '@beaver/agent-core/platform/logger';
import { closeWSConnectionAtom } from '../atoms/agentRunAtoms';

/**
 * Stop the active run: cancel it on the server and leave it locally. Clears
 * every pending approval, question, confirmation and batch card, so a panel
 * that offers Stop unmounts with it. `source` names the control in the log.
 */
export function useStopRun(source: string): () => void {
    const closeWSConnection = useSetAtom(closeWSConnectionAtom);
    return useCallback(() => {
        logger(`${source}: Stopping run`);
        void closeWSConnection();
    }, [closeWSConnection, source]);
}
