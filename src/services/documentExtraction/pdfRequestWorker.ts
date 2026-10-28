/**
 * The MuPDF worker for one PDF document request.
 *
 * Interactive requests on the default hot slot choose their worker at their
 * first worker op through the background extractor's interactive overflow
 * router (hot, or the idle background worker when hot is busy). The choice
 * holds for every later op of the request, so a request never splits across
 * workers. Requests that never dispatch (cache hits, joined extractions)
 * never take a route.
 *
 * The route is held until the request has finished *and* its ops have
 * settled: a shared extraction can outlive the request that started it, and
 * the background worker must stay exclusive until it does. A shared
 * extraction can also start only after its leader request has finished (the
 * document cache rechecks its payload first, and other waiters keep the
 * extraction alive). Such a late op takes a route of its own instead of
 * reusing the released one.
 */

import {
    getMuPDFWorkerClient,
    type MuPDFWorkerClient,
    type PDFWorkerSlotName,
} from '../../beaver-extract';
import type { InteractiveWorkerRoute, OverflowSkipReason } from '../backgroundQueue/interactiveOverflow';

export class PdfRequestWorker {
    private client: MuPDFWorkerClient | null = null;
    private route: InteractiveWorkerRoute | null = null;
    private resolvedSlot: PDFWorkerSlotName | null = null;
    private outstanding = 0;
    private closed = false;

    constructor(private readonly opts: { interactive: boolean; workerName: PDFWorkerSlotName }) {}

    /** The slot the request's ops ran on; undefined until its first op. */
    get slot(): PDFWorkerSlotName | undefined {
        return this.resolvedSlot ?? undefined;
    }

    /** Why the request stayed on a busy hot worker, when it did. */
    get overflowSkip(): OverflowSkipReason | undefined {
        return this.route?.overflowSkip;
    }

    /** Run one worker op on the request's worker. */
    async run<T>(op: (client: MuPDFWorkerClient) => Promise<T>): Promise<T> {
        const client = this.resolve();
        this.outstanding += 1;
        try {
            return await op(client);
        } finally {
            this.outstanding -= 1;
            this.releaseIfDone();
        }
    }

    /** The request is done; the route is released once its ops settle. */
    close(): void {
        this.closed = true;
        this.releaseIfDone();
    }

    private resolve(): MuPDFWorkerClient {
        if (this.client) return this.client;
        if (this.opts.interactive && this.opts.workerName === 'hot') {
            this.route = Zotero.Beaver?.backgroundExtractor?.interactiveOverflow?.route() ?? null;
        }
        const slot = this.route?.slot ?? this.opts.workerName;
        try {
            this.client = getMuPDFWorkerClient(slot);
        } catch (error) {
            this.route?.release();
            this.route = null;
            throw error;
        }
        this.resolvedSlot = slot;
        return this.client;
    }

    private releaseIfDone(): void {
        if (!this.closed || this.outstanding > 0) return;
        this.route?.release();
        this.route = null;
        this.client = null;
    }
}
