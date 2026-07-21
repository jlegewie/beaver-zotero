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
    MuPDFWorkerClient,
    getMuPDFWorkerClient,
    getExistingMuPDFWorkerClient,
    disposeMuPDFWorker,
    DEFAULT_BUSY_LEASE_MS_BACKGROUND,
    DEFAULT_BUSY_LEASE_MS_HOT,
    WorkerAbortError,
    WorkerDeadlineError,
    StaleWorkerError,
    WorkerSpawnError,
    isWorkerDeadlineError,
    __setIdleTimeoutForTest,
    __resetIdleTimeoutForTest,
    __setModuleWindowForTest,
    __resetModuleWindowForTest,
} from '../../../src/beaver-extract/MuPDFWorkerClient';
import {
    DEFAULT_ATTACHMENT_IMAGE_TIMEOUT_SECONDS,
    DEFAULT_IMAGES_TIMEOUT_SECONDS,
    DEFAULT_PAGES_TIMEOUT_SECONDS,
    DEFAULT_SEARCH_TIMEOUT_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
    MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS,
    MAX_PDF_TIMEOUT_SECONDS,
} from '../../../src/services/agentDataProvider/timeout';
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
        vi.useFakeTimers();
        vi.setSystemTime(12_000);
        MockWorker.dropNextConfigureAck = true;
        try {
            const client = getMuPDFWorkerClient();
            const promise = client.getPageCount(new Uint8Array([0]));
            const worker = MockWorker.instances[0];

            expect(worker.configureMessages).toHaveLength(1);
            expect(worker.posted).toHaveLength(0);
            expect(client.inFlight).toBe(1);
            expect(client.oldestInFlightStartedAt).toBe(12_000);

            await vi.advanceTimersByTimeAsync(500);
            expect(client.oldestInFlightStartedAt).toBe(12_000);

            worker.sendReady();
            await vi.advanceTimersByTimeAsync(0);

            expect(worker.configureMessages).toHaveLength(2);
            expect(worker.posted[0].message).toMatchObject({ op: 'getPageCount' });
            expect(client.inFlight).toBe(1);
            expect(client.oldestInFlightStartedAt).toBe(12_000);

            worker.replyToLast({ ok: true, result: { count: 2 } });
            await expect(promise).resolves.toBe(2);
            expect(client.inFlight).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('aborting while waiting for startup terminates the worker without posting an op', async () => {
        MockWorker.dropNextConfigureAck = true;
        const client = getMuPDFWorkerClient();
        const controller = new AbortController();
        const promise = client.getPageCount(new Uint8Array([0]), controller.signal);
        const worker = MockWorker.instances[0];

        expect(worker.configureMessages).toHaveLength(1);
        expect(worker.posted).toHaveLength(0);
        expect(client.inFlight).toBe(1);

        controller.abort();

        await expect(promise).rejects.toBeInstanceOf(WorkerAbortError);
        expect(client.inFlight).toBe(0);
        expect(client.oldestInFlightStartedAt).toBe(0);
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

    describe('proactive recycling', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it('recycles an idle hot worker after its observed heap reaches the limit', async () => {
            vi.useFakeTimers();
            const client = new MuPDFWorkerClient({
                recycleHeapBytes: 512,
                recycleAfterDataOperations: 32,
            });
            try {
                const firstOp = client.getPageCount(new Uint8Array([1]));
                const first = MockWorker.instances[0];
                first.replyToLast({
                    ok: true,
                    result: { count: 1 },
                    heapBytes: 512,
                });
                await expect(firstOp).resolves.toBe(1);

                expect(client.getStats()).toMatchObject({
                    hasWorker: true,
                    workerHeapBytes: 512,
                    peakWorkerHeapBytes: 512,
                    completedDataOperationsSinceSpawn: 1,
                    proactiveRecyclePending: true,
                    proactiveRecycleCount: 0,
                });

                await vi.advanceTimersByTimeAsync(0);

                expect(first.terminate).toHaveBeenCalledOnce();
                expect(client.getStats()).toMatchObject({
                    hasWorker: false,
                    workerHeapBytes: null,
                    completedDataOperationsSinceSpawn: 0,
                    proactiveRecyclePending: false,
                    proactiveRecycleCount: 1,
                    lastProactiveRecycleReason: 'heap_limit',
                    lastProactiveRecycleHeapBytes: 512,
                    lastProactiveRecycleDataOperations: 1,
                });

                const secondOp = client.getPageCount(new Uint8Array([2]));
                const second = MockWorker.instances[1];
                expect(second).toBeDefined();
                second.replyToLast({
                    ok: true,
                    result: { count: 2 },
                    heapBytes: 64,
                });
                await expect(secondOp).resolves.toBe(2);
                expect(client.getStats()).toMatchObject({
                    hasWorker: true,
                    spawnCount: 2,
                    workerHeapBytes: 64,
                    completedDataOperationsSinceSpawn: 1,
                });
            } finally {
                client.dispose();
            }
        });

        it('applies the heap guard to the background slot without an operation-count limit', async () => {
            vi.useFakeTimers();
            const client = new MuPDFWorkerClient({ slotName: 'background' });
            try {
                expect(client.getStats()).toMatchObject({
                    recycleHeapThresholdBytes: 512 * 1024 * 1024,
                    recycleDataOperationThreshold: null,
                });

                const op = client.getPageCount(new Uint8Array([1]));
                const worker = MockWorker.instances[0];
                worker.replyToLast({
                    ok: true,
                    result: { count: 1 },
                    heapBytes: 512 * 1024 * 1024,
                });
                await expect(op).resolves.toBe(1);
                await vi.advanceTimersByTimeAsync(0);

                expect(worker.terminate).toHaveBeenCalledOnce();
                expect(client.getStats()).toMatchObject({
                    hasWorker: false,
                    proactiveRecycleCount: 1,
                    lastProactiveRecycleReason: 'heap_limit',
                });
            } finally {
                client.dispose();
            }
        });

        it('waits for every accepted operation before count-based recycling', async () => {
            vi.useFakeTimers();
            const client = new MuPDFWorkerClient({
                recycleHeapBytes: null,
                recycleAfterDataOperations: 2,
            });
            try {
                const firstOp = client.getPageCount(new Uint8Array([1]));
                const secondOp = client.getPageCount(new Uint8Array([2]));
                const worker = MockWorker.instances[0];
                const firstId = worker.posted[0].message.id;
                const secondId = worker.posted[1].message.id;

                worker.onmessage?.({
                    data: {
                        id: firstId,
                        ok: true,
                        result: { count: 1 },
                        heapBytes: 64,
                    },
                });
                await expect(firstOp).resolves.toBe(1);
                expect(client.getStats()).toMatchObject({
                    pendingCount: 1,
                    completedDataOperationsSinceSpawn: 1,
                    proactiveRecyclePending: false,
                });
                await vi.advanceTimersByTimeAsync(0);
                expect(worker.terminate).not.toHaveBeenCalled();

                worker.onmessage?.({
                    data: {
                        id: secondId,
                        ok: true,
                        result: { count: 2 },
                        heapBytes: 64,
                    },
                });
                await expect(secondOp).resolves.toBe(2);
                expect(client.getStats()).toMatchObject({
                    pendingCount: 0,
                    completedDataOperationsSinceSpawn: 2,
                    proactiveRecyclePending: true,
                });

                await vi.advanceTimersByTimeAsync(0);
                expect(worker.terminate).toHaveBeenCalledOnce();
                expect(client.getStats()).toMatchObject({
                    hasWorker: false,
                    proactiveRecycleCount: 1,
                    lastProactiveRecycleReason: 'data_operation_limit',
                    lastProactiveRecycleDataOperations: 2,
                });
            } finally {
                client.dispose();
            }
        });

        it('allows one chained follow-up, then routes the next sequential operation to a fresh worker', async () => {
            vi.useFakeTimers();
            const client = new MuPDFWorkerClient({
                recycleHeapBytes: null,
                recycleAfterDataOperations: 1,
            });
            try {
                const firstOp = client.getPageCount(new Uint8Array([1]));
                const worker = MockWorker.instances[0];
                worker.replyToLast({
                    ok: true,
                    result: { count: 1 },
                    heapBytes: 64,
                });

                // Awaiting the first call resumes in a microtask, before the
                // zero-delay recycle check. A related follow-up dispatch can
                // therefore stay on the warm worker.
                await expect(firstOp).resolves.toBe(1);
                const secondOp = client.getPageCount(new Uint8Array([2]));
                expect(worker.posted).toHaveLength(2);
                expect(MockWorker.instances).toHaveLength(1);

                await vi.advanceTimersByTimeAsync(0);
                expect(worker.terminate).not.toHaveBeenCalled();

                worker.replyToLast({
                    ok: true,
                    result: { count: 2 },
                    heapBytes: 64,
                });
                await expect(secondOp).resolves.toBe(2);

                // A sequential loop resumes before the retirement timer too,
                // but the one-operation grace is now exhausted. This dispatch
                // synchronously retires the idle worker and uses a fresh one.
                const thirdOp = client.getPageCount(new Uint8Array([3]));
                expect(worker.terminate).toHaveBeenCalledOnce();
                expect(worker.posted).toHaveLength(2);
                expect(MockWorker.instances).toHaveLength(2);

                const replacement = MockWorker.instances[1];
                replacement.replyToLast({
                    ok: true,
                    result: { count: 3 },
                    heapBytes: 64,
                });
                await expect(thirdOp).resolves.toBe(3);
                expect(client.getStats()).toMatchObject({
                    proactiveRecycleCount: 1,
                    lastProactiveRecycleReason: 'data_operation_limit',
                });
            } finally {
                client.dispose();
            }
        });

        it('holds operations beyond the grace behind the drain barrier', async () => {
            vi.useFakeTimers();
            const client = new MuPDFWorkerClient({
                recycleHeapBytes: null,
                recycleAfterDataOperations: 1,
            });
            try {
                const firstOp = client.getPageCount(new Uint8Array([1]));
                const worker = MockWorker.instances[0];
                worker.replyToLast({
                    ok: true,
                    result: { count: 1 },
                    heapBytes: 64,
                });
                await expect(firstOp).resolves.toBe(1);

                const followupOp = client.getPageCount(new Uint8Array([2]));
                const blockedOp = client.getPageCount(new Uint8Array([3]));
                expect(worker.posted).toHaveLength(2);
                expect(client.getStats().pendingCount).toBe(1);

                worker.replyToLast({
                    ok: true,
                    result: { count: 2 },
                    heapBytes: 64,
                });
                await expect(followupOp).resolves.toBe(2);
                await vi.advanceTimersByTimeAsync(0);

                expect(worker.terminate).toHaveBeenCalledOnce();
                expect(worker.posted).toHaveLength(2);
                expect(MockWorker.instances).toHaveLength(2);

                const replacement = MockWorker.instances[1];
                replacement.replyToLast({
                    ok: true,
                    result: { count: 3 },
                    heapBytes: 64,
                });
                await expect(blockedOp).resolves.toBe(3);
            } finally {
                client.dispose();
            }
        });

        it('keeps fatal-operation suppression after a proactive recycle', async () => {
            vi.useFakeTimers();
            const client = new MuPDFWorkerClient({
                recycleHeapBytes: null,
                recycleAfterDataOperations: 1,
            });
            try {
                const badBytes = new Uint8Array([2]);
                const bad = client.getPageCount(badBytes);
                const first = MockWorker.instances[0];
                first.replyToLast({
                    ok: false,
                    error: {
                        name: 'ExtractionError',
                        code: ExtractionErrorCode.WASM_ERROR,
                        message: 'fatal parser failure',
                    },
                    heapBytes: 128,
                });
                await expect(bad).rejects.toMatchObject({
                    code: ExtractionErrorCode.WASM_ERROR,
                });

                const good = client.getPageCount(new Uint8Array([3]));
                const second = MockWorker.instances[1];
                second.replyToLast({
                    ok: true,
                    result: { count: 3 },
                    heapBytes: 128,
                });
                await expect(good).resolves.toBe(3);
                await vi.advanceTimersByTimeAsync(0);
                expect(second.terminate).toHaveBeenCalledOnce();

                await expect(
                    client.getPageCount(new Uint8Array([2])),
                ).rejects.toMatchObject({
                    code: ExtractionErrorCode.WASM_ERROR,
                });
                expect(MockWorker.instances).toHaveLength(2);
            } finally {
                client.dispose();
            }
        });
    });

    describe('busy-age lease', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        function replyToOp(
            worker: MockWorker,
            op: string,
            result: unknown,
        ): void {
            const posted = worker.posted.find((entry) => entry.message.op === op);
            expect(posted).toBeDefined();
            worker.onmessage?.({
                data: { id: posted!.message.id, ok: true, result },
            });
        }

        it('reaps the overdue oldest op without retrying it while siblings recover', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(10_000);
            const client = new MuPDFWorkerClient({
                busyLeaseMs: 100,
                recycleHeapBytes: null,
                recycleAfterDataOperations: null,
            });
            try {
                const oldest = client.call<number>('opA');
                const oldestOutcome = oldest.catch((error) => error);
                const sibling = client.call<number>('opB');
                const first = MockWorker.instances[0];

                vi.setSystemTime(10_100);
                const triggering = client.call<number>('opC');
                await vi.advanceTimersByTimeAsync(0);

                expect(first.terminate).toHaveBeenCalledOnce();
                expect(first.posted.map((entry) => entry.message.op)).toEqual([
                    'opA',
                    'opB',
                ]);
                const replacement = MockWorker.instances[1];
                expect(replacement).toBeDefined();
                expect(replacement.posted.map((entry) => entry.message.op).sort()).toEqual([
                    'opB',
                    'opC',
                ]);

                replyToOp(replacement, 'opB', 2);
                replyToOp(replacement, 'opC', 3);

                await expect(oldestOutcome).resolves.toBeInstanceOf(WorkerDeadlineError);
                await expect(sibling).resolves.toBe(2);
                await expect(triggering).resolves.toBe(3);
                expect(
                    MockWorker.instances.flatMap((worker) =>
                        worker.posted.filter((entry) => entry.message.op === 'opA'),
                    ),
                ).toHaveLength(1);
                expect(client.getStats()).toMatchObject({
                    retryCount: 1,
                    leaseReapCount: 1,
                    lastLeaseReapOp: 'opA',
                    lastLeaseReapAgeMs: 100,
                });
            } finally {
                client.dispose();
            }
        });

        it('does not reap operations before the lease or before the watchdog deadline', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(20_000);
            const client = new MuPDFWorkerClient({ busyLeaseMs: 2_000 });
            try {
                const firstOp = client.call<number>('first');
                const worker = MockWorker.instances[0];

                await vi.advanceTimersByTimeAsync(1_999);
                const secondOp = client.call<number>('second');
                expect(worker.terminate).not.toHaveBeenCalled();
                expect(client.getStats().leaseReapCount).toBe(0);

                replyToOp(worker, 'first', 1);
                replyToOp(worker, 'second', 2);
                await expect(firstOp).resolves.toBe(1);
                await expect(secondOp).resolves.toBe(2);

                await vi.advanceTimersByTimeAsync(10_000);
                expect(worker.terminate).not.toHaveBeenCalled();
                expect(client.getStats().leaseReapCount).toBe(0);
            } finally {
                client.dispose();
            }
        });

        it('watchdog reaps a wedged worker without a subsequent dispatch', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(30_000);
            const client = new MuPDFWorkerClient({ busyLeaseMs: 100 });
            try {
                const operation = client.call<number>('wedged');
                const outcome = operation.catch((error) => error);
                const worker = MockWorker.instances[0];

                await vi.advanceTimersByTimeAsync(1_100);

                await expect(outcome).resolves.toBeInstanceOf(WorkerDeadlineError);
                expect(worker.terminate).toHaveBeenCalledOnce();
                expect(client.inFlight).toBe(0);
                expect(client.getStats()).toMatchObject({
                    hasWorker: false,
                    leaseReapCount: 1,
                    lastLeaseReapTime: 31_100,
                    lastLeaseReapOp: 'wedged',
                    lastLeaseReapAgeMs: 1_100,
                });
            } finally {
                client.dispose();
            }
        });

        it('clears the watchdog after normal drain, stale recovery, and dispose', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(40_000);

            const drained = new MuPDFWorkerClient({ busyLeaseMs: 100 });
            const drainedOp = drained.call<number>('drained');
            const drainedWorker = MockWorker.instances[0];
            replyToOp(drainedWorker, 'drained', 1);
            await expect(drainedOp).resolves.toBe(1);
            await vi.advanceTimersByTimeAsync(1_100);
            expect(drainedWorker.terminate).not.toHaveBeenCalled();
            expect(drained.getStats().leaseReapCount).toBe(0);
            drained.dispose();

            const recovered = new MuPDFWorkerClient({ busyLeaseMs: 100 });
            const recoveredOp = recovered.call<number>('recovered');
            const staleWorker = MockWorker.instances[1];
            recovered.markStaleForTest();
            await vi.advanceTimersByTimeAsync(0);
            const freshWorker = MockWorker.instances[2];
            replyToOp(freshWorker, 'recovered', 2);
            await expect(recoveredOp).resolves.toBe(2);
            await vi.advanceTimersByTimeAsync(1_100);
            expect(staleWorker.terminate).toHaveBeenCalledOnce();
            expect(freshWorker.terminate).not.toHaveBeenCalled();
            expect(recovered.getStats().leaseReapCount).toBe(0);
            recovered.dispose();

            const disposed = new MuPDFWorkerClient({ busyLeaseMs: 100 });
            const disposedOp = disposed.call<number>('disposed');
            const disposedOutcome = disposedOp.catch((error) => error);
            const disposedWorker = MockWorker.instances[3];
            disposed.dispose();
            await expect(disposedOutcome).resolves.toBeInstanceOf(StaleWorkerError);
            await vi.advanceTimersByTimeAsync(1_100);
            expect(disposedWorker.terminate).toHaveBeenCalledOnce();
            expect(disposed.getStats().leaseReapCount).toBe(0);
        });

        it('reschedules the watchdog when the oldest operation completes', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(50_000);
            const client = new MuPDFWorkerClient({ busyLeaseMs: 100 });
            try {
                const firstOp = client.call<number>('first');
                const worker = MockWorker.instances[0];
                await vi.advanceTimersByTimeAsync(50);
                const secondOp = client.call<number>('second');
                const secondOutcome = secondOp.catch((error) => error);

                await vi.advanceTimersByTimeAsync(50);
                replyToOp(worker, 'first', 1);
                await expect(firstOp).resolves.toBe(1);

                await vi.advanceTimersByTimeAsync(1_000);
                expect(worker.terminate).not.toHaveBeenCalled();
                await vi.advanceTimersByTimeAsync(50);

                await expect(secondOutcome).resolves.toBeInstanceOf(WorkerDeadlineError);
                expect(worker.terminate).toHaveBeenCalledOnce();
                expect(client.getStats()).toMatchObject({
                    lastLeaseReapOp: 'second',
                    lastLeaseReapAgeMs: 1_100,
                });
            } finally {
                client.dispose();
            }
        });

        it('reaps before parking a new call on an overdue recycle barrier', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(60_000);
            const client = new MuPDFWorkerClient({
                busyLeaseMs: 100,
                recycleHeapBytes: null,
                recycleAfterDataOperations: 1,
            });
            try {
                const thresholdOp = client.call<number>('threshold');
                const first = MockWorker.instances[0];
                first.replyToLast({ ok: true, result: 1, heapBytes: 64 });
                await expect(thresholdOp).resolves.toBe(1);

                const wedged = client.call<number>('wedged');
                const wedgedOutcome = wedged.catch((error) => error);
                const blocked = client.call<number>('blocked');
                expect(first.posted.map((entry) => entry.message.op)).toEqual([
                    'threshold',
                    'wedged',
                ]);

                vi.setSystemTime(60_100);
                const triggering = client.call<number>('triggering');
                await vi.advanceTimersByTimeAsync(0);

                expect(first.terminate).toHaveBeenCalledOnce();
                const replacement = MockWorker.instances[1];
                expect(replacement.posted.map((entry) => entry.message.op).sort()).toEqual([
                    'blocked',
                    'triggering',
                ]);
                replyToOp(replacement, 'blocked', 2);
                replyToOp(replacement, 'triggering', 3);

                await expect(wedgedOutcome).resolves.toBeInstanceOf(WorkerDeadlineError);
                await expect(blocked).resolves.toBe(2);
                await expect(triggering).resolves.toBe(3);
                expect(client.getStats()).toMatchObject({
                    leaseReapCount: 1,
                    lastLeaseReapOp: 'wedged',
                });
            } finally {
                client.dispose();
            }
        });

        it('recycles synchronously when the final posted op drains with barrier waiters', async () => {
            vi.useFakeTimers();
            const client = new MuPDFWorkerClient({
                recycleHeapBytes: null,
                recycleAfterDataOperations: 1,
            });
            try {
                const thresholdOp = client.call<number>('threshold');
                const first = MockWorker.instances[0];
                first.replyToLast({ ok: true, result: 1, heapBytes: 64 });
                await expect(thresholdOp).resolves.toBe(1);

                const followup = client.call<number>('followup');
                const blocked = client.call<number>('blocked');
                expect(first.posted).toHaveLength(2);

                replyToOp(first, 'followup', 2);
                expect(first.terminate).toHaveBeenCalledOnce();
                await expect(followup).resolves.toBe(2);
                await Promise.resolve();

                const replacement = MockWorker.instances[1];
                replyToOp(replacement, 'blocked', 3);
                await expect(blocked).resolves.toBe(3);
                expect(client.getStats().proactiveRecycleCount).toBe(1);
            } finally {
                client.dispose();
            }
        });

        it('reaps a startup wedge and lets original and triggering calls recover', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(70_000);
            MockWorker.dropNextConfigureAck = true;
            const client = new MuPDFWorkerClient({ busyLeaseMs: 100 });
            try {
                const original = client.call<number>('original');
                const first = MockWorker.instances[0];
                expect(first.posted).toHaveLength(0);

                vi.setSystemTime(70_100);
                const triggering = client.call<number>('triggering');
                await vi.advanceTimersByTimeAsync(0);

                expect(first.terminate).toHaveBeenCalledOnce();
                const replacement = MockWorker.instances[1];
                replyToOp(replacement, 'original', 1);
                replyToOp(replacement, 'triggering', 2);
                await expect(original).resolves.toBe(1);
                await expect(triggering).resolves.toBe(2);
                expect(client.getStats()).toMatchObject({
                    leaseReapCount: 1,
                    lastLeaseReapOp: 'startup',
                    lastLeaseReapAgeMs: 100,
                });
            } finally {
                client.dispose();
            }
        });

        it('propagates stale failure when the one startup retry also wedges', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(80_000);
            MockWorker.dropNextConfigureAck = true;
            const client = new MuPDFWorkerClient({ busyLeaseMs: 100 });
            try {
                const original = client.call<number>('original');
                const originalOutcome = original.catch((error) => error);

                vi.setSystemTime(80_100);
                MockWorker.dropNextConfigureAck = true;
                const triggering = client.call<number>('triggering');
                const triggeringOutcome = triggering.catch((error) => error);
                await vi.advanceTimersByTimeAsync(0);
                expect(MockWorker.instances[1].posted).toHaveLength(0);

                await vi.advanceTimersByTimeAsync(1_100);
                await expect(originalOutcome).resolves.toBeInstanceOf(StaleWorkerError);

                const third = MockWorker.instances[2];
                expect(third).toBeDefined();
                replyToOp(third, 'triggering', 3);
                await expect(triggeringOutcome).resolves.toBe(3);
                expect(client.getStats()).toMatchObject({
                    leaseReapCount: 2,
                    lastLeaseReapOp: 'startup',
                });
            } finally {
                client.dispose();
            }
        });

        it('uses slot defaults, accepts an override, and allows disabling the lease', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(100_000);
            const hot = new MuPDFWorkerClient({ slotName: 'hot' });
            const background = new MuPDFWorkerClient({ slotName: 'background' });
            const hotOutcome = hot.call<number>('hot').catch((error) => error);
            const backgroundOutcome = background.call<number>('background').catch((error) => error);
            const hotWorker = MockWorker.instances[0];
            const backgroundWorker = MockWorker.instances[1];

            await vi.advanceTimersByTimeAsync(DEFAULT_BUSY_LEASE_MS_HOT + 1_000);
            await expect(hotOutcome).resolves.toBeInstanceOf(WorkerDeadlineError);
            expect(hotWorker.terminate).toHaveBeenCalledOnce();
            expect(backgroundWorker.terminate).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(
                DEFAULT_BUSY_LEASE_MS_BACKGROUND - DEFAULT_BUSY_LEASE_MS_HOT,
            );
            await expect(backgroundOutcome).resolves.toBeInstanceOf(WorkerDeadlineError);
            expect(backgroundWorker.terminate).toHaveBeenCalledOnce();
            hot.dispose();
            background.dispose();

            const overridden = new MuPDFWorkerClient({ busyLeaseMs: 100 });
            const overrideOutcome = overridden.call<number>('override').catch((error) => error);
            await vi.advanceTimersByTimeAsync(1_100);
            await expect(overrideOutcome).resolves.toBeInstanceOf(WorkerDeadlineError);
            overridden.dispose();

            const disabled = new MuPDFWorkerClient({ busyLeaseMs: null });
            const disabledOp = disabled.call<number>('disabled');
            const disabledOutcome = disabledOp.catch((error) => error);
            const disabledWorker = MockWorker.instances.at(-1)!;
            await vi.advanceTimersByTimeAsync(DEFAULT_BUSY_LEASE_MS_BACKGROUND * 2);
            expect(disabledWorker.terminate).not.toHaveBeenCalled();
            expect(disabled.getStats().leaseReapCount).toBe(0);
            disabled.dispose();
            await expect(disabledOutcome).resolves.toBeInstanceOf(StaleWorkerError);
        });

        it('classifies deadline errors across bundle identities', () => {
            expect(isWorkerDeadlineError(new WorkerDeadlineError())).toBe(true);
            expect(isWorkerDeadlineError({ name: 'WorkerDeadlineError' })).toBe(true);
            expect(isWorkerDeadlineError(new Error('different'))).toBe(false);
        });

        it('resetStats clears lease enforcement telemetry', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(200_000);
            const client = new MuPDFWorkerClient({ busyLeaseMs: 100 });
            try {
                const outcome = client.call<number>('wedged').catch((error) => error);
                await vi.advanceTimersByTimeAsync(1_100);
                await expect(outcome).resolves.toBeInstanceOf(WorkerDeadlineError);
                expect(client.getStats()).toMatchObject({
                    leaseReapCount: 1,
                    lastLeaseReapTime: 201_100,
                    lastLeaseReapOp: 'wedged',
                    lastLeaseReapAgeMs: 1_100,
                });

                client.resetStats();
                expect(client.getStats()).toMatchObject({
                    leaseReapCount: 0,
                    lastLeaseReapTime: null,
                    lastLeaseReapOp: null,
                    lastLeaseReapAgeMs: null,
                });
            } finally {
                client.dispose();
            }
        });

        it('keeps the hot lease above every hot-path default timeout', () => {
            const hotPathDefaultsMs = [
                DEFAULT_TIMEOUT_SECONDS,
                DEFAULT_PAGES_TIMEOUT_SECONDS,
                DEFAULT_SEARCH_TIMEOUT_SECONDS,
                DEFAULT_IMAGES_TIMEOUT_SECONDS,
                DEFAULT_ATTACHMENT_IMAGE_TIMEOUT_SECONDS,
            ].map((seconds) => seconds * 1_000);

            expect(DEFAULT_BUSY_LEASE_MS_HOT).toBeGreaterThan(
                Math.max(...hotPathDefaultsMs),
            );
        });

        it('keeps the hot lease above the interactive request ceiling', () => {
            expect(DEFAULT_BUSY_LEASE_MS_HOT).toBeGreaterThan(
                MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS * 1_000,
            );
        });

        it('keeps the background lease above the shared-extraction ceiling', () => {
            expect(DEFAULT_BUSY_LEASE_MS_BACKGROUND).toBeGreaterThan(
                MAX_PDF_TIMEOUT_SECONDS * 1_000,
            );
        });
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
            expect(after.completedDataOperationsSinceSpawn).toBe(
                before.completedDataOperationsSinceSpawn,
            );
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
            expect(hot.getStats()).toMatchObject({
                recycleHeapThresholdBytes: 512 * 1024 * 1024,
                recycleDataOperationThreshold: 32,
            });
            expect(bg.getStats()).toMatchObject({
                recycleHeapThresholdBytes: 512 * 1024 * 1024,
                recycleDataOperationThreshold: null,
            });
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

    describe('realm-safe timers and creator-realm self-heal', () => {
        afterEach(() => {
            __resetModuleWindowForTest();
        });

        it('schedules internal watchdogs through config-injected timers', async () => {
            const scheduledDelays: number[] = [];
            const cleared: unknown[] = [];
            let nextTimerId = 1;
            configurePDFForTests({
                slotHost: (globalThis as any).Zotero,
                getWorkerHost: () => ({ Worker: MockWorker }) as unknown as Window,
                timers: {
                    setTimeout: (_callback, delayMs) => {
                        scheduledDelays.push(delayMs);
                        return nextTimerId++;
                    },
                    clearTimeout: (id) => cleared.push(id),
                },
            });

            const client = getMuPDFWorkerClient();
            const buf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
            const promise = client.getPageCount(buf);
            const worker = MockWorker.instances[0];

            // The configure-handshake timeout and the busy-lease watchdog
            // both arm through the injected scheduler.
            expect(scheduledDelays).toContain(15000);
            expect(
                scheduledDelays.some((ms) => ms > DEFAULT_BUSY_LEASE_MS_HOT),
            ).toBe(true);
            // The synchronous configure ack cancels its timeout through the
            // same injected implementation.
            expect(cleared.length).toBeGreaterThan(0);

            worker.replyToLast({ ok: true, result: { count: 3 } });
            await expect(promise).resolves.toBe(3);
        });

        it('replaces the shared client when its creating window is gone', async () => {
            const creatorWindow = { closed: false } as unknown as Window;
            __setModuleWindowForTest(creatorWindow);
            const first = getMuPDFWorkerClient();
            expect(first.createdFromWindow).toBe(creatorWindow);
            expect(getMuPDFWorkerClient()).toBe(first);

            // Leave an operation in flight so replacement must tear the old
            // client down, not merely drop the slot reference.
            const buf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
            const inFlight = first.getPageCount(buf);
            const firstWorker = MockWorker.instances[0];
            expect(firstWorker).toBeDefined();

            // Close the creating window; the next lookup happens from a
            // reopened window's bundle and must replace the stale client.
            (creatorWindow as { closed: boolean }).closed = true;
            const reopenedWindow = { closed: false } as unknown as Window;
            __setModuleWindowForTest(reopenedWindow);

            const second = getMuPDFWorkerClient();
            expect(second).not.toBe(first);
            expect(second.createdFromWindow).toBe(reopenedWindow);
            expect(getExistingMuPDFWorkerClient()).toBe(second);
            // Stable once the creating window is live again.
            expect(getMuPDFWorkerClient()).toBe(second);

            // The old client was disposed: its worker terminated and its
            // in-flight op rejected (no silent orphan).
            expect(firstWorker.terminate).toHaveBeenCalled();
            await expect(inFlight).rejects.toThrow(StaleWorkerError);
        });

        it('replaces a slot instance that predates creator-realm tracking', () => {
            const legacy = { dispose: vi.fn() };
            (globalThis as any).Zotero.__beaverMuPDFWorkerClient_hot = legacy;

            const replacement = getMuPDFWorkerClient();
            expect(replacement).not.toBe(legacy);
            expect(legacy.dispose).toHaveBeenCalledOnce();
            expect(getExistingMuPDFWorkerClient()).toBe(replacement);
        });

        it('keeps a client with no creating window (non-window realm)', () => {
            __setModuleWindowForTest(null);
            const client = getMuPDFWorkerClient();
            expect(client.createdFromWindow).toBeNull();
            expect(client.isCreatorRealmDead).toBe(false);
            expect(getMuPDFWorkerClient()).toBe(client);
        });
    });
});
