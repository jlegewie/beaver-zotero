/**
 * Unit tests for MuPDFWorkerClient.
 *
 * The real worker is replaced with an in-process MockWorker that echoes
 * canned replies. We assert:
 *   - getPageCount round-trip resolves to the worker's count.
 *   - ExtractionError-shaped failure replies rehydrate to a real
 *     ExtractionError on the main side.
 *   - postMessage is called WITHOUT a transfer list (regression guard for
 *     the buffer-reuse issue documented in the plan).
 *   - The singleton is parked on `Zotero.__beaverMuPDFWorkerClient` and
 *     `disposeMuPDFWorker` clears it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

import {
    getMuPDFWorkerClient,
    disposeMuPDFWorker,
} from '../../../src/services/pdf/MuPDFWorkerClient';
import {
    ExtractionError,
    ExtractionErrorCode,
} from '../../../src/services/pdf/types';

// ---------------------------------------------------------------------------
// MockWorker — captures postMessage calls + lets the test queue up replies.
// ---------------------------------------------------------------------------
class MockWorker {
    static instances: MockWorker[] = [];
    onmessage: ((event: { data: any }) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onmessageerror: ((event: any) => void) | null = null;
    postMessage = vi.fn((message: any, transfer?: Transferable[]) => {
        this.posted.push({ message, transfer });
    });
    terminate = vi.fn();
    posted: Array<{ message: any; transfer: Transferable[] | undefined }> = [];

    constructor(public url: string, public options: any) {
        MockWorker.instances.push(this);
    }

    /** Helper: deliver a reply to the most recently posted message. */
    replyToLast(reply: any): void {
        const last = this.posted[this.posted.length - 1];
        const id = (last?.message as { id: number } | undefined)?.id;
        this.onmessage?.({ data: { id, ...reply } });
    }
}

function setupZoteroMainWindowWithMockWorker() {
    const win: any = {
        Worker: MockWorker,
    };
    (globalThis as any).Zotero = (globalThis as any).Zotero ?? {};
    (globalThis as any).Zotero.getMainWindow = vi.fn(() => win);
    (globalThis as any).Zotero.__beaverMuPDFWorkerClient = undefined;
    return win;
}

describe('MuPDFWorkerClient', () => {
    beforeEach(() => {
        MockWorker.instances.length = 0;
        setupZoteroMainWindowWithMockWorker();
    });

    afterEach(async () => {
        await disposeMuPDFWorker();
        delete (globalThis as any).Zotero.__beaverMuPDFWorkerClient;
    });

    it('returns count from a successful getPageCount round-trip', async () => {
        const client = getMuPDFWorkerClient();
        const buf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

        const promise = client.getPageCount(buf);

        // The worker is created lazily on the first dispatch.
        const worker = MockWorker.instances[0];
        expect(worker).toBeDefined();
        worker.replyToLast({ ok: true, result: { count: 42 } });

        await expect(promise).resolves.toBe(42);
    });

    it('passes the PDF bytes to the worker WITHOUT a transfer list', async () => {
        const client = getMuPDFWorkerClient();
        const buf = new Uint8Array([1, 2, 3, 4]);

        const promise = client.getPageCount(buf);
        const worker = MockWorker.instances[0];
        worker.replyToLast({ ok: true, result: { count: 1 } });
        await promise;

        // Regression guard: buffer-reuse callers (handlers that call
        // getPageCount then renderPagesToImages with the same `pdfData`)
        // would see a detached ArrayBuffer if we transferred.
        expect(worker.postMessage).toHaveBeenCalledTimes(1);
        const [, transfer] = worker.postMessage.mock.calls[0] as [
            any,
            Transferable[] | undefined,
        ];
        expect(transfer).toBeUndefined();
    });

    it('rehydrates an ExtractionError from a structured failure reply', async () => {
        const client = getMuPDFWorkerClient();
        const buf = new Uint8Array([0]);

        const promise = client.getPageCount(buf);
        const worker = MockWorker.instances[0];
        worker.replyToLast({
            ok: false,
            error: {
                name: 'ExtractionError',
                code: 'ENCRYPTED',
                message: 'Document is encrypted and requires a password',
            },
        });

        await expect(promise).rejects.toBeInstanceOf(ExtractionError);
        await expect(promise).rejects.toMatchObject({
            code: ExtractionErrorCode.ENCRYPTED,
            name: 'ExtractionError',
        });
    });

    it('routes log messages to the logger and does not consume pending entries', async () => {
        const { logger } = await import('../../../src/utils/logger');
        const client = getMuPDFWorkerClient();
        const buf = new Uint8Array([0]);

        const promise = client.getPageCount(buf);
        const worker = MockWorker.instances[0];

        // Out-of-band log message — no `id`, must not consume pending.
        worker.onmessage?.({
            data: { kind: 'log', level: 'warn', msg: 'hello from worker' },
        });

        // The promise is still pending; resolve it with a real reply.
        worker.replyToLast({ ok: true, result: { count: 7 } });

        await expect(promise).resolves.toBe(7);
        expect(vi.mocked(logger)).toHaveBeenCalledWith('hello from worker', 2);
    });

    it('parks the singleton on Zotero.__beaverMuPDFWorkerClient', () => {
        const client = getMuPDFWorkerClient();
        expect((globalThis as any).Zotero.__beaverMuPDFWorkerClient).toBe(
            client,
        );
        expect(getMuPDFWorkerClient()).toBe(client);
    });

    it('does not respawn a new worker when an in-flight RPC is rejected by dispose', async () => {
        const client = getMuPDFWorkerClient();
        const promise = client.getPageCount(new Uint8Array([0]));

        // Worker spawned lazily on the first dispatch.
        expect(MockWorker.instances.length).toBe(1);

        // Simulate window-unload / shutdown disposal while the RPC is in flight.
        await disposeMuPDFWorker();

        // The pending RPC is rejected with a stale-worker error, but the
        // retry path must not spawn a replacement worker (would orphan it
        // from cleanup and tie it to a closing window realm).
        await expect(promise).rejects.toThrow();
        expect(MockWorker.instances.length).toBe(1);
        expect(
            (globalThis as any).Zotero.__beaverMuPDFWorkerClient,
        ).toBeUndefined();
    });

    it('disposeMuPDFWorker terminates the worker and clears the slot', async () => {
        const client = getMuPDFWorkerClient();
        // Force lazy spawn:
        client.getPageCount(new Uint8Array([0])).catch(() => {});
        const worker = MockWorker.instances[0];
        expect(worker).toBeDefined();

        await disposeMuPDFWorker();

        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(
            (globalThis as any).Zotero.__beaverMuPDFWorkerClient,
        ).toBeUndefined();
    });
});
