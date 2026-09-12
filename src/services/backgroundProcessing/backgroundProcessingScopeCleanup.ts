import { purgeExcludedLibraries } from "../backgroundProcessing/exclusionCleanup";
import { logger } from "@beaver/agent-core/platform/logger";

const EXCLUDED_LIBRARY_CLEANUP_RETRY_MS = 15 * 60_000;

/**
 * Schedule excluded-library cleanup whenever the searchable scope changes,
 * retrying until every excluded library's purge verifiably finished.
 */
export function startBackgroundProcessingScopeCleanup(
    libraries: { library_id: number }[],
    searchableLibraryIds: number[],
    hasSearchAccess: boolean,
): () => Promise<void> {
    let cancelled = false;
    const searchable = new Set(searchableLibraryIds);
    const excludedIds = libraries
        .map((library) => library.library_id)
        .filter((libraryId) => !searchable.has(libraryId));
    if (excludedIds.length === 0) return async () => {};

    let running = false;
    let pending: Promise<void> | undefined;
    const completed = new Set<number>();
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => {
        if (running || cancelled) return;
        const pendingIds = excludedIds.filter(
            (libraryId) => !completed.has(libraryId),
        );
        if (pendingIds.length === 0) {
            if (timer) clearInterval(timer);
            timer = null;
            return;
        }
        running = true;
        pending = purgeExcludedLibraries(
            pendingIds,
            hasSearchAccess,
            () => cancelled,
        )
            .then((finished) => {
                for (const libraryId of finished) completed.add(libraryId);
            })
            .catch((error) =>
                logger(`Background scope cleanup failed: ${error}`, 1),
            )
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
    return async () => {
        cancelled = true;
        if (timer) clearInterval(timer);
        await pending;
    };
}
