/**
 * The MuPDF worker for one interactive PDF request (a document read, page
 * images, a view or a search).
 *
 * Interactive requests on the default hot slot get their worker at their
 * first worker op from the background extractor's interactive router (hot,
 * the idle background worker when hot is busy, or a wait until one of them
 * frees up). The choice holds for every later op of the request, so a request
 * never splits across workers. Requests that never dispatch (cache hits,
 * joined extractions) never take a route.
 *
 * The route is held until the request has finished *and* its ops have
 * settled: a shared extraction can outlive the request that started it, and
 * the background worker must stay exclusive until it does. A shared
 * extraction can also start only after its leader request has finished (the
 * document cache rechecks its payload first, and other waiters keep the
 * extraction alive). Such a late op takes a route of its own instead of
 * reusing the released one.
 *
 * A request that joins another request's shared extraction gives up its
 * worker while it waits for that result (`releaseWorker`): it has no op to
 * run, and holding the worker could make the shared extraction wait behind
 * the requests waiting for it.
 */

import {
    getMuPDFWorkerClient,
    type MuPDFWorkerClient,
    type PDFWorkerSlotName,
    type WorkerClientRunner,
} from '../../beaver-extract';
import type { InteractiveWorkerRoute, OverflowSkipReason } from '../backgroundQueue/interactiveOverflow';

export interface PdfRequestWorkerOptions {
    interactive: boolean;
    workerName: PDFWorkerSlotName;
    /** The request's deadline; abandons a wait for a worker. */
    signal?: AbortSignal;
    /** The request's file (`libraryID/key`), for worker affinity. */
    affinityKey?: string;
}

export class PdfRequestWorker implements WorkerClientRunner {
    private client: MuPDFWorkerClient | null = null;
    private route: InteractiveWorkerRoute | null = null;
    private pendingClient: Promise<MuPDFWorkerClient> | null = null;
    private resolvedSlot: PDFWorkerSlotName | null = null;
    private skip: OverflowSkipReason | null = null;
    private waitedMs = 0;
    private outstanding = 0;
    private closed = false;

    constructor(private readonly opts: PdfRequestWorkerOptions) {}

    /** The slot the request's ops ran on; undefined until its first op. */
    get slot(): PDFWorkerSlotName | undefined {
        return this.resolvedSlot ?? undefined;
    }

    /** Why the request ran on a busy hot worker, when it did. */
    get overflowSkip(): OverflowSkipReason | undefined {
        return this.skip ?? undefined;
    }

    /** Time spent waiting for a worker before the first op, ms. */
    get routeWaitMs(): number {
        return this.waitedMs;
    }

    /**
     * Run one worker op on the request's worker. `signal` replaces the
     * request's deadline for the wait for a worker (a shared extraction's own
     * signal, which outlives the request that started it).
     */
    async run<T>(op: (client: MuPDFWorkerClient) => Promise<T>, opts: { signal?: AbortSignal } = {}): Promise<T> {
        this.outstanding += 1;
        try {
            const client = this.client ?? await this.resolve(opts.signal ?? this.opts.signal);
            return await op(client);
        } finally {
            this.outstanding -= 1;
            this.releaseIfDone();
        }
    }

    /**
     * The request has no op to run for now (it joined another request's
     * extraction): release its worker. A later op takes a new route.
     */
    releaseWorker(): void {
        if (this.outstanding > 0) return;
        this.dropRoute();
    }

    /** The request is done; the route is released once its ops settle. */
    close(): void {
        this.closed = true;
        this.releaseIfDone();
    }

    private resolve(signal: AbortSignal | undefined): Promise<MuPDFWorkerClient> {
        this.pendingClient ??= this.acquire(signal).finally(() => {
            this.pendingClient = null;
        });
        return this.pendingClient;
    }

    private async acquire(signal: AbortSignal | undefined): Promise<MuPDFWorkerClient> {
        const router = this.opts.interactive && this.opts.workerName === 'hot'
            ? Zotero.Beaver?.backgroundExtractor?.interactiveOverflow
            : undefined;
        let route: InteractiveWorkerRoute | null = null;
        if (router) {
            const startedAt = Date.now();
            route = await router.acquire({ signal, affinityKey: this.opts.affinityKey });
            this.waitedMs += Date.now() - startedAt;
        }
        const slot = route?.slot ?? this.opts.workerName;
        let client: MuPDFWorkerClient;
        try {
            client = getMuPDFWorkerClient(slot);
        } catch (error) {
            route?.release();
            throw error;
        }
        this.route = route;
        this.client = client;
        this.resolvedSlot = slot;
        this.skip = route?.overflowSkip ?? null;
        return client;
    }

    private releaseIfDone(): void {
        if (!this.closed || this.outstanding > 0) return;
        this.dropRoute();
    }

    private dropRoute(): void {
        this.route?.release();
        this.route = null;
        this.client = null;
    }
}
