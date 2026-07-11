import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import {
    hasSearchIndexAccessAtom,
    libraryScopeInitializedAtom,
    localZoteroLibrariesAtom,
    searchableLibraryIdsAtom,
} from '../atoms/profile';
import { purgeExcludedLibraries } from '../../src/services/backgroundProcessing/exclusionCleanup';
import { logger } from '../../src/utils/logger';

const EXCLUDED_LIBRARY_CLEANUP_RETRY_MS = 15 * 60_000;

/**
 * Schedule excluded-library cleanup whenever the searchable scope changes,
 * retrying until every excluded library's purge verifiably finished.
 */
export function useBackgroundProcessingScopeCleanup(): void {
    const initialized = useAtomValue(libraryScopeInitializedAtom);
    const libraries = useAtomValue(localZoteroLibrariesAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const hasSearchAccess = useAtomValue(hasSearchIndexAccessAtom);
    const allKey = libraries.map((library) => library.library_id).sort((a, b) => a - b).join(',');
    const searchableKey = [...searchableLibraryIds].sort((a, b) => a - b).join(',');

    useEffect(() => {
        if (!initialized) return;
        let cancelled = false;
        const searchable = new Set(searchableLibraryIds);
        const excludedIds = libraries
            .map((library) => library.library_id)
            .filter((libraryId) => !searchable.has(libraryId));
        if (excludedIds.length === 0) return;

        let running = false;
        const completed = new Set<number>();
        let timer: ReturnType<typeof setInterval> | null = null;
        const run = () => {
            if (running || cancelled) return;
            const pending = excludedIds.filter((libraryId) => !completed.has(libraryId));
            if (pending.length === 0) {
                if (timer) clearInterval(timer);
                timer = null;
                return;
            }
            running = true;
            void purgeExcludedLibraries(pending, hasSearchAccess, () => cancelled)
                .then((finished) => {
                    for (const libraryId of finished) completed.add(libraryId);
                })
                .catch((error) => logger(`Background scope cleanup failed: ${error}`, 1))
                .finally(() => {
                    running = false;
                    if (completed.size === excludedIds.length && timer) {
                        clearInterval(timer);
                        timer = null;
                    }
                });
        };
        run();
        timer = setInterval(run, EXCLUDED_LIBRARY_CLEANUP_RETRY_MS);
        return () => {
            cancelled = true;
            if (timer) clearInterval(timer);
        };
    }, [allKey, hasSearchAccess, initialized, searchableKey]);
}
