import { useCallback, useEffect } from 'react';
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

    const refresh = useCallback(async () => {
        if (
            options.onlyWhenEnabled
            && getPref('backgroundProcessingEnabled') !== true
        ) return;
        if (!Zotero.Beaver?.db) return;
        try {
            const { queue, ledger, failures, coverage, documentCache } =
                await collectProcessingStatus(
                    { hasOcrAccess, hasSearchIndexAccess: hasSearchAccess },
                    {
                        includeCoverage: options.includeCoverage,
                        includeFailures: options.includeFailures,
                    },
                );
            setStatus((previous) => ({
                queue,
                ledger,
                coverage: coverage === undefined ? previous.coverage : coverage,
                failures: failures ?? previous.failures,
                documentCache: documentCache ?? previous.documentCache,
                error: null,
                updatedAt: Date.now(),
            }));
        } catch (error) {
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
        void refresh();
        const timer = setInterval(
            () => void refresh(),
            options.pollIntervalMs ?? 5_000,
        );
        return () => clearInterval(timer);
    }, [options.pollIntervalMs, refresh]);

    return refresh;
}
