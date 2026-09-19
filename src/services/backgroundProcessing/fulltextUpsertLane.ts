import { FulltextUpsertExecutor } from "../backgroundQueue/fulltextUpsertExecutor";
import { searchIndexApiClient } from "../searchIndex/searchIndexApiClient";
import { INDEX_RECONCILE_INTERVAL_MS } from "../backgroundProcessing/constants";
import { reconcileRemoteRefs } from "../backgroundProcessing/remoteRefsReconcile";
import { logger } from "@beaver/agent-core/platform/logger";

const INDEX_LANE_MAX_IN_FLIGHT = 2;
const VALIDITY_INTERVAL_MS = 5 * 60_000;
const RECOVERY_SAFETY_INTERVAL_MS = 60 * 60_000;
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
    let selectionNeeded = true;
    let lastSelection = Number.NEGATIVE_INFINITY;
    let lastAttempt = Number.NEGATIVE_INFINITY;
    let requirementsKey = '';
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const requestSweep = () => {
        if (cancelled || !hasAccess || sweeping || recoveryTimer !== undefined) return;
        recoveryTimer = setTimeout(runSweep, Math.max(0, lastAttempt + INDEX_RECONCILE_INTERVAL_MS - Date.now()));
    };
    const runSweep = () => {
        recoveryTimer = undefined;
        if (cancelled || sweeping || !hasAccess) return;
        sweeping = true;
        lastAttempt = Date.now();
        let selectionAllowed = false;
        sweep = reconcileRemoteRefs(searchableLibraryIds, () => cancelled, requirements => {
            selectionAllowed = true;
            const key = JSON.stringify(requirements);
            const select = selectionNeeded || key !== requirementsKey
                || Date.now() - lastSelection >= RECOVERY_SAFETY_INTERVAL_MS;
            requirementsKey = key;
            if (select) {
                selectionNeeded = false;
                lastSelection = Date.now();
            }
            return select;
        }).then(count => {
            if (count >= 50) selectionNeeded = true;
        }).catch(error => {
            // Keep a failed attempt eligible for the next validity probe.
            selectionAllowed = false;
            lastSelection = Number.NEGATIVE_INFINITY;
            logger(`Fulltext ref reconcile failed: ${error}`, 2);
        }).finally(() => {
            sweeping = false;
            if (selectionAllowed && selectionNeeded) requestSweep();
        });
    };
    const unsubscribe = Zotero.Beaver.db?.subscribeReadinessChanges(() => {
        selectionNeeded = true;
        requestSweep();
    });
    recoveryTimer = setTimeout(runSweep, 2_000);
    const sweepTimer = setInterval(requestSweep, VALIDITY_INTERVAL_MS);
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
        unsubscribe?.();
        if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
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
