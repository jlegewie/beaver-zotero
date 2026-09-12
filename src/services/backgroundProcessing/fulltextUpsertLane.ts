import { FulltextUpsertExecutor } from "../backgroundQueue/fulltextUpsertExecutor";
import { searchIndexApiClient } from "../searchIndex/searchIndexApiClient";
import { INDEX_RECONCILE_INTERVAL_MS } from "../backgroundProcessing/constants";
import { reconcileRemoteRefs } from "../backgroundProcessing/remoteRefsReconcile";
import { logger } from "@beaver/agent-core/platform/logger";

const INDEX_LANE_MAX_IN_FLIGHT = 2;
const UNTAG_REDRIVE_INTERVAL_MS = 6 * 60 * 60_000;

export function startFulltextUpsertLane(
    searchableLibraryIds: number[],
    hasAccess: boolean,
): () => Promise<void> {
    if (!hasAccess) return async () => {};
    let cancelled = false;
    const executor = new FulltextUpsertExecutor();
    const untagExecutor = new FulltextUpsertExecutor(
        searchIndexApiClient,
        "fulltext_untag",
    );
    const dispatcher = Zotero.Beaver.backgroundExtractor!;
    dispatcher.registerExecutor(executor, {
        maxInFlight: INDEX_LANE_MAX_IN_FLIGHT,
    });
    dispatcher.registerExecutor(untagExecutor, { maxInFlight: 1 });
    let sweeping = false;
    let sweep: Promise<void> | undefined;
    let redrive: Promise<unknown> | undefined;
    const runSweep = () => {
        if (cancelled || sweeping) return;
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
    const redriveUntags = () => {
        const db = Zotero.Beaver?.db;
        if (!db || cancelled || redrive) return;
        redrive = db
            .redriveDeadUntagJobs(Date.now(), 100)
            .then((count) => {
                if (count > 0) Zotero.Beaver?.backgroundExtractor?.notify();
            })
            .catch((error) =>
                logger(`Fulltext lane: untag redrive failed: ${error}`, 2),
            )
            .finally(() => {
                redrive = undefined;
            });
    };
    const redriveTimer = setTimeout(redriveUntags, 5_000);
    const redriveInterval = setInterval(
        redriveUntags,
        UNTAG_REDRIVE_INTERVAL_MS,
    );

    return async () => {
        cancelled = true;
        clearTimeout(initialTimer);
        clearInterval(sweepTimer);
        clearTimeout(redriveTimer);
        clearInterval(redriveInterval);
        Zotero.Beaver?.backgroundExtractor?.unregisterExecutor(
            executor.jobType,
            executor,
        );
        Zotero.Beaver?.backgroundExtractor?.unregisterExecutor(
            untagExecutor.jobType,
            untagExecutor,
        );
        await Promise.allSettled([sweep, redrive]);
    };
}
