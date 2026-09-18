import type { ProcessingProgress } from "./backgroundProcessing/progress";
import { InstanceSearchReadiness } from "./searchIndex/instanceSearchReadiness";
import { searchIndexApiClient } from "./searchIndex/searchIndexApiClient";
import { getZoteroUserIdentifier } from "../utils/zoteroUtils";
import {
    collectProcessingStatus,
    type ProcessingStatusOptions,
} from "./backgroundProcessing/statusSnapshot";
import {
    getPendingVersionNotifications,
    clearPendingVersionNotifications,
} from "../utils/versionNotificationPrefs";
import type { InstanceAccount, AccountSnapshot } from "./instanceAccount";
import { OcrExecutor } from "./backgroundQueue/ocrExecutor";
import { startFulltextUpsertLane } from "./backgroundProcessing/fulltextUpsertLane";
import { startBackgroundProcessingScopeCleanup } from "./backgroundProcessing/backgroundProcessingScopeCleanup";
import {
    startEmbeddingIndex,
    initialEmbeddingState,
    type EmbeddingIndexState,
    type PendingEmbeddingEvents,
} from "./instanceEmbeddingIndex";
import { logger } from "@beaver/agent-core/platform/logger";

/** Owns background lane registrations, scope reconciliation and UI projections. */
export class InstanceBackground {
    readonly searchReadiness = new InstanceSearchReadiness();
    private unsubscribe?: () => void;
    private cleanups: (() => void | Promise<void>)[] = [];
    private key = "";
    private notificationGeneration: number | undefined;
    private stopEmbedding?: () => void;
    private embeddingLibraryIds?: number[];
    private pendingReindex = false;
    private settling = new Set<Promise<void>>();
    private tail: Promise<void> = Promise.resolve();
    private pendingEmbeddingEvents: PendingEmbeddingEvents = {
        modifiedItemIds: new Set(),
        deletedItemIds: new Set(),
    };
    private state = { ...initialEmbeddingState };
    private notifications = new Map<string, number>();
    private statusReads = new Map<
        string,
        ReturnType<InstanceBackground["collectStatus"]>
    >();
    private progressScopeKey = "";
    private progressReady: Promise<void> = Promise.resolve();
    private progressReads = new Set<Promise<ProcessingProgress | null>>();
    private discovery = new Set<symbol>();
    private awaitingInitialDiscovery = false;
    private discoveryStart: { runId: number; total: number } | null = null;
    private discovered = 0;
    private progressUnsubscribe?: () => void;
    private activityUnsubscribes: (() => void)[] = [];
    private statusTimer?: ReturnType<typeof setTimeout>;
    private disposed = false;

    private statusRefreshing = false;
    private statusDirty = false;

    /** Coalesce database activity into a renderer wake, independent of any window. */
    private statusChanged = (): void => {
        if (this.disposed) return;
        this.statusDirty = true;
        if (this.statusTimer !== undefined || this.statusRefreshing) return;
        this.statusTimer = setTimeout(() => {
            this.statusTimer = undefined;
            this.statusRefreshing = true;
            this.statusDirty = false;
            void this.getProcessingProgress()
                .catch((error) => logger(`Processing progress: ${error}`, 2))
                .finally(() => {
                    this.statusRefreshing = false;
                    if (this.disposed) return;
                    Zotero.Beaver?.runtime?.publish(
                        "background-processing:changed",
                        {},
                    );
                    if (this.statusDirty) this.statusChanged();
                });
        }, 100);
    };

    private configureProgress(): Promise<void> {
        const owner = Zotero.Beaver;
        const snapshot = owner.account?.getSnapshot();
        const scope = {
            accountId: owner.libraryScopeInitialized
                ? (snapshot?.session?.user?.id ?? "")
                : "",
            libraryIds: owner.libraryScopeInitialized
                ? [...(owner.searchableLibraryIds ?? [])].sort((a, b) => a - b)
                : [],
            hasOcrAccess: !!owner.hasOcrAccess,
            hasSearchIndexAccess: !!owner.hasSearchIndexAccess,
        };
        const key = JSON.stringify(scope);
        if (key === this.progressScopeKey) return this.progressReady;
        this.progressScopeKey = key;
        this.discovered = 0;
        this.discoveryStart = null;
        this.progressReady = this.progressReady
            .catch(() => {})
            .then(async () => {
                await owner.db?.configureProcessingProgress(scope);
            })
            .catch((error) => {
                if (this.progressScopeKey === key) this.progressScopeKey = "";
                throw error;
            });
        return this.progressReady;
    }

    getProcessingProgress(
        libraryId?: number,
    ): Promise<ProcessingProgress | null> {
        if (this.disposed) return Promise.resolve(null);
        const pending = this.readProcessingProgress(libraryId).finally(() =>
            this.progressReads.delete(pending),
        );
        this.progressReads.add(pending);
        return pending;
    }

    private async readProcessingProgress(
        libraryId?: number,
    ): Promise<ProcessingProgress | null> {
        const ready = this.configureProgress();
        const key = this.progressScopeKey;
        await ready;
        if (key !== this.progressScopeKey || this.disposed) return null;
        const owner = Zotero.Beaver;
        if (
            !owner.db ||
            !owner.libraryScopeInitialized ||
            !owner.account?.getSnapshot().session
        )
            return null;
        const lanes = owner.backgroundExtractor?.getLaneStatus() ?? {};
        const inFlight = Object.entries(lanes).reduce(
            (n, [type, lane]) =>
                n + (type === "fulltext_untag" ? 0 : (lane?.inFlight ?? 0)),
            0,
        );
        const progress = await owner.db.getProcessingProgress(
            this.isDiscovering(),
            inFlight,
            libraryId,
            Object.keys(lanes).filter((type) => type !== "fulltext_untag"),
        );
        return key === this.progressScopeKey && !this.disposed
            ? { ...progress, discovered: this.discovered }
            : null;
    }

    /** True while a producer is still discovering work, or before the first discovery has run. */
    isDiscovering(): boolean {
        return this.awaitingInitialDiscovery || this.discovery.size > 0;
    }

    /** Keep an empty queue from ending a run while a producer discovers work. */
    async beginProcessingDiscovery(): Promise<() => Promise<void>> {
        this.awaitingInitialDiscovery = false;
        const token = Symbol("processing-discovery");
        const outermost = this.discovery.size === 0;
        this.discovery.add(token);
        this.statusChanged();
        try {
            const before = await this.getProcessingProgress();
            if (outermost) {
                this.discoveryStart = before && {
                    runId: before.runId,
                    total: before.total,
                };
                this.discovered = 0;
            }
        } catch (error) {
            // A failed status read must not release the producer's hold.
            logger(`Processing discovery status: ${error}`, 2);
        }
        let ended = false;
        return async () => {
            if (ended) return;
            ended = true;
            try {
                const after = await this.getProcessingProgress();
                if (after && this.discoveryStart) {
                    this.discovered = Math.max(
                        0,
                        after.total -
                            (after.runId === this.discoveryStart.runId
                                ? this.discoveryStart.total
                                : 0),
                    );
                }
            } catch (error) {
                logger(`Processing discovery status: ${error}`, 2);
            } finally {
                this.discovery.delete(token);
                if (this.discovery.size === 0) this.discoveryStart = null;
                this.statusChanged();
            }
        };
    }

    /** Remote coverage has its own request lifetime and never blocks local progress. */
    async collectCoverage() {
        const owner = Zotero.Beaver;
        const generation = owner.account?.getGeneration();
        if (!owner.hasSearchIndexAccess) return undefined;
        const revision = owner.account?.getSnapshot().revision;
        let coverage;
        try {
            coverage = await searchIndexApiClient.status(
                getZoteroUserIdentifier().localUserKey,
            );
        } catch {
            coverage = null;
        }
        return owner.account?.getGeneration() === generation &&
            owner.account?.getSnapshot().revision === revision
            ? coverage
            : undefined;
    }

    claimVersionNotifications(): string[] {
        const versions = getPendingVersionNotifications();
        clearPendingVersionNotifications();
        return versions;
    }
    collectStatus(
        options: ProcessingStatusOptions = {},
    ): Promise<Awaited<ReturnType<typeof collectProcessingStatus>> | null> {
        const owner = Zotero.Beaver;
        if (
            owner.account &&
            (!owner.libraryScopeInitialized ||
                !owner.account.getSnapshot().session)
        ) {
            return Promise.resolve(null);
        }
        const key = JSON.stringify([
            owner.account?.getGeneration(),
            owner.account?.getSnapshot().revision,
            options,
        ]);
        const existing = this.statusReads.get(key);
        if (existing) return existing;
        const generation = owner.account?.getGeneration();
        const revision = owner.account?.getSnapshot().revision;
        const current = () =>
            owner.account?.getGeneration() === generation &&
            owner.account?.getSnapshot().revision === revision;
        const pending = collectProcessingStatus(
            {
                hasOcrAccess: !!owner.hasOcrAccess,
                hasSearchIndexAccess: !!owner.hasSearchIndexAccess,
            },
            options,
        )
            .then(
                (result) => (current() ? result : null),
                (error) => {
                    if (!current()) return null;
                    throw error;
                },
            )
            .finally(() => {
                if (this.statusReads.get(key) === pending)
                    this.statusReads.delete(key);
            });
        this.statusReads.set(key, pending);
        return pending;
    }

    start(account: InstanceAccount): Promise<void> {
        if (this.unsubscribe) return this.progressReady;
        this.disposed = false;
        this.searchReadiness.start();
        this.awaitingInitialDiscovery = true;
        this.progressUnsubscribe = Zotero.Beaver.db?.subscribeProcessingChanges(
            this.statusChanged,
        );
        for (const event of [
            "background-worker:status",
            "background-job:done",
            "background-job:deferred",
        ]) {
            const unsubscribe = Zotero.Beaver.runtime?.subscribe(
                event,
                this.statusChanged,
            );
            if (unsubscribe) this.activityUnsubscribes.push(unsubscribe);
        }
        this.unsubscribe = account.subscribe((snapshot) =>
            this.reconcile(snapshot),
        );
        return this.progressReady;
    }
    getSnapshot(): EmbeddingIndexState {
        return { ...this.state };
    }
    private publish(update: Partial<EmbeddingIndexState>): void {
        this.state = { ...this.state, ...update };
        Zotero.Beaver?.runtime?.publish(
            "embedding-index:status",
            this.getSnapshot(),
        );
    }
    /** Synchronous session eligibility prevents duplicate presentation across renderers. */
    claimNotification(key: string, intervalMs = Infinity): boolean {
        const now = Date.now();
        const lastClaim = this.notifications.get(key);
        if (lastClaim !== undefined && now - lastClaim < intervalMs)
            return false;
        this.notifications.set(key, now);
        return true;
    }
    reindex(): void {
        this.pendingReindex = true;
        if (this.embeddingLibraryIds)
            this.restartEmbedding(this.embeddingLibraryIds, true);
    }
    private restartEmbedding(ids: number[], force = false): void {
        this.stopEmbedding?.();
        this.embeddingLibraryIds = ids;
        this.publish({ ...initialEmbeddingState });
        this.stopEmbedding = startEmbeddingIndex(
            ids,
            force,
            (update) => this.publish(update),
            (work) => {
                const pending = this.tail.then(work);
                this.tail = pending.catch((error) =>
                    logger(`Embedding work: ${error}`, 1),
                );
                return this.tail;
            },
            this.pendingEmbeddingEvents,
        );
        this.pendingReindex = false;
    }
    private reconcile(snapshot: AccountSnapshot): void {
        this.searchReadiness.reconcile();
        void this.configureProgress().then(this.statusChanged, (error) =>
            logger(`Processing progress: ${error}`, 2),
        );
        if (snapshot.generation !== this.notificationGeneration) {
            this.notifications.clear();
            this.notificationGeneration = snapshot.generation;
        }
        const owner = Zotero.Beaver;
        const ids = [...(owner.searchableLibraryIds ?? [])].sort(
            (a, b) => a - b,
        );
        const profile = snapshot.data?.profile;
        const authorized =
            !!snapshot.session &&
            !!(
                profile?.has_authorized_access ||
                profile?.has_authorized_free_access
            );
        const key = JSON.stringify([
            snapshot.generation,
            owner.libraryScopeInitialized,
            ids,
            snapshot.libraries.map((l) => l.library_id).sort((a, b) => a - b),
            authorized,
            owner.hasOcrAccess,
            owner.hasSearchIndexAccess,
        ]);
        if (key === this.key) return;
        this.key = key;
        this.clearGeneration();
        if (snapshot.session) {
            this.cleanups.push(startFulltextUpsertLane(ids,
                authorized && !!owner.libraryScopeInitialized && !!owner.hasSearchIndexAccess));
        }
        if (snapshot.session && owner.libraryScopeInitialized) {
            this.cleanups.push(startBackgroundProcessingScopeCleanup(
                snapshot.libraries, ids));
        }
        if (!owner.libraryScopeInitialized || !authorized) {
            this.publish({ ...initialEmbeddingState });
            return;
        }
        const ocr = new OcrExecutor();
        owner.backgroundExtractor!.registerExecutor(ocr, { maxInFlight: 3 });
        this.cleanups.push(() =>
            owner.backgroundExtractor?.unregisterExecutor(ocr.jobType, ocr),
        );
        this.restartEmbedding(ids, this.pendingReindex);
    }
    private clearGeneration(): void {
        this.stopEmbedding?.();
        this.stopEmbedding = undefined;
        this.embeddingLibraryIds = undefined;
        for (const cleanup of this.cleanups.splice(0)) {
            const result = cleanup();
            if (result) {
                const settled = result
                    .catch((error) => logger(`Background cleanup: ${error}`, 2))
                    .finally(() => this.settling.delete(settled));
                this.settling.add(settled);
            }
        }
    }
    async dispose(): Promise<void> {
        this.disposed = true;
        this.progressUnsubscribe?.();
        for (const unsubscribe of this.activityUnsubscribes.splice(0))
            unsubscribe();
        if (this.statusTimer !== undefined) clearTimeout(this.statusTimer);
        this.statusTimer = undefined;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.clearGeneration();
        this.pendingReindex = false;
        await Promise.allSettled([
            this.searchReadiness.dispose(),
            this.tail,
            this.progressReady,
            ...this.progressReads,
            ...this.settling,
            ...this.statusReads.values(),
        ]);
        this.pendingEmbeddingEvents.modifiedItemIds.clear();
        this.pendingEmbeddingEvents.deletedItemIds.clear();
    }
}
