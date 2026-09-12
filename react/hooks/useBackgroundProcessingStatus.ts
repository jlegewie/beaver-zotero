import { useCallback, useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { hasOcrAccessAtom, hasSearchIndexAccessAtom } from '../atoms/profile';
import { backgroundProcessingStatusAtom } from '../atoms/backgroundProcessing';

export function useBackgroundProcessingStatus(options: {
    includeCoverage?: boolean;
    includeFailures?: boolean;
    pollIntervalMs?: number;
} = {}): () => Promise<void> {
    const hasSearchAccess = useAtomValue(hasSearchIndexAccessAtom);
    // Entitlement changes restart polling immediately with the new instance flags.
    const hasOcrAccess = useAtomValue(hasOcrAccessAtom);
    const setStatus = useSetAtom(backgroundProcessingStatusAtom);
    const generation = useRef(0);

    const refresh = useCallback(async () => {
        const requestGeneration = ++generation.current;
        if (!Zotero.Beaver?.db) return;
        try {
            const result = await Zotero.Beaver.background!.collectStatus({
                includeCoverage: options.includeCoverage,
                includeFailures: options.includeFailures,
                });
            if (requestGeneration !== generation.current || !result) return;
            const { queue, ledger, failures, issues, worker, coverage, documentCache } = result;
            const updatedAt = Date.now();
            setStatus((previous) => ({
                queue,
                ledger,
                coverage: !hasSearchAccess ? null : coverage ?? previous.coverage,
                coverageUpdatedAt: !hasSearchAccess ? null : coverage ? updatedAt : previous.coverageUpdatedAt,
                coverageError: !hasSearchAccess ? null : coverage === null ? 'Could not check search coverage.' : coverage ? null : previous.coverageError,
                failures: failures ?? previous.failures,
                issues: issues ?? previous.issues,
                // Only invalidate expanded issue pages when their counts were refreshed.
                issuesUpdatedAt: issues === undefined ? previous.issuesUpdatedAt : updatedAt,
                worker,
                documentCache,
                error: null,
                updatedAt,
            }));
        } catch (error) {
            if (requestGeneration !== generation.current) return;
            setStatus((previous) => ({
                ...previous,
                error: error instanceof Error ? error.message : String(error),
                updatedAt: Date.now(),
            }));
        }
    }, [
        hasOcrAccess,
        hasSearchAccess,
        options.includeCoverage,
        options.includeFailures,
        setStatus,
    ]);

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
            await refresh();
            // A slow remote status check must finish before the next poll;
            // overlapping polls would continually discard each other's results.
            if (!cancelled) timer = setTimeout(() => void poll(), options.pollIntervalMs ?? 5_000);
        };
        void poll();
        return () => {
            cancelled = true;
            generation.current++;
            if (timer !== undefined) clearTimeout(timer);
        };
    }, [options.pollIntervalMs, refresh]);

    return refresh;
}
