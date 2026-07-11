import { useCallback, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { hasOcrAccessAtom, hasSearchIndexAccessAtom } from '../atoms/profile';
import { backgroundProcessingStatusAtom } from '../atoms/backgroundProcessing';
import { searchIndexApiClient } from '../../src/services/searchIndex/searchIndexApiClient';
import { getZoteroUserIdentifier } from '../../src/utils/zoteroUtils';
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
        const db = Zotero.Beaver?.db;
        if (!db) return;
        try {
            const [queue, ledger, failures, coverage] = await Promise.all([
                db.getBackgroundQueueStats(Date.now()),
                db.getAttachmentProcessingAggregates(undefined, {
                    ocr: hasOcrAccess || hasSearchAccess,
                    upsert: hasSearchAccess,
                }),
                options.includeFailures
                    ? db.getBackgroundProcessingFailures(50)
                    : Promise.resolve(undefined),
                options.includeCoverage && hasSearchAccess
                    ? searchIndexApiClient.status(getZoteroUserIdentifier().localUserKey)
                        .catch(() => null)
                    : Promise.resolve(undefined),
            ]);
            setStatus((previous) => ({
                queue,
                ledger,
                coverage: coverage === undefined ? previous.coverage : coverage,
                failures: failures ?? previous.failures,
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
