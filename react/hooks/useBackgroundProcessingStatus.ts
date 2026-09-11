import { useCallback, useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { hasOcrAccessAtom, hasSearchIndexAccessAtom } from '../atoms/profile';
import { backgroundProcessingStatusAtom } from '../atoms/backgroundProcessing';
import { collectProcessingStatus } from '../../src/services/backgroundProcessing/statusSnapshot';
import { getPref } from '../../src/utils/prefs';

export function useBackgroundProcessingStatus(options: {
    includeCoverage?: boolean;
    includeFailures?: boolean;
    onlyWhenEnabled?: boolean;
    pollIntervalMs?: number;
} = {}): () => Promise<void> {
    const hasSearchAccess = useAtomValue(hasSearchIndexAccessAtom);
    const hasOcrAccess = useAtomValue(hasOcrAccessAtom);
    const setStatus = useSetAtom(backgroundProcessingStatusAtom);
    const generation = useRef(0);

    const refresh = useCallback(async () => {
        const requestGeneration = ++generation.current;
        if (
            options.onlyWhenEnabled
            && getPref('backgroundProcessingEnabled') !== true
        ) return;
        if (!Zotero.Beaver?.db) return;
        try {
            const { queue, ledger, failures, issues, worker, coverage, documentCache } =
                await collectProcessingStatus(
                    { hasOcrAccess, hasSearchIndexAccess: hasSearchAccess },
                    {
                        includeCoverage: options.includeCoverage,
                        includeFailures: options.includeFailures,
                    },
                );
            if (requestGeneration !== generation.current) return;
            setStatus((previous) => ({
                queue,
                ledger,
                coverage: !hasSearchAccess ? null : coverage ?? previous.coverage,
                coverageUpdatedAt: !hasSearchAccess ? null : coverage ? Date.now() : previous.coverageUpdatedAt,
                coverageError: !hasSearchAccess ? null : coverage === null ? 'Could not check search coverage.' : coverage ? null : previous.coverageError,
                failures: failures ?? previous.failures,
                issues: issues ?? previous.issues,
                worker,
                documentCache,
                error: null,
                updatedAt: Date.now(),
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
        options.onlyWhenEnabled,
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
