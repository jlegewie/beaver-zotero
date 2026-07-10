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
 *   - The singleton is parked in the configured slot (Beaver wires this
 *     to `Zotero.__beaverMuPDFWorkerClient_hot`) and `disposeMuPDFWorker`
 *     clears it.
 *   - Spawn posts a `configure` frame as the first message before any op.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configurePDFForTests } from '../../helpers/configurePDFForTests';
import {
    MockWorker,
    setupZoteroMainWindowWithMockWorker,
} from '../../helpers/mockWorker';

import {
    getMuPDFWorkerClient,
    getExistingMuPDFWorkerClient,
    disposeMuPDFWorker,
    WorkerAbortError,
    WorkerSpawnError,
    __setIdleTimeoutForTest,
    __resetIdleTimeoutForTest,
} from '../../../src/beaver-extract/MuPDFWorkerClient';
import {
    ExtractionError,
    ExtractionErrorCode,
} from '../../../src/beaver-extract/types';
import type { WorkerStartFailureInfo } from '../../../src/beaver-extract/config';

describe('MuPDFWorkerClient', () => {
    beforeEach(() => {
        MockWorker.instances.length = 0;
        MockWorker.dropNextConfigureAck = false;
        setupZoteroMainWindowWithMockWorker();
    });

    afterEach(async () => {
        await disposeMuPDFWorker();
        __resetIdleTimeoutForTest();
        delete (globalThis as any).Zotero.__beaverMuPDFWorkerClient_hot;
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

    it('tracks the oldest in-flight operation timestamp without scanning on read', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        try {
            const client = getMuPDFWorkerClient();
            const first = client.getPageCount(new Uint8Array([1]));
            const worker = MockWorker.instances[0];

            expect(client.inFlight).toBe(1);
            expect(client.oldestInFlightStartedAt).toBe(10_000);

            await vi.advanceTimersByTimeAsync(250);
            const second = client.getPageCount(new Uint8Array([2]));
            expect(client.inFlight).toBe(2);
            expect(client.oldestInFlightStartedAt).toBe(10_000);

            const firstId = worker.posted[0].message.id;
            worker.onmessage?.({
                data: { id: firstId, ok: true, result: { count: 1 } },
            });
            await expect(first).resolves.toBe(1);
            expect(client.inFlight).toBe(1);
            expect(client.oldestInFlightStartedAt).toBe(10_250);

            worker.replyToLast({ ok: true, result: { count: 2 } });
            await expect(second).resolves.toBe(2);
            expect(client.inFlight).toBe(0);
            expect(client.oldestInFlightStartedAt).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns transferred JSON bytes from extractSerialized', async () => {
        const client = getMuPDFWorkerClient();
        const jsonBytes = new TextEncoder().encode('{"mode":"structured","schemaVersion":"4","document":{"pageCount":1,"pages":[]}}');

        const promise = client.extractSerialized(
            new Uint8Array([0x25, 0x50, 0x44, 0x46]),
            { mode: 'structured', settings: { checkTextLayer: true } },
        );

        const worker = MockWorker.instances[0];
        expect(worker.posted[0].message).toMatchObject({
            op: 'extractSerialized',
            args: { mode: 'structured' },
        });
        worker.replyToLast({
            ok: true,
            result: {
                mode: 'structured',
                schemaVersion: '4',
                pageCount: 1,
                byteLength: jsonBytes.byteLength,
                jsonBytes,
                cacheMetadata: {
                    pageCount: 1,
                    pageLabels: {},
                    pages: [],
                },
            },
        });

        await expect(promise).resolves.toMatchObject({
            mode: 'structured',
            schemaVersion: '4',
            byteLength: jsonBytes.byteLength,
        });
    });

    it('posts a configure frame as the first message after spawn, before any op', async () => {
        const client = getMuPDFWorkerClient();
        const promise = client.getPageCount(new Uint8Array([0]));
        const worker = MockWorker.instances[0];

        // First raw call to postMessage is the configure handshake.
        const firstCall = worker.postMessage.mock.calls[0];
        expect(firstCall[0]).toMatchObject({ kind: 'configure' });
        expect((firstCall[0] as any).urls).toMatchObject({
            mupdfWasmFactoryUrl: expect.any(String),
            mupdfWasmBinaryUrl: expect.any(String),
            sentencexWasmFactoryUrl: expect.any(String),
            sentencexWasmBinaryUrl: expect.any(String),
        });
        // The op then follows.
        expect(worker.posted[0].message).toMatchObject({ op: 'getPageCount' });

        worker.replyToLast({ ok: true, result: { count: 1 } });
        await promise;
    });

    it('waits for a configured acknowledgement before posting ops', async () => {
        MockWorker.dropNextConfigureAck = true;
        const client = getMuPDFWorkerClient();
        const promise = client.getPageCount(new Uint8Array([0]));
        const worker = MockWorker.instances[0];

        expect(worker.configureMessages).toHaveLength(1);
        expect(worker.posted).toHaveLength(0);

        worker.sendReady();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(worker.configureMessages).toHaveLength(2);
        expect(worker.posted[0].message).toMatchObject({ op: 'getPageCount' });

        worker.replyToLast({ ok: true, result: { count: 2 } });
        await expect(promise).resolves.toBe(2);
    });

    it('aborting while waiting for startup terminates the worker without posting an op', async () => {
        MockWorker.dropNextConfigureAck = true;
        const client = getMuPDFWorkerClient();
        const controller = new AbortController();
        const promise = client.getPageCount(new Uint8Array([0]), controller.signal);
        const worker = MockWorker.instances[0];

        expect(worker.configureMessages).toHaveLength(1);
        expect(worker.posted).toHaveLength(0);

        controller.abort();

        await expect(promise).rejects.toBeInstanceOf(WorkerAbortError);
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(worker.posted).toHaveLength(0);
        expect(client.getStats()).toMatchObject({
            hasWorker: false,
            retryCount: 0,
            idleTimerArmed: false,
        });

        worker.sendReady();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(worker.posted).toHaveLength(0);
    });

    it('terminates the worker and retries when the configure handshake times out', async () => {
        vi.useFakeTimers();
        try {
            // First worker never acks the configure handshake.
            MockWorker.dropNextConfigureAck = true;
            const client = getMuPDFWorkerClient();
            const promise = client.getPageCount(new Uint8Array([0]));
            const first = MockWorker.instances[0];

            expect(first.configureMessages).toHaveLength(1);
            expect(first.posted).toHaveLength(0);

            // Advance past the 15s startup timeout without a `configured` ack.
            await vi.advanceTimersByTimeAsync(15000);

            expect(first.terminate).toHaveBeenCalledOnce();
            expect(first.posted).toHaveLength(0);

            // call() retries once on the stale worker — a fresh worker
            // spawns, acks the handshake, and the op goes through.
            const second = MockWorker.instances[1];
            expect(second).toBeDefined();
            expect(second.posted[0].message).toMatchObject({ op: 'getPageCount' });
            second.replyToLast({ ok: true, result: { count: 7 } });

            await expect(promise).resolves.toBe(7);
            expect(client.getStats().retryCount).toBe(1);
        } finally {
            await disposeMuPDFWorker();
            vi.useRealTimers();
        }
    });

    it('counts a start-phase configure timeout and fires onWorkerStartFailure', async () => {
        vi.useFakeTimers();
        const startFailures: WorkerStartFailureInfo[] = [];
        setupZoteroMainWindowWithMockWorker({
            onWorkerStartFailure: (info) => startFailures.push(info),
        });
        try {
            // First worker never acks the configure handshake.
            MockWorker.dropNextConfigureAck = true;
            const client = getMuPDFWorkerClient();
            const promise = client.getPageCount(new Uint8Array([0]));

            // Advance past the 15s startup timeout without a `configured` ack —
            // the worker died before it ever configured (a start-phase failure).
            await vi.advanceTimersByTimeAsync(15000);

            // The hook fired with the streak at 1. The retry (also driven by the
            // timer advance) spawns a fresh worker that acks, so by now the live
            // streak has already reset — the hook payload is the reliable record.
            expect(startFailures).toHaveLength(1);
            expect(startFailures[0]).toMatchObject({
                slotName: 'hot',
                consecutiveFailures: 1,
            });
            expect(startFailures[0].reason).toContain('configure handshake timed out');

            const second = MockWorker.instances[1];
            expect(second).toBeDefined();
            second.replyToLast({ ok: true, result: { count: 3 } });
            await expect(promise).resolves.toBe(3);
            // The fresh worker's successful handshake cleared the streak.
            expect(client.getStats().consecutiveStartFailures).toBe(0);
        } finally {
            await disposeMuPDFWorker();
            vi.useRealTimers();
        }
    });

    it('does not count a post-configure worker.onerror as a start failure', async () => {
        const startFailures: WorkerStartFailureInfo[] = [];
        setupZoteroMainWindowWithMockWorker({
            onWorkerStartFailure: (info) => startFailures.push(info),
        });
        const client = getMuPDFWorkerClient();
        const promise = client.getPageCount(new Uint8Array([0]));

        // The first worker configured (MockWorker acks synchronously) and the op
        // is in flight; a crash now is a runtime failure, not a start failure.
        const first = MockWorker.instances[0];
        first.onerror?.({ message: 'runtime boom' });

        await new Promise((resolve) => setTimeout(resolve, 0));
        const second = MockWorker.instances[1];
        expect(second).toBeDefined();
        second.replyToLast({ ok: true, result: { count: 9 } });

        await expect(promise).resolves.toBe(9);
        expect(startFailures).toHaveLength(0);
        expect(client.getStats().consecutiveStartFailures).toBe(0);
    });

    it('reports a pre-spawn WorkerSpawnError (no host window) to onWorkerStartFailure', async () => {
        // A spawn failure throws before any StartupEntry exists, so it never
        // reaches markStale. It must still count + notify so repeated hot-slot
        // spawn failures eventually raise the restart prompt.
        const startFailures: WorkerStartFailureInfo[] = [];
        configurePDFForTests({
            slotHost: (globalThis as any).Zotero,
            slotKey: '__beaverMuPDFWorkerClient_hot',
            backgroundSlotKey: '__beaverMuPDFWorkerClient_background',
            getWorkerHost: () => null,
            onWorkerStartFailure: (info) => startFailures.push(info),
        });
        const client = getMuPDFWorkerClient();

        await expect(client.getPageCount(new Uint8Array([0]))).rejects.toBeInstanceOf(
            WorkerSpawnError,
        );
        expect(startFailures).toHaveLength(1);
        expect(startFailures[0]).toMatchObject({ slotName: 'hot', consecutiveFailures: 1 });
        expect(client.getStats().consecutiveStartFailures).toBe(1);

        // A second failed spawn bumps the streak toward the popup threshold.
        await expect(client.getPageCount(new Uint8Array([0]))).rejects.toBeInstanceOf(
            WorkerSpawnError,
        );
        expect(startFailures).toHaveLength(2);
        expect(startFailures[1].consecutiveFailures).toBe(2);
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
        // would see a detached ArrayBuffer if we transferred. The
        // configure frame is excluded from `posted`, so a single op call
        // should appear here.
        expect(worker.posted).toHaveLength(1);
        const [, transfer] = worker.opCall(0);
        expect(transfer).toBeUndefined();
    });

    it('terminates the idle worker after the idle timeout', async () => {
        vi.useFakeTimers();
        try {
            __setIdleTimeoutForTest(50);
            const client = getMuPDFWorkerClient();

            const firstOp = client.getPageCount(new Uint8Array([0]));
            const first = MockWorker.instances[0];
            first.replyToLast({ ok: true, result: { count: 1 } });

            await expect(firstOp).resolves.toBe(1);
            expect(client.getStats()).toMatchObject({
                hasWorker: true,
                disposed: false,
                idleTimerArmed: true,
            });

            vi.advanceTimersByTime(50);

            expect(first.terminate).toHaveBeenCalledOnce();
            expect(client.getStats()).toMatchObject({
                hasWorker: false,
                disposed: false,
                idleTimerArmed: false,
            });

            const secondOp = client.getPageCount(new Uint8Array([1]));
            const second = MockWorker.instances[1];
            expect(second).toBeDefined();
            second.replyToLast({ ok: true, result: { count: 2 } });

            await expect(secondOp).resolves.toBe(2);
            expect(MockWorker.instances).toHaveLength(2);
        } finally {
            await disposeMuPDFWorker();
            vi.useRealTimers();
        }
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

    it('routes log messages through the configured log sink and does not consume pending entries', async () => {
        const logSpy = vi.fn();
        // Reconfigure with a spy log sink for this test.
        configurePDFForTests({
            slotHost: (globalThis as any).Zotero,
            slotKey: '__beaverMuPDFWorkerClient_hot',
            getWorkerHost: () => (globalThis as any).Zotero.getMainWindow(),
            log: logSpy,
        });

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
        expect(logSpy).toHaveBeenCalledWith('hello from worker', 2);
    });

    it('parks the singleton in the configured slot (Zotero.__beaverMuPDFWorkerClient_hot)', () => {
        const client = getMuPDFWorkerClient();
        expect((globalThis as any).Zotero.__beaverMuPDFWorkerClient_hot).toBe(
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
            (globalThis as any).Zotero.__beaverMuPDFWorkerClient_hot,
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
            (globalThis as any).Zotero.__beaverMuPDFWorkerClient_hot,
        ).toBeUndefined();
    });

    it('stale-worker retry re-posts a configure frame to the freshly-spawned worker', async () => {
        const client = getMuPDFWorkerClient();
        // Spawn the first worker via a real dispatch. Don't reply — we
        // want to mark stale while the op is in-flight so the retry path
        // fires.
        const promise = client.getPageCount(new Uint8Array([0]));
        const first = MockWorker.instances[0];
        expect(first).toBeDefined();
        expect(first.configureMessages).toHaveLength(1);

        // Simulate a worker death (test-only entry point that drives the
        // same code path as a real onerror/onmessageerror). The pending
        // RPC rejects with StaleWorkerError; `call()` catches that and
        // retries by re-dispatching, which respawns a fresh worker.
        client.markStaleForTest('test-induced');

        // The retry dispatch is async (the catch handler runs after the
        // microtask queue flushes the rejection). Flush so the second
        // worker is observable.
        await new Promise((resolve) => setTimeout(resolve, 0));

        const second = MockWorker.instances[1];
        expect(second).toBeDefined();
        // The retry must re-configure: the new worker has its own URL
        // state and was just spawned with no prior config message.
        expect(second.configureMessages).toHaveLength(1);
        second.replyToLast({ ok: true, result: { count: 9 } });

        await expect(promise).resolves.toBe(9);
    });

    it('retries once when a worker reports an op before configure', async () => {
        const client = getMuPDFWorkerClient();
        const promise = client.getPageCount(new Uint8Array([0]));
        const first = MockWorker.instances[0];

        first.replyToLast({
            ok: false,
            error: {
                name: 'Error',
                message: 'MuPDF worker received op before configure message',
            },
        });

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(first.terminate).toHaveBeenCalledOnce();
        const second = MockWorker.instances[1];
        expect(second).toBeDefined();
        expect(second.configureMessages).toHaveLength(1);
        second.replyToLast({ ok: true, result: { count: 4 } });

        await expect(promise).resolves.toBe(4);
        expect(client.getStats().retryCount).toBe(1);
    });

    it('aborting a call rejects without retrying and the next call respawns', async () => {
        const client = getMuPDFWorkerClient();
        const controller = new AbortController();

        const promise = client.getPageCount(new Uint8Array([0]), controller.signal);
        const first = MockWorker.instances[0];
        expect(first).toBeDefined();

        controller.abort();

        await expect(promise).rejects.toBeInstanceOf(WorkerAbortError);
        expect(first.terminate).toHaveBeenCalledOnce();
        expect(MockWorker.instances).toHaveLength(1);

        const next = client.getPageCount(new Uint8Array([1]));
        const second = MockWorker.instances[1];
        expect(second).toBeDefined();
        second.replyToLast({ ok: true, result: { count: 5 } });

        await expect(next).resolves.toBe(5);
        expect(client.getStats().retryCount).toBe(0);
    });

    it('retires a worker after a WASM_ERROR reply without retrying the crashing op', async () => {
        const client = getMuPDFWorkerClient();

        const firstGood = client.getPageCount(new Uint8Array([1]));
        const first = MockWorker.instances[0];
        first.replyToLast({ ok: true, result: { count: 1 } });
        await expect(firstGood).resolves.toBe(1);

        const badBytes = new Uint8Array([2]);
        const bad = client.getPageCount(badBytes);
        first.replyToLast({
            ok: false,
            error: {
                name: 'ExtractionError',
                code: ExtractionErrorCode.WASM_ERROR,
                message: 'This PDF crashed the MuPDF WASM parser and cannot be processed.',
            },
        });
        await expect(bad).rejects.toMatchObject({
            name: 'ExtractionError',
            code: ExtractionErrorCode.WASM_ERROR,
        });
        expect(first.terminate).toHaveBeenCalledOnce();
        expect(MockWorker.instances).toHaveLength(1);

        const repeatedBad = client.getPageCount(new Uint8Array([2]));
        await expect(repeatedBad).rejects.toMatchObject({
            name: 'ExtractionError',
            code: ExtractionErrorCode.WASM_ERROR,
        });
        expect(MockWorker.instances).toHaveLength(1);

        const secondGood = client.getPageCount(new Uint8Array([3]));
        const second = MockWorker.instances[1];
        expect(second).toBeDefined();
        second.replyToLast({ ok: true, result: { count: 3 } });
        await expect(secondGood).resolves.toBe(3);

        const stats = client.getStats();
        expect(stats.spawnCount).toBe(2);
        expect(stats.retryCount).toBe(0);
        expect(stats.dispatchCounts.getPageCount).toBe(4);
    });

    it('retires a worker after HEAP_EXHAUSTION without memoizing the PDF as permanently fatal', async () => {
        const client = getMuPDFWorkerClient();

        const badBytes = new Uint8Array([2]);
        const bad = client.getPageCount(badBytes);
        const first = MockWorker.instances[0];
        first.replyToLast({
            ok: false,
            error: {
                name: 'ExtractionError',
                code: ExtractionErrorCode.HEAP_EXHAUSTION,
                message: 'MuPDF exhausted its WASM heap while processing this PDF.',
            },
        });
        await expect(bad).rejects.toMatchObject({
            name: 'ExtractionError',
            code: ExtractionErrorCode.HEAP_EXHAUSTION,
        });
        expect(first.terminate).toHaveBeenCalledOnce();
        expect(MockWorker.instances).toHaveLength(1);

        const repeated = client.getPageCount(new Uint8Array([2]));
        const second = MockWorker.instances[1];
        expect(second).toBeDefined();
        second.replyToLast({ ok: true, result: { count: 2 } });
        await expect(repeated).resolves.toBe(2);

        const stats = client.getStats();
        expect(stats.spawnCount).toBe(2);
        expect(stats.retryCount).toBe(0);
        expect(stats.dispatchCounts.getPageCount).toBe(2);
    });

    it('keys fatal suppression by operation arguments', async () => {
        const client = getMuPDFWorkerClient();
        const pdfData = new Uint8Array([1, 2, 3]);

        const badPage = client.renderPages(pdfData, { pageIndices: [0] });
        const first = MockWorker.instances[0];
        first.replyToLast({
            ok: false,
            error: {
                name: 'ExtractionError',
                code: ExtractionErrorCode.WASM_ERROR,
                message: 'This PDF crashed the MuPDF WASM parser and cannot be processed.',
            },
        });
        await expect(badPage).rejects.toMatchObject({
            code: ExtractionErrorCode.WASM_ERROR,
        });
        expect(first.terminate).toHaveBeenCalledOnce();

        const differentPage = client.renderPages(pdfData, { pageIndices: [1] });
        const second = MockWorker.instances[1];
        expect(second).toBeDefined();
        second.replyToLast({
            ok: true,
            result: { pageCount: 2, pageLabels: {}, pages: [] },
        });
        await expect(differentPage).resolves.toMatchObject({ pageCount: 2 });

        const repeatedBadPage = client.renderPages(
            new Uint8Array([1, 2, 3]),
            { pageIndices: [0] },
        );
        await expect(repeatedBadPage).rejects.toMatchObject({
            code: ExtractionErrorCode.WASM_ERROR,
        });
        expect(MockWorker.instances).toHaveLength(2);
    });

    // -----------------------------------------------------------------------
    // PR #2 — broaden the worker surface
    // -----------------------------------------------------------------------

    describe('getMetadata', () => {
        it('round-trips PDFMetadata and posts without a transfer list', async () => {
            const client = getMuPDFWorkerClient();
            const buf = new Uint8Array([1, 2, 3]);

            const promise = client.getMetadata(buf);
            const worker = MockWorker.instances[0];
            worker.replyToLast({
                ok: true,
                result: {
                    pageCount: 3,
                    pageLabels: { 0: 'i', 1: 'ii' },
                    title: 'Example Doc',
                    format: 'PDF 1.7',
                },
            });

            await expect(promise).resolves.toEqual({
                pageCount: 3,
                pageLabels: { 0: 'i', 1: 'ii' },
                title: 'Example Doc',
                format: 'PDF 1.7',
            });

            const [message, transfer] = worker.opCall(0);
            expect(message).toMatchObject({ op: 'getMetadata' });
            expect(transfer).toBeUndefined();
        });
    });

    describe('extractRawPageDetailed', () => {
        it('round-trips RawPageDataDetailed', async () => {
            const client = getMuPDFWorkerClient();
            const buf = new Uint8Array([1]);

            const promise = client.extractRawPageDetailed(buf, 0);
            const worker = MockWorker.instances[0];
            const canned = {
                pageIndex: 0,
                pageNumber: 1,
                width: 612,
                height: 792,
                blocks: [],
            };
            worker.replyToLast({ ok: true, result: canned });

            await expect(promise).resolves.toEqual(canned);
        });

        it('rehydrates PAGE_OUT_OF_RANGE as ExtractionError', async () => {
            const client = getMuPDFWorkerClient();
            const buf = new Uint8Array([0]);

            const promise = client.extractRawPageDetailed(buf, 99999);
            const worker = MockWorker.instances[0];
            worker.replyToLast({
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: 'PAGE_OUT_OF_RANGE',
                    message: 'Page index 99999 out of range (0..2)',
                },
            });

            await expect(promise).rejects.toBeInstanceOf(ExtractionError);
            await expect(promise).rejects.toMatchObject({
                code: ExtractionErrorCode.PAGE_OUT_OF_RANGE,
                name: 'ExtractionError',
            });
        });

        it('does not transfer the input buffer', async () => {
            const client = getMuPDFWorkerClient();
            const buf = new Uint8Array([1, 2, 3, 4]);

            const promise = client.extractRawPageDetailed(buf, 0);
            const worker = MockWorker.instances[0];
            worker.replyToLast({ ok: true, result: { pageIndex: 0 } });
            await promise;

            const [, transfer] = worker.opCall(0);
            expect(transfer).toBeUndefined();
        });
    });

    describe('renderPages', () => {
        it('round-trips { pageCount, pageLabels, pages } and forwards args', async () => {
            const client = getMuPDFWorkerClient();
            const buf = new Uint8Array([1, 2, 3]);

            const promise = client.renderPages(buf, {
                pageIndices: [0, 1],
                options: { format: 'png' },
            });
            const worker = MockWorker.instances[0];
            const cannedBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
            const canned = {
                pageCount: 5,
                pageLabels: { 0: 'i', 1: 'ii' },
                pages: [
                    {
                        pageIndex: 0,
                        data: cannedBytes,
                        format: 'png' as const,
                        width: 100,
                        height: 100,
                        scale: 1,
                        dpi: 72,
                    },
                ],
            };
            worker.replyToLast({ ok: true, result: canned });

            await expect(promise).resolves.toEqual(canned);

            const [message, transfer] = worker.opCall(0);
            expect(message).toMatchObject({
                op: 'renderPages',
                args: {
                    pageIndices: [0, 1],
                    options: { format: 'png' },
                },
            });
            // bytes posted by copy on the main side; transfer happens worker→main only.
            expect(transfer).toBeUndefined();
        });

        it('forwards a pageRange', async () => {
            const client = getMuPDFWorkerClient();
            const buf = new Uint8Array([1]);
            const promise = client.renderPages(buf, {
                pageRange: { startIndex: 0, endIndex: 2, maxPages: 5 },
            });
            const worker = MockWorker.instances[0];
            worker.replyToLast({
                ok: true,
                result: { pageCount: 5, pageLabels: {}, pages: [] },
            });
            await promise;
            const [message] = worker.opCall(0);
            expect(message.args.pageRange).toEqual({
                startIndex: 0,
                endIndex: 2,
                maxPages: 5,
            });
        });
    });

    describe('extract', () => {
        it('forwards pageRange to op extract', async () => {
            const client = getMuPDFWorkerClient();
            const buf = new Uint8Array([1]);
            const promise = client.extract(buf, {
                settings: { checkTextLayer: true },
                pageRange: { startIndex: 0, maxPages: 2 },
            });
            const worker = MockWorker.instances[0];
            worker.replyToLast({
                ok: true,
                result: {
                    pages: [],
                    analysis: { pageCount: 10, hasTextLayer: true, styleProfile: {}, marginAnalysis: {} },
                    fullText: '',
                    pageLabels: undefined,
                    metadata: { extractedAt: 'now', version: '2.0.0', settings: {} },
                },
            });
            await promise;
            const [message] = worker.opCall(0);
            expect(message).toMatchObject({
                op: 'extract',
                args: {
                    settings: { checkTextLayer: true },
                    pageRange: { startIndex: 0, maxPages: 2 },
                },
            });
        });

        it('rehydrates PAGE_OUT_OF_RANGE with pageCount from worker payload', async () => {
            const client = getMuPDFWorkerClient();
            const promise = client.extract(new Uint8Array([1]), {
                pageIndices: [99999],
            });
            const worker = MockWorker.instances[0];
            worker.replyToLast({
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: ExtractionErrorCode.PAGE_OUT_OF_RANGE,
                    message: 'All requested page indices are out of range or non-integer (document has 3 pages)',
                    payload: { pageCount: 3 },
                },
            });
            try {
                await promise;
                expect.fail('expected throw');
            } catch (err) {
                expect(err).toBeInstanceOf(ExtractionError);
                expect((err as ExtractionError).code).toBe(ExtractionErrorCode.PAGE_OUT_OF_RANGE);
                expect((err as ExtractionError).pageCount).toBe(3);
            }
        });

        it('rehydrates NO_TEXT_LAYER with the full payload (ocrAnalysis/pageLabels/pageCount)', async () => {
            const client = getMuPDFWorkerClient();
            const promise = client.extract(new Uint8Array([0]), {
                settings: { checkTextLayer: true },
            });
            const worker = MockWorker.instances[0];
            const ocrAnalysis = {
                needsOCR: true,
                primaryReason: 'image_only',
                issueRatio: 0.95,
            };
            const pageLabels = { 0: 'i', 1: '1' };
            worker.replyToLast({
                ok: false,
                error: {
                    name: 'ExtractionError',
                    code: 'NO_TEXT_LAYER',
                    message: 'needs OCR',
                    payload: {
                        ocrAnalysis,
                        pageLabels,
                        pageCount: 50,
                    },
                },
            });

            await expect(promise).rejects.toBeInstanceOf(ExtractionError);
            await expect(promise).rejects.toMatchObject({
                name: 'ExtractionError',
                code: ExtractionErrorCode.NO_TEXT_LAYER,
                message: 'needs OCR',
                // ExtractionError stores OCR data on `details` (per types.ts:599),
                // even though the wire field is named `payload.ocrAnalysis`.
                details: ocrAnalysis,
                pageLabels,
                pageCount: 50,
            });
        });
    });

    describe('analyzeOCRNeeds', () => {
        it('round-trips an OCRDetectionResult', async () => {
            const client = getMuPDFWorkerClient();
            const promise = client.analyzeOCRNeeds(new Uint8Array([1]), {});
            const worker = MockWorker.instances[0];
            const canned = {
                needsOCR: false,
                primaryReason: 'sufficient_text',
                issueRatio: 0,
                issueBreakdown: {},
                pageAnalyses: [],
                sampledPages: 5,
                totalPages: 5,
            };
            worker.replyToLast({ ok: true, result: canned });
            await expect(promise).resolves.toEqual(canned);
        });
    });

    describe('search (scored)', () => {
        it('round-trips a PDFSearchResult', async () => {
            const client = getMuPDFWorkerClient();
            const promise = client.search(new Uint8Array([1]), 'foo');
            const worker = MockWorker.instances[0];
            const canned = {
                query: 'foo',
                totalMatches: 0,
                pagesWithMatches: 0,
                totalPages: 5,
                pages: [],
                metadata: { searchedAt: 'now', durationMs: 1, options: {}, scoringOptions: {} },
            };
            worker.replyToLast({ ok: true, result: canned });
            await expect(promise).resolves.toEqual(canned);

            const [message] = worker.opCall(0);
            expect(message).toMatchObject({ op: 'search', args: { query: 'foo' } });
        });

        it('passes args.maxPageCount as a top-level worker arg', async () => {
            const client = getMuPDFWorkerClient();
            const promise = client.search(
                new Uint8Array([1]),
                'foo',
                { maxHitsPerPage: 50 },
                { maxPageCount: 100 },
            );
            const worker = MockWorker.instances[0];
            worker.replyToLast({
                ok: true,
                result: {
                    query: 'foo',
                    totalMatches: 0,
                    pagesWithMatches: 0,
                    totalPages: 1,
                    pages: [],
                    metadata: { searchedAt: 'now', durationMs: 1, options: {}, scoringOptions: {} },
                },
            });
            await promise;
            const [message] = worker.opCall(0);
            // maxPageCount lives at the top level of args (sibling to options),
            // not inside the options bag.
            expect(message.args).toMatchObject({
                query: 'foo',
                maxPageCount: 100,
                options: { maxHitsPerPage: 50 },
            });
            expect(message.args.options).not.toHaveProperty('maxPageCount');
        });
    });

    describe('doc cache RPCs', () => {
        it('getCacheStats returns null when no worker has spawned', async () => {
            const client = getMuPDFWorkerClient();
            // Fresh client, no prior op — probeLiveWorker should return null
            // and getCacheStats must NOT spawn a worker.
            const stats = await client.getCacheStats();
            expect(stats).toBeNull();
            expect(MockWorker.instances.length).toBe(0);
        });

        it('clearWorkerCacheForTest is a no-op when no worker exists', async () => {
            const client = getMuPDFWorkerClient();
            const result = await client.clearWorkerCacheForTest();
            expect(result).toBeNull();
            expect(MockWorker.instances.length).toBe(0);
        });

        it('getCacheStats round-trips __cacheStats without growing dispatchCounts', async () => {
            const client = getMuPDFWorkerClient();
            // Spawn a worker via a real op so we have something to probe.
            const seed = client.getPageCount(new Uint8Array([1]));
            MockWorker.instances[0].replyToLast({ ok: true, result: { count: 1 } });
            await seed;

            const before = client.getStats();
            expect(before.dispatchCounts.getPageCount).toBe(1);

            const cacheReply = {
                entries: 0,
                totalBytes: 0,
                hits: 0,
                misses: 0,
                evictions: 0,
                discards: 0,
                ttlMs: 30_000,
                maxEntries: 3,
                maxBytes: 200 * 1024 * 1024,
                cryptoUsable: true,
            };
            const promise = client.getCacheStats();
            MockWorker.instances[0].replyToLast({ ok: true, result: cacheReply });
            await expect(promise).resolves.toEqual(cacheReply);

            const after = client.getStats();
            // __cacheStats must NOT pollute dispatchCounts.
            expect(after.dispatchCounts).toEqual(before.dispatchCounts);
            // Verify the wire op is __cacheStats, not 'getCacheStats' or similar.
            const lastPosted = MockWorker.instances[0].posted[
                MockWorker.instances[0].posted.length - 1
            ];
            expect((lastPosted.message as { op: string }).op).toBe('__cacheStats');
        });

        it('clearWorkerCacheForTest sends __cacheClear with resetCounters: true by default', async () => {
            const client = getMuPDFWorkerClient();
            const seed = client.getPageCount(new Uint8Array([1]));
            MockWorker.instances[0].replyToLast({ ok: true, result: { count: 1 } });
            await seed;

            const before = client.getStats();
            const promise = client.clearWorkerCacheForTest();
            MockWorker.instances[0].replyToLast({
                ok: true,
                result: {
                    entries: 0,
                    totalBytes: 0,
                    hits: 0,
                    misses: 0,
                    evictions: 0,
                    discards: 0,
                    ttlMs: 30_000,
                    maxEntries: 3,
                    maxBytes: 200 * 1024 * 1024,
                    cryptoUsable: true,
                },
            });
            await promise;

            const after = client.getStats();
            // __cacheClear must NOT pollute dispatchCounts either.
            expect(after.dispatchCounts).toEqual(before.dispatchCounts);
            const lastPosted = MockWorker.instances[0].posted[
                MockWorker.instances[0].posted.length - 1
            ];
            expect(lastPosted.message).toMatchObject({
                op: '__cacheClear',
                args: { resetCounters: true },
            });
        });

        it('clearWorkerCacheForTest forwards { resetCounters: false }', async () => {
            const client = getMuPDFWorkerClient();
            const seed = client.getPageCount(new Uint8Array([1]));
            MockWorker.instances[0].replyToLast({ ok: true, result: { count: 1 } });
            await seed;

            const promise = client.clearWorkerCacheForTest({ resetCounters: false });
            MockWorker.instances[0].replyToLast({
                ok: true,
                result: {
                    entries: 0,
                    totalBytes: 0,
                    hits: 5,
                    misses: 7,
                    evictions: 1,
                    discards: 2,
                    ttlMs: 30_000,
                    maxEntries: 3,
                    maxBytes: 200 * 1024 * 1024,
                    cryptoUsable: true,
                },
            });
            await promise;
            const lastPosted = MockWorker.instances[0].posted[
                MockWorker.instances[0].posted.length - 1
            ];
            expect(lastPosted.message).toMatchObject({
                op: '__cacheClear',
                args: { resetCounters: false },
            });
        });
    });

    describe('extractSentenceDebug', () => {
        // Production sentence-level extraction goes through `extract({ mode:
        // "structured" })` (covered in `pdfExtractorSentenceBBoxes.test.ts`).
        // This op is debug-only — the worker always returns
        // `SentenceTraceResult = { result, trace }`.

        it('round-trips a SentenceTraceResult', async () => {
            const client = getMuPDFWorkerClient();
            const promise = client.extractSentenceDebug(
                new Uint8Array([1]),
                0,
            );
            const worker = MockWorker.instances[0];
            const traceReply = {
                result: {
                    items: [],
                    sentences: [],
                },
                trace: {
                    analysisPageIndices: [0],
                    rawDoc: { pageCount: 1, pages: [] },
                    detailed: { pageIndex: 0, pageNumber: 1, width: 0, height: 0, blocks: [] },
                    pagesForFilter: [],
                    marginAnalysis: { elements: new Map(), counts: { top: 0, bottom: 0, left: 0, right: 0 } },
                    marginRemoval: {
                        candidates: [],
                        textsToRemove: new Set(),
                        removalsByPage: new Map(),
                    },
                    fillBoundaries: [],
                    dividerLines: [],
                    filteredResult: {},
                },
            };
            worker.replyToLast({ ok: true, result: traceReply });
            const out = await promise;
            const [message] = worker.opCall(0);
            expect(message).toMatchObject({
                op: 'extractSentenceDebug',
                args: { pageIndex: 0 },
            });
            // The promise resolves to the trace envelope shape.
            expect(out).toHaveProperty('result');
            expect(out).toHaveProperty('trace');
            expect((out as { trace: { analysisPageIndices: number[] } }).trace.analysisPageIndices).toEqual([0]);
        });

        it('forwards splitterConfig as a serializable object', async () => {
            const client = getMuPDFWorkerClient();
            const promise = client.extractSentenceDebug(
                new Uint8Array([1]),
                3,
                {
                    splitterConfig: { type: 'sentencex', language: 'de' },
                    analysisWindow: 5,
                },
            );
            const worker = MockWorker.instances[0];
            worker.replyToLast({
                ok: true,
                result: { result: { items: [], sentences: [] }, trace: {} },
            });
            await promise;
            const [message] = worker.opCall(0);
            expect(message).toMatchObject({
                op: 'extractSentenceDebug',
                args: {
                    pageIndex: 3,
                    options: {
                        splitterConfig: { type: 'sentencex', language: 'de' },
                        analysisWindow: 5,
                    },
                },
            });
            // Function-typed `splitter` and `precomputed` are not part of
            // the worker boundary — neither should appear on the wire.
            expect(message.args.options).not.toHaveProperty('splitter');
            expect(message.args.options).not.toHaveProperty('precomputed');
        });

        it('forwards { type: "simple" } as splitterConfig', async () => {
            const client = getMuPDFWorkerClient();
            const promise = client.extractSentenceDebug(
                new Uint8Array([1]),
                0,
                { splitterConfig: { type: 'simple' } },
            );
            const worker = MockWorker.instances[0];
            worker.replyToLast({
                ok: true,
                result: { result: { items: [], sentences: [] }, trace: {} },
            });
            await promise;
            const [message] = worker.opCall(0);
            expect(message.args.options.splitterConfig).toEqual({
                type: 'simple',
            });
        });

    });

    // ------------------------------------------------------------------
    // Named slots: hot vs background
    // ------------------------------------------------------------------
    describe('named slots', () => {
        afterEach(async () => {
            await disposeMuPDFWorker();
            __resetIdleTimeoutForTest('hot');
            __resetIdleTimeoutForTest('background');
            delete (globalThis as any).Zotero.__beaverMuPDFWorkerClient_hot;
            delete (globalThis as any).Zotero.__beaverMuPDFWorkerClient_background;
        });

        it('getMuPDFWorkerClient("background") returns a different instance than default ("hot")', () => {
            const hot = getMuPDFWorkerClient();
            const bg = getMuPDFWorkerClient('background');
            expect(hot).not.toBe(bg);
            expect((hot as any).name).toBe('hot');
            expect((bg as any).name).toBe('background');
        });

        it('parks each instance in its own slot', () => {
            const hot = getMuPDFWorkerClient('hot');
            const bg = getMuPDFWorkerClient('background');
            expect((globalThis as any).Zotero.__beaverMuPDFWorkerClient_hot).toBe(hot);
            expect((globalThis as any).Zotero.__beaverMuPDFWorkerClient_background).toBe(bg);
        });

        it('getExistingMuPDFWorkerClient returns null on a fresh slot and does not spawn', () => {
            expect(getExistingMuPDFWorkerClient('hot')).toBeNull();
            expect(getExistingMuPDFWorkerClient('background')).toBeNull();
            // No client was created — slot still empty.
            expect((globalThis as any).Zotero.__beaverMuPDFWorkerClient_hot).toBeUndefined();
            expect((globalThis as any).Zotero.__beaverMuPDFWorkerClient_background).toBeUndefined();
        });

        it('disposeMuPDFWorker("hot") clears only the hot slot', async () => {
            const hot = getMuPDFWorkerClient('hot');
            const bg = getMuPDFWorkerClient('background');
            await disposeMuPDFWorker('hot');
            expect((globalThis as any).Zotero.__beaverMuPDFWorkerClient_hot).toBeUndefined();
            expect((globalThis as any).Zotero.__beaverMuPDFWorkerClient_background).toBe(bg);
            // hot was disposed; new lookup returns a different fresh instance.
            const hot2 = getMuPDFWorkerClient('hot');
            expect(hot2).not.toBe(hot);
        });

        it('disposeMuPDFWorker() with no argument disposes both slots', async () => {
            getMuPDFWorkerClient('hot');
            getMuPDFWorkerClient('background');
            await disposeMuPDFWorker();
            expect((globalThis as any).Zotero.__beaverMuPDFWorkerClient_hot).toBeUndefined();
            expect((globalThis as any).Zotero.__beaverMuPDFWorkerClient_background).toBeUndefined();
        });

        // A client whose own dispose() leaves the slot populated stands in for
        // a stale client from a prior bundle whose dispose() cannot clear the
        // shared global. The shutdown path passes force so the current bundle
        // clears the slot regardless, preventing reuse by the next bundle.
        it('force clears a slot whose in-slot client dispose() leaves it populated', async () => {
            const stale = { dispose: vi.fn() };
            (globalThis as any).Zotero.__beaverMuPDFWorkerClient_hot = stale;

            // Without force: dispose() runs but the slot is left populated.
            await disposeMuPDFWorker('hot');
            expect(stale.dispose).toHaveBeenCalledOnce();
            expect((globalThis as any).Zotero.__beaverMuPDFWorkerClient_hot).toBe(stale);

            // With force: the slot is cleared even though dispose() did not.
            await disposeMuPDFWorker('hot', { force: true });
            expect(stale.dispose).toHaveBeenCalledTimes(2);
            expect((globalThis as any).Zotero.__beaverMuPDFWorkerClient_hot).toBeUndefined();
        });
    });
});
