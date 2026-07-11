import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import {
    hasSearchIndexAccessAtom,
    libraryScopeInitializedAtom,
    searchableLibraryIdsAtom,
} from '../atoms/profile';
import { FulltextUpsertExecutor } from '../../src/services/backgroundQueue/fulltextUpsertExecutor';
import { searchIndexApiClient } from '../../src/services/searchIndex/searchIndexApiClient';
import { INDEX_RECONCILE_INTERVAL_MS } from '../../src/services/backgroundProcessing/constants';
import { reconcileRemoteRefs } from '../../src/services/backgroundProcessing/remoteRefsReconcile';
import { logger } from '../../src/utils/logger';

const INDEX_LANE_MAX_IN_FLIGHT = 2;
const UNTAG_REDRIVE_INTERVAL_MS = 6 * 60 * 60_000;

export function useFulltextUpsertLane(): void {
    const hasAccess = useAtomValue(hasSearchIndexAccessAtom);
    const scopeInitialized = useAtomValue(libraryScopeInitializedAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const scopeKey = scopeInitialized
        ? [...searchableLibraryIds].sort((a, b) => a - b).join(',')
        : null;

    useEffect(() => {
        if (!hasAccess || scopeKey === null) return;
        let cancelled = false;
        let registrationTimer: ReturnType<typeof setInterval> | null = null;
        const executor = new FulltextUpsertExecutor();
        const untagExecutor = new FulltextUpsertExecutor(
            searchIndexApiClient,
            'fulltext_untag',
        );
        const register = () => {
            const dispatcher = Zotero.Beaver?.backgroundExtractor;
            if (!dispatcher) return false;
            dispatcher.registerExecutor(executor, { maxInFlight: INDEX_LANE_MAX_IN_FLIGHT });
            dispatcher.registerExecutor(untagExecutor, { maxInFlight: 1 });
            return true;
        };
        if (!register()) {
            registrationTimer = setInterval(() => {
                if (cancelled) return;
                if (register() && registrationTimer) {
                    clearInterval(registrationTimer);
                    registrationTimer = null;
                }
            }, 1_000);
        }

        const runSweep = () => void reconcileRemoteRefs(searchableLibraryIds, () => cancelled)
            .catch((error) => logger(`useFulltextUpsertLane: ref reconcile failed: ${error}`, 2));
        const initialTimer = setTimeout(runSweep, 2_000);
        const sweepTimer = setInterval(runSweep, INDEX_RECONCILE_INTERVAL_MS);
        const redriveUntags = () => {
            const db = Zotero.Beaver?.db;
            if (!db) return;
            void db.redriveDeadUntagJobs(Date.now(), 100)
            .then((count) => {
                if (count > 0) Zotero.Beaver?.backgroundExtractor?.notify();
            })
            .catch((error) => logger(`useFulltextUpsertLane: untag redrive failed: ${error}`, 2));
        };
        const redriveTimer = setTimeout(redriveUntags, 5_000);
        const redriveInterval = setInterval(redriveUntags, UNTAG_REDRIVE_INTERVAL_MS);

        return () => {
            cancelled = true;
            clearTimeout(initialTimer);
            clearInterval(sweepTimer);
            clearTimeout(redriveTimer);
            clearInterval(redriveInterval);
            if (registrationTimer) clearInterval(registrationTimer);
            Zotero.Beaver?.backgroundExtractor?.unregisterExecutor(
                executor.jobType,
                executor,
            );
            Zotero.Beaver?.backgroundExtractor?.unregisterExecutor(
                untagExecutor.jobType,
                untagExecutor,
            );
        };
    }, [hasAccess, scopeKey]);
}
