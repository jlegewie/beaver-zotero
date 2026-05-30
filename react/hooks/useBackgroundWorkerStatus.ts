import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { isBackgroundWorkerRunningAtom } from '../atoms/backgroundExtraction';
import { eventManager } from '../events/eventManager';

/**
 * Mirror the esbuild-side background extractor activity into Jotai state.
 */
export function useBackgroundWorkerStatus() {
    const setIsRunning = useSetAtom(isBackgroundWorkerRunningAtom);

    useEffect(() => {
        setIsRunning(
            Zotero.Beaver?.backgroundExtractor?.getStatus?.().running ?? false,
        );

        return eventManager.subscribe('background-worker:status', (detail) => {
            setIsRunning(detail.running);
        });
    }, [setIsRunning]);
}
