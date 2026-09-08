import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { isBackgroundWorkerRunningAtom } from '../atoms/backgroundExtraction';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';

/**
 * Mirror the esbuild-side background extractor activity into Jotai state.
 */
export function useBackgroundWorkerStatus() {
    const setIsRunning = useSetAtom(isBackgroundWorkerRunningAtom);

    useEffect(() => {
        const runtime = tryGetWindowRuntime();
        if (!runtime) return;
        const unsubscribe = Zotero.Beaver.runtime.subscribeWindow(
            runtime, 'background-worker:status', detail => setIsRunning(detail.running),
        );
        setIsRunning(Zotero.Beaver?.backgroundExtractor?.getStatus?.().running ?? false);
        return unsubscribe;
    }, [setIsRunning]);
}
