/**
 * MuPDFWorkerClient: idle-aware recycling, the standby worker started after an
 * idle recycle, and sharing host-compiled WASM through the configure frame.
 * Uses the in-process MockWorker and fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MockWorker,
    setupZoteroMainWindowWithMockWorker,
} from '../../helpers/mockWorker';
import {
    MuPDFWorkerClient,
    disposeMuPDFWorker,
} from '../../../src/beaver-extract/MuPDFWorkerClient';
import {
    configurePDF,
    getConfig,
    type PDFCompiledWasm,
} from '../../../src/beaver-extract/config';

/** Smallest valid WASM binary: magic number + version. */
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function compiledModules(): PDFCompiledWasm {
    return {
        mupdf: new WebAssembly.Module(EMPTY_WASM),
        sentencex: new WebAssembly.Module(EMPTY_WASM),
    };
}

function currentWorker(): MockWorker {
    return MockWorker.instances[MockWorker.instances.length - 1];
}

/** Run one data operation to completion on the current (or a new) worker. */
async function runOp(
    client: MuPDFWorkerClient,
    heapBytes = 64,
): Promise<void> {
    const op = client.getPageCount(new Uint8Array([1]));
    currentWorker().replyToLast({ ok: true, result: { count: 1 }, heapBytes });
    await expect(op).resolves.toBe(1);
}

function opsPosted(worker: MockWorker): string[] {
    return worker.posted.map((entry) => entry.message.op);
}

describe('MuPDFWorkerClient idle recycling and standby', () => {
    let win: any;

    beforeEach(() => {
        MockWorker.instances.length = 0;
        MockWorker.dropNextConfigureAck = false;
        win = setupZoteroMainWindowWithMockWorker();
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await disposeMuPDFWorker();
    });

    function idleClient(
        opts: ConstructorParameters<typeof MuPDFWorkerClient>[0] = {},
    ): MuPDFWorkerClient {
        return new MuPDFWorkerClient({
            recycleHeapBytes: null,
            recycleAfterDataOperations: 4,
            recycleWhenIdleAfterDataOperations: 2,
            recycleIdleDelayMs: 1000,
            ...opts,
        });
    }

    it('uses slot defaults: the hot slot defers at 32 with a forced limit of 64, the background slot does not defer', () => {
        const hot = new MuPDFWorkerClient({ slotName: 'hot' });
        const background = new MuPDFWorkerClient({ slotName: 'background' });
        try {
            expect(hot.getStats()).toMatchObject({
                recycleDataOperationThreshold: 32,
                recycleDataOperationHardLimit: 64,
                recycleIdleDelayMs: 1000,
            });
            expect(background.getStats()).toMatchObject({
                recycleDataOperationThreshold: 64,
                recycleDataOperationHardLimit: 64,
                recycleIdleDelayMs: null,
            });
        } finally {
            hot.dispose();
            background.dispose();
        }
    });

    it('ignores an idle limit that is not below the forced limit, or without a forced limit', () => {
        const notBelow = idleClient({ recycleWhenIdleAfterDataOperations: 4 });
        const noForced = idleClient({ recycleAfterDataOperations: null });
        try {
            expect(notBelow.getStats()).toMatchObject({
                recycleDataOperationThreshold: 4,
                recycleIdleDelayMs: null,
            });
            expect(noForced.getStats()).toMatchObject({
                recycleDataOperationThreshold: null,
                recycleIdleDelayMs: null,
            });
        } finally {
            notBelow.dispose();
            noForced.dispose();
        }
    });

    it('retires a worker past the idle limit only after the idle delay, then starts a standby', async () => {
        const client = idleClient();
        try {
            await runOp(client);
            await runOp(client);
            const first = MockWorker.instances[0];
            expect(client.getStats()).toMatchObject({
                completedDataOperationsSinceSpawn: 2,
                proactiveRecyclePending: false,
            });

            await vi.advanceTimersByTimeAsync(999);
            expect(first.terminate).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1);
            expect(first.terminate).toHaveBeenCalledOnce();
            expect(MockWorker.instances).toHaveLength(2);
            const standby = MockWorker.instances[1];
            expect(standby.configureMessages).toHaveLength(1);
            expect(opsPosted(standby)).toEqual(['__init']);
            expect(client.getStats()).toMatchObject({
                hasWorker: true,
                spawnCount: 2,
                proactiveRecycleCount: 1,
                idleRecycleCount: 1,
                standbySpawnCount: 1,
                lastProactiveRecycleReason: 'data_operation_limit',
                lastProactiveRecycleDataOperations: 2,
                completedDataOperationsSinceSpawn: 0,
                dispatchCounts: { getPageCount: 2 },
            });

            // The standby's init does not count as a data operation, and the
            // next call runs on it without another spawn.
            standby.replyToLast({ ok: true, result: {}, heapBytes: 64 });
            await vi.advanceTimersByTimeAsync(0);
            expect(client.getStats().completedDataOperationsSinceSpawn).toBe(0);
            await runOp(client);
            expect(MockWorker.instances).toHaveLength(2);
            expect(opsPosted(standby)).toEqual(['__init', 'getPageCount']);
        } finally {
            client.dispose();
        }
    });

    it('cancels the idle recycle when new work arrives and restarts the delay when it drains', async () => {
        const client = idleClient();
        try {
            await runOp(client);
            await runOp(client);
            const first = MockWorker.instances[0];

            await vi.advanceTimersByTimeAsync(600);
            const busy = client.getPageCount(new Uint8Array([3]));
            await vi.advanceTimersByTimeAsync(5000);
            expect(first.terminate).not.toHaveBeenCalled();

            first.replyToLast({ ok: true, result: { count: 3 }, heapBytes: 64 });
            await expect(busy).resolves.toBe(3);
            await vi.advanceTimersByTimeAsync(999);
            expect(first.terminate).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(first.terminate).toHaveBeenCalledOnce();
            expect(client.getStats()).toMatchObject({
                idleRecycleCount: 1,
                lastProactiveRecycleDataOperations: 3,
            });
        } finally {
            client.dispose();
        }
    });

    it('still forces the recycle at the forced limit while busy, without a standby', async () => {
        const client = idleClient();
        try {
            for (let i = 0; i < 4; i++) await runOp(client);
            const first = MockWorker.instances[0];
            expect(client.getStats().proactiveRecyclePending).toBe(true);

            await vi.advanceTimersByTimeAsync(0);
            expect(first.terminate).toHaveBeenCalledOnce();
            expect(MockWorker.instances).toHaveLength(1);
            expect(client.getStats()).toMatchObject({
                hasWorker: false,
                proactiveRecycleCount: 1,
                idleRecycleCount: 0,
                standbySpawnCount: 0,
                lastProactiveRecycleDataOperations: 4,
            });
        } finally {
            client.dispose();
        }
    });

    it('keeps the heap guard immediate while an idle recycle is due', async () => {
        const client = idleClient({
            recycleHeapBytes: 512,
            recycleWhenIdleAfterDataOperations: 1,
        });
        try {
            await runOp(client);
            await runOp(client, 512);
            const first = MockWorker.instances[0];

            await vi.advanceTimersByTimeAsync(0);
            expect(first.terminate).toHaveBeenCalledOnce();
            expect(MockWorker.instances).toHaveLength(1);
            expect(client.getStats()).toMatchObject({
                lastProactiveRecycleReason: 'heap_limit',
                idleRecycleCount: 0,
                standbySpawnCount: 0,
            });
        } finally {
            client.dispose();
        }
    });

    it('a call during standby startup waits for the handshake and runs after the standby init', async () => {
        const client = idleClient();
        try {
            await runOp(client);
            await runOp(client);
            MockWorker.dropNextConfigureAck = true;
            await vi.advanceTimersByTimeAsync(1000);
            const standby = MockWorker.instances[1];
            expect(standby.posted).toHaveLength(0);

            const op = client.getPageCount(new Uint8Array([4]));
            expect(client.inFlight).toBe(1);
            standby.sendReady();
            await vi.advanceTimersByTimeAsync(0);
            expect(opsPosted(standby)).toEqual(['__init', 'getPageCount']);

            standby.onmessage?.({
                data: { id: standby.posted[0].message.id, ok: true, result: {} },
            });
            standby.replyToLast({ ok: true, result: { count: 4 }, heapBytes: 64 });
            await expect(op).resolves.toBe(4);
            expect(MockWorker.instances).toHaveLength(2);
        } finally {
            client.dispose();
        }
    });

    it('leaves the slot empty when the standby cannot spawn, and the next call spawns as usual', async () => {
        const log = vi.fn();
        configurePDF({ ...getConfig(), log });
        const client = idleClient();
        try {
            await runOp(client);
            await runOp(client);
            const RealWorker = win.Worker;
            win.Worker = function ThrowingWorker() {
                throw new Error('no worker');
            };
            await vi.advanceTimersByTimeAsync(1000);
            expect(client.getStats()).toMatchObject({
                hasWorker: false,
                standbySpawnCount: 0,
                idleRecycleCount: 1,
            });
            expect(log).toHaveBeenCalledWith(
                expect.stringContaining('standby spawn failed'),
                2,
            );

            win.Worker = RealWorker;
            await runOp(client);
            expect(MockWorker.instances).toHaveLength(2);
        } finally {
            client.dispose();
        }
    });

    it('does not recycle or start a standby after dispose', async () => {
        const client = idleClient();
        await runOp(client);
        await runOp(client);
        client.dispose();
        await vi.advanceTimersByTimeAsync(5000);
        expect(MockWorker.instances).toHaveLength(1);
        expect(client.getStats()).toMatchObject({
            hasWorker: false,
            idleRecycleCount: 0,
            standbySpawnCount: 0,
        });
    });
});

describe('MuPDFWorkerClient compiled WASM', () => {
    beforeEach(() => {
        MockWorker.instances.length = 0;
        MockWorker.dropNextConfigureAck = false;
        setupZoteroMainWindowWithMockWorker();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await disposeMuPDFWorker();
    });

    function withCompiledWasm(
        getCompiledWasm: NonNullable<ReturnType<typeof getConfig>['getCompiledWasm']>,
    ) {
        const spy = vi.fn(getCompiledWasm);
        configurePDF({ ...getConfig(), getCompiledWasm: spy });
        return spy;
    }

    it('sends the host-compiled modules with the configure frame', async () => {
        const compiled = compiledModules();
        const host = withCompiledWasm(() => compiled);
        const client = new MuPDFWorkerClient();
        try {
            await runOp(client);
            const worker = MockWorker.instances[0];
            expect(host).toHaveBeenCalledWith(getConfig().worker);
            expect(worker.configureMessages[0]).toMatchObject({
                kind: 'configure',
                compiledWasm: compiled,
            });
            expect(client.getStats().compiledWasmShared).toBe(true);
        } finally {
            client.dispose();
        }
    });

    it('holds configure, and the call, until an asynchronous compile resolves', async () => {
        const compiled = compiledModules();
        let resolve!: (value: PDFCompiledWasm | null) => void;
        withCompiledWasm(() => new Promise((res) => { resolve = res; }));
        const client = new MuPDFWorkerClient();
        try {
            const op = client.getPageCount(new Uint8Array([1]));
            const worker = MockWorker.instances[0];
            // A `ready` arriving before the modules does not configure early.
            worker.sendReady();
            expect(worker.configureMessages).toHaveLength(0);
            expect(worker.posted).toHaveLength(0);

            resolve(compiled);
            await Promise.resolve();
            await Promise.resolve();
            expect(worker.configureMessages).toHaveLength(1);
            expect(worker.configureMessages[0].compiledWasm).toBe(compiled);
            await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
            worker.replyToLast({ ok: true, result: { count: 1 } });
            await expect(op).resolves.toBe(1);
        } finally {
            client.dispose();
        }
    });

    it('configures without modules when the host compile fails', async () => {
        withCompiledWasm(() => Promise.reject(new Error('compile failed')));
        const client = new MuPDFWorkerClient();
        try {
            const op = client.getPageCount(new Uint8Array([1]));
            const worker = MockWorker.instances[0];
            await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
            expect(worker.configureMessages[0]).not.toHaveProperty('compiledWasm');
            worker.replyToLast({ ok: true, result: { count: 1 } });
            await expect(op).resolves.toBe(1);
            expect(client.getStats().compiledWasmShared).toBe(false);
        } finally {
            client.dispose();
        }
    });

    it('stops waiting for a slow host compile after 5 seconds', async () => {
        vi.useFakeTimers();
        withCompiledWasm(() => new Promise(() => {}));
        const client = new MuPDFWorkerClient();
        try {
            const op = client.getPageCount(new Uint8Array([1]));
            const worker = MockWorker.instances[0];
            await vi.advanceTimersByTimeAsync(4999);
            expect(worker.configureMessages).toHaveLength(0);
            await vi.advanceTimersByTimeAsync(1);
            expect(worker.configureMessages).toHaveLength(1);
            expect(worker.configureMessages[0]).not.toHaveProperty('compiledWasm');
            worker.replyToLast({ ok: true, result: { count: 1 } });
            await expect(op).resolves.toBe(1);
        } finally {
            client.dispose();
        }
    });

    it('resends configure without modules when the worker cannot receive them, and stops offering them', async () => {
        const host = withCompiledWasm(() => compiledModules());
        MockWorker.dropNextConfigureAck = true;
        const client = new MuPDFWorkerClient();
        try {
            const op = client.getPageCount(new Uint8Array([1]));
            const worker = MockWorker.instances[0];
            expect(worker.configureMessages[0]).toHaveProperty('compiledWasm');

            worker.onmessage?.({ data: { kind: 'messageerror' } });
            expect(worker.configureMessages).toHaveLength(2);
            expect(worker.configureMessages[1]).not.toHaveProperty('compiledWasm');
            await vi.waitFor(() => expect(worker.posted).toHaveLength(1));
            worker.replyToLast({ ok: true, result: { count: 1 } });
            await expect(op).resolves.toBe(1);
            expect(client.getStats().compiledWasmShared).toBe(false);

            client.markStaleForTest();
            await runOp(client);
            expect(MockWorker.instances).toHaveLength(2);
            expect(MockWorker.instances[1].configureMessages[0]).not.toHaveProperty('compiledWasm');
            expect(host).toHaveBeenCalledTimes(1);
        } finally {
            client.dispose();
        }
    });

    it('stops offering modules after a handshake that carried them times out', async () => {
        vi.useFakeTimers();
        withCompiledWasm(() => compiledModules());
        MockWorker.dropNextConfigureAck = true;
        const client = new MuPDFWorkerClient();
        try {
            const op = client.getPageCount(new Uint8Array([1]));
            expect(MockWorker.instances[0].configureMessages[0]).toHaveProperty('compiledWasm');

            await vi.advanceTimersByTimeAsync(15000);
            const retry = MockWorker.instances[1];
            expect(retry.configureMessages[0]).not.toHaveProperty('compiledWasm');
            retry.replyToLast({ ok: true, result: { count: 1 } });
            await expect(op).resolves.toBe(1);
        } finally {
            client.dispose();
        }
    });

    it('falls back to a plain configure when posting the modules throws', async () => {
        class CloneFailWorker extends MockWorker {
            constructor(url: string, options: any) {
                super(url, options);
                const post = this.postMessage;
                this.postMessage = vi.fn((message: any, transfer?: Transferable[]) => {
                    if (message?.compiledWasm) throw new Error('DataCloneError');
                    return post(message, transfer);
                });
            }
        }
        const win = setupZoteroMainWindowWithMockWorker();
        win.Worker = CloneFailWorker;
        withCompiledWasm(() => compiledModules());
        const client = new MuPDFWorkerClient();
        try {
            await runOp(client);
            const worker = MockWorker.instances[0];
            expect(worker.configureMessages).toHaveLength(1);
            expect(worker.configureMessages[0]).not.toHaveProperty('compiledWasm');
            expect(client.getStats()).toMatchObject({
                hasWorker: true,
                compiledWasmShared: false,
                consecutiveStartFailures: 0,
            });
        } finally {
            client.dispose();
        }
    });
});
