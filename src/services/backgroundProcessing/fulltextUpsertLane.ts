import { FulltextUpsertExecutor } from "../backgroundQueue/fulltextUpsertExecutor";
import { searchIndexApiClient } from "../searchIndex/searchIndexApiClient";
import { INDEX_RECONCILE_INTERVAL_MS } from "../backgroundProcessing/constants";
import { reconcileRemoteRefs } from "../backgroundProcessing/remoteRefsReconcile";
import { logger } from "@beaver/agent-core/platform/logger";
import type { LaneCapacity } from "../backgroundExtractor";

/**
 * Concurrent cloud-index upserts. The backend rejects a user's upserts beyond
 * its own per-user in-flight guard and advertises that limit in
 * `/index/requirements`; the lane follows it up to this ceiling. Upserts are
 * network-bound, so the lane outpaces the single serial extraction worker
 * only when it has several requests in flight.
 */
const INDEX_LANE_MAX_IN_FLIGHT = 8;
/** Lane width until the backend advertises its limit, and for backends that don't. */
const INDEX_LANE_DEFAULT_IN_FLIGHT = 4;
/**
 * Lane width while the user is active. Upserts are mostly network waits, so
 * they keep running outside idle time. Half the idle width keeps their
 * main-thread work (cache read, hashing, compression) small and leaves
 * connections to the API host free for chat requests.
 */
const INDEX_LANE_ACTIVE_IN_FLIGHT = 4;
/**
 * Cloud-index cleanup. Each untag is a short sequence of server round trips
 * that reads no local content, and the backend applies no per-user in-flight
 * limit to it. Excluding a library queues one untag per indexed document, so
 * the lane needs several in flight to drain that backlog in minutes. The
 * active width leaves connections to the API host free for chat requests.
 */
const UNTAG_LANE_CAPACITY = { maxInFlight: 8, activeMaxInFlight: 4 };
const CLEANUP_RESTORE_INTERVAL_MS = 6 * 60 * 60_000;

/** Upsert lane limits for a backend-advertised per-user limit. */
export function indexLaneCapacity(advertised?: number | null): LaneCapacity {
    const maxInFlight = typeof advertised === "number" && Number.isFinite(advertised) && advertised >= 1
        ? Math.min(INDEX_LANE_MAX_IN_FLIGHT, Math.floor(advertised))
        : INDEX_LANE_DEFAULT_IN_FLIGHT;
    return {
        maxInFlight,
        activeMaxInFlight: Math.min(maxInFlight, INDEX_LANE_ACTIVE_IN_FLIGHT),
    };
}

export function startFulltextUpsertLane(
    searchableLibraryIds: number[],
    hasAccess: boolean,
): () => Promise<void> {
    let cancelled = false;
    const dispatcher = Zotero.Beaver.backgroundExtractor!;
    const executor = new FulltextUpsertExecutor(searchIndexApiClient, "fulltext_upsert", {
        onRequirements: (requirements) => {
            if (cancelled) return;
            dispatcher.setLaneCapacity(executor.jobType, executor,
                indexLaneCapacity(requirements.upsert_max_in_flight));
        },
    });
    const untagExecutor = new FulltextUpsertExecutor(
        searchIndexApiClient,
        "fulltext_untag",
    );
    if (hasAccess) dispatcher.registerExecutor(executor, indexLaneCapacity());
    dispatcher.registerExecutor(untagExecutor, { ...UNTAG_LANE_CAPACITY, survivesLibraryExclusion: true });
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
