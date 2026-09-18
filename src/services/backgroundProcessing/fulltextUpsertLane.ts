import { FulltextUpsertExecutor } from "../backgroundQueue/fulltextUpsertExecutor";
import { searchIndexApiClient } from "../searchIndex/searchIndexApiClient";
import { INDEX_RECONCILE_INTERVAL_MS } from "../backgroundProcessing/constants";
import { reconcileRemoteRefs } from "../backgroundProcessing/remoteRefsReconcile";
import { logger } from "@beaver/agent-core/platform/logger";

const INDEX_LANE_MAX_IN_FLIGHT = 2;
const CLEANUP_RESTORE_INTERVAL_MS = 6 * 60 * 60_000;

export function startFulltextUpsertLane(
    searchableLibraryIds: number[],
    hasAccess: boolean,
): () => Promise<void> {
    let cancelled = false;
    const executor = new FulltextUpsertExecutor();
    const untagExecutor = new FulltextUpsertExecutor(
        searchIndexApiClient,
        "fulltext_untag",
    );
    const dispatcher = Zotero.Beaver.backgroundExtractor!;
    if (hasAccess) dispatcher.registerExecutor(executor, {
        maxInFlight: INDEX_LANE_MAX_IN_FLIGHT,
    });
    dispatcher.registerExecutor(untagExecutor, { maxInFlight: 1, survivesLibraryExclusion: true });
    let sweeping = false;
    let sweep: Promise<void> | undefined;
    let restoration: Promise<unknown> | undefined;
    const runSweep = () => {
        if (cancelled || sweeping || !hasAccess) return;
        sweeping = true;
        sweep = reconcileRemoteRefs(searchableLibraryIds, () => cancelled)
            .catch((error) =>
                logger(`Fulltext ref reconcile failed: ${error}`, 2),
            )
            .finally(() => {
                sweeping = false;
            });
    };
    const initialTimer = setTimeout(runSweep, 2_000);
    const sweepTimer = setInterval(runSweep, INDEX_RECONCILE_INTERVAL_MS);
    const restoreCleanup = () => {
        const db = Zotero.Beaver?.db;
        if (!db || cancelled || restoration) return;
        const accountId = Zotero.Beaver?.account?.getSnapshot().session?.user.id;
        restoration = (accountId ? db.restoreIndexCleanup(accountId) : Promise.resolve(0))
            .then((count) => {
                if (count > 0) Zotero.Beaver?.backgroundExtractor?.notify();
            })
            .catch((error) =>
                logger(`Fulltext lane: untag restoration failed: ${error}`, 2),
            )
            .finally(() => {
                restoration = undefined;
            });
    };
    const restorationTimer = setTimeout(restoreCleanup, 5_000);
    const restorationInterval = setInterval(
        restoreCleanup,
        CLEANUP_RESTORE_INTERVAL_MS,
    );

    return async () => {
        cancelled = true;
        clearTimeout(initialTimer);
        clearInterval(sweepTimer);
        clearTimeout(restorationTimer);
        clearInterval(restorationInterval);
        Zotero.Beaver?.backgroundExtractor?.unregisterExecutor(
            executor.jobType,
            executor,
        );
        Zotero.Beaver?.backgroundExtractor?.unregisterExecutor(
            untagExecutor.jobType,
            untagExecutor,
        );
        await Promise.allSettled([sweep, restoration]);
    };
}
