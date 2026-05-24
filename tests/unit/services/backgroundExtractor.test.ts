import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    BeaverDB,
    BackgroundJobPayload,
} from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

const mockState = {
    extractCalls: [] as any[],
    nextResult: { kind: 'ok' } as any,
    hotPendingCount: 0,
    mainWindow: null as any,
    extractResolve: null as null | ((value: any) => void),
    disposeCalls: [] as Array<string | undefined>,
};

vi.mock('../../../src/services/documentExtractionCore', () => ({
    extractAndCacheDocument: vi.fn(async (args: any) => {
        mockState.extractCalls.push(args);
        if (mockState.nextResult instanceof Promise) {
            return await mockState.nextResult;
        }
        return mockState.nextResult;
    }),
}));

vi.mock('../../../src/beaver-extract', () => ({
    disposeMuPDFWorker: vi.fn(async (name?: string) => {
        mockState.disposeCalls.push(name);
    }),
    getExistingMuPDFWorkerClient: vi.fn((_name: string) => {
        return {
            getStats: () => ({ pendingCount: mockState.hotPendingCount }),
        };
    }),
}));

// `backgroundExtractor.ts` imports `safeIsInTrash` from `zoteroItemUtils`
// (the react-free helper module), not `zoteroUtils`.
vi.mock('../../../src/utils/zoteroItemUtils', () => ({
    safeIsInTrash: vi.fn(() => false),
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

function payload(overrides: Partial<BackgroundJobPayload> = {}): BackgroundJobPayload {
    return {
        maxPages: 200,
        maxFileSizeMB: 50,
        timeoutSeconds: 120,
        ...overrides,
    };
}

function setupZoteroGlobal() {
    const item = { libraryID: 1, key: 'AAAAAAAA' };
    const win: any = {};
    // Extend the shared setup.ts stub rather than replace it — initDatabase
    // and BeaverDB both read `Zotero.Prefs.get`, which the global setup
    // already provides.
    const base = (globalThis as any).Zotero ?? {};
    (globalThis as any).Zotero = {
        ...base,
        getMainWindow: vi.fn(() => win),
        Items: {
            getByLibraryAndKeyAsync: vi.fn(async (_libraryId: number, _key: string) => item),
        },
        Beaver: {} as any,
        // Reset shutdown flag explicitly: a previous test's leak would
        // otherwise cause processOnce to short-circuit with 'shutting_down'.
        __beaverShuttingDown: undefined,
    };
    mockState.mainWindow = win;
    return { win, item };
}

async function loadProcessor() {
    return await import('../../../src/services/backgroundExtractor');
}

describe('BackgroundExtractor', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        mockState.extractCalls = [];
        mockState.nextResult = { kind: 'ok' };
        mockState.hotPendingCount = 0;
        mockState.disposeCalls = [];
        mockState.extractResolve = null;
        setupZoteroGlobal();
        conn = new MockDBConnection();
        db = new BeaverDB(conn);
        await db.initDatabase('0.99.0');
        (Zotero as any).Beaver = { db };
    });

    afterEach(async () => {
        await conn.closeDatabase();
    });

    it('returns no_window when Zotero.getMainWindow returns null', async () => {
        (Zotero as any).getMainWindow = vi.fn(() => null);
        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();

        const result = await proc.processOnce();

        expect(result).toEqual({ processed: false, reason: 'no_window' });
        expect(mockState.extractCalls).toHaveLength(0);
    });

    it('returns hot_busy when the hot worker has pending dispatches', async () => {
        mockState.hotPendingCount = 1;
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });

        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();
        const result = await proc.processOnce();

        expect(result.processed).toBe(false);
        expect(result.reason).toBe('hot_busy');
        expect(mockState.extractCalls).toHaveLength(0);
    });

    it('completes the job when the item is in the trash', async () => {
        const { safeIsInTrash } = await import('../../../src/utils/zoteroItemUtils');
        (safeIsInTrash as any).mockReturnValueOnce(true);
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });

        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();
        const result = await proc.processOnce();

        expect(result.processed).toBe(true);
        expect(mockState.extractCalls).toHaveLength(0);
        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(0);
    });

    it('removes the row on kind=ok and routes through the background worker', async () => {
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload({ timeoutSeconds: 120 }),
            now: 0,
        });
        mockState.nextResult = {
            kind: 'ok',
            cached: false,
            result: { mode: 'structured', document: { pageCount: 1, pages: [] } },
            totalPages: 1,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' },
            contentType: 'application/pdf',
        };

        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();
        const result = await proc.processOnce();

        expect(result.processed).toBe(true);
        expect(mockState.extractCalls).toHaveLength(1);
        expect(mockState.extractCalls[0].workerName).toBe('background');
        expect(mockState.extractCalls[0].mode).toBe('structured');
        expect(mockState.extractCalls[0].timeoutSeconds).toBe(120);
        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(0);
    });

    it.each([
        ['encrypted'],
        ['invalid_pdf'],
        ['no_text_layer'],
    ])('terminal cached_error %s completes the job', async (code: string) => {
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });
        mockState.nextResult = {
            kind: 'cached_error',
            code,
            message: 'cached err',
            pageCount: 5,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' },
        };

        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();
        const result = await proc.processOnce();

        expect(result.processed).toBe(true);
        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(0);
    });

    it.each([
        ['too_many_pages'],
        ['file_missing'],
        ['file_too_large'],
        ['not_pdf'],
        ['mode_mismatch'],
        ['pdf_parser_crash'],
        ['pdf_too_complex'],
    ])('terminal response_error %s completes the job without retry', async (code: string) => {
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });
        mockState.nextResult = {
            kind: 'response_error',
            code,
            message: 'terminal',
            pageCount: null,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' },
        };

        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();
        const result = await proc.processOnce();

        expect(result.processed).toBe(true);
        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(0);
    });

    it.each([
        ['download_failed'],
        ['extraction_failed'],
    ])('transient response_error %s bumps attempt_count and slides availability out', async (code: string) => {
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });
        mockState.nextResult = {
            kind: 'response_error',
            code,
            message: 'transient',
            pageCount: null,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' },
        };

        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();
        await proc.processOnce();

        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(1);
        expect(rows[0].attemptCount).toBe(1);
        expect(rows[0].lastError).toContain(code);
    });

    it('timeout kind counts as a transient failure', async () => {
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });
        mockState.nextResult = {
            kind: 'timeout',
            phase: 'pdf_extract',
            timeoutSeconds: 120,
            pageCount: null,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' },
        };

        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();
        await proc.processOnce();

        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(1);
        expect(rows[0].attemptCount).toBe(1);
        expect(rows[0].lastError).toContain('timeout');
    });

    it('external_abort releases the job without bumping attempt_count', async () => {
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });
        mockState.nextResult = {
            kind: 'external_abort',
            phase: 'external_abort',
            pageCount: null,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' },
        };

        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();
        await proc.processOnce();

        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(1);
        expect(rows[0].attemptCount).toBe(0);
        expect(rows[0].lastError).toBeNull();
    });

    it('dispatches background-job:start on the main window event bus when present', async () => {
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });
        const bus = new EventTarget();
        const win: any = (Zotero as any).getMainWindow();
        win.__beaverEventBus = bus;
        (win as any).CustomEvent = CustomEvent;
        const events: string[] = [];
        bus.addEventListener('background-job:start', () => events.push('start'));
        bus.addEventListener('background-job:done', () => events.push('done'));
        mockState.nextResult = {
            kind: 'ok',
            cached: false,
            result: { mode: 'structured', document: { pageCount: 1, pages: [] } },
            totalPages: 1,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' },
            contentType: 'application/pdf',
        };

        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();
        await proc.processOnce();

        expect(events).toEqual(['start', 'done']);
    });

    it('event dispatch is window-guarded — no throw when no main window', async () => {
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });
        mockState.nextResult = {
            kind: 'ok',
            cached: false,
            result: { mode: 'structured', document: { pageCount: 1, pages: [] } },
            totalPages: 1,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' },
            contentType: 'application/pdf',
        };

        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();
        // First call: real window so the job is processed.
        await proc.processOnce();
        // Then null-window for a follow-up — should be a clean no-op
        (Zotero as any).getMainWindow = vi.fn(() => null);
        const result = await proc.processOnce();
        expect(result).toEqual({ processed: false, reason: 'no_window' });
    });

    it('stop() aborts an in-flight job and disposes the background worker', async () => {
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });
        mockState.nextResult = new Promise<any>((resolve) => {
            mockState.extractResolve = resolve;
        });

        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();
        const processOncePromise = proc.processOnce();

        // Give the extractor a chance to claim and start the job. After
        // the claim, `available_at` has been bumped by VISIBILITY_TIMEOUT_MS
        // (~6 minutes) — capture it so the post-release assertion below
        // verifies the row was actually released, not just left untouched.
        await new Promise((r) => setTimeout(r, 0));
        const claimedRows = await db.peekBackgroundJobs();
        expect(claimedRows).toHaveLength(1);
        const claimedAvailableAt = claimedRows[0].availableAt;
        const beforeReleaseMs = Date.now();

        const stopPromise = proc.stop();
        // Resolve the suspended extraction with an external_abort outcome.
        mockState.extractResolve!({
            kind: 'external_abort',
            phase: 'external_abort',
            pageCount: null,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' },
        });

        await processOncePromise;
        await stopPromise;

        // Job released (not failed), and available_at reset by
        // releaseBackgroundJob so the row is immediately retryable —
        // NOT left hidden for the visibility timeout.
        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(1);
        expect(rows[0].attemptCount).toBe(0);
        expect(rows[0].availableAt).toBeLessThan(claimedAvailableAt);
        expect(rows[0].availableAt).toBeGreaterThanOrEqual(beforeReleaseMs);
        // Worker dispose called for background slot.
        expect(mockState.disposeCalls).toContain('background');
    });

    it('abortInFlight() releases the in-flight job without stopping the processor or disposing the worker', async () => {
        // Models the window-unload-but-app-alive case
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });
        mockState.nextResult = new Promise<any>((resolve) => {
            mockState.extractResolve = resolve;
        });

        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();
        const processOncePromise = proc.processOnce();

        await new Promise((r) => setTimeout(r, 0));
        const claimedRows = await db.peekBackgroundJobs();
        expect(claimedRows).toHaveLength(1);
        const claimedAvailableAt = claimedRows[0].availableAt;
        const beforeReleaseMs = Date.now();

        // Abort without stopping. The processor should NOT mark itself
        // stopped and should NOT dispose the worker.
        const abortPromise = proc.abortInFlight();
        mockState.extractResolve!({
            kind: 'external_abort',
            phase: 'external_abort',
            pageCount: null,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' },
        });
        await abortPromise;
        await processOncePromise;

        // Row released — available_at reset to roughly now(), well under
        // the visibility-timeout-bump value captured pre-release. The
        // attempt count is untouched (no failBackgroundJob fired).
        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(1);
        expect(rows[0].attemptCount).toBe(0);
        expect(rows[0].availableAt).toBeLessThan(claimedAvailableAt);
        expect(rows[0].availableAt).toBeGreaterThanOrEqual(beforeReleaseMs);

        // abortInFlight does NOT dispose the background worker — the
        // caller (onMainWindowUnload) does that as a separate step.
        expect(mockState.disposeCalls).not.toContain('background');

        // The processor is still runnable — a subsequent processOnce
        // would attempt to claim again (proves we did not mark
        // stopRequested / set started=false).
        mockState.nextResult = { kind: 'ok', cached: false, result: {} as any, totalPages: 0, resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' }, contentType: 'application/pdf' };
        const followup = await proc.processOnce();
        // The released row's available_at is ~now(), so the next claim
        // should pick it up immediately and complete it.
        expect(followup.processed).toBe(true);
        expect(mockState.extractCalls).toHaveLength(2);
    });

    it('abortInFlight() is a no-op when there is no in-flight job', async () => {
        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();
        await expect(proc.abortInFlight()).resolves.toBeUndefined();
        expect(mockState.disposeCalls).toHaveLength(0);
    });

    it('latches db-write disable when stop() is called during shutdown', async () => {
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });
        mockState.nextResult = new Promise<any>((resolve) => {
            mockState.extractResolve = resolve;
        });

        const { BackgroundExtractor } = await loadProcessor();
        const proc = new BackgroundExtractor();
        const processOncePromise = proc.processOnce();

        // Let the claim happen and processJob enter the extract await.
        await new Promise((r) => setTimeout(r, 0));
        const claimedRows = await db.peekBackgroundJobs();
        expect(claimedRows).toHaveLength(1);
        const claimedAvailableAt = claimedRows[0].availableAt;

        // Shutdown begins; stop() observes the flag and latches.
        (Zotero as any).__beaverShuttingDown = true;
        const stopPromise = proc.stop();

        // Cleanup runs to completion elsewhere and clears the global
        // flag BEFORE the trailing extract resolves.
        (Zotero as any).__beaverShuttingDown = undefined;

        // Trailing async now resolves with an `ok` result that would
        // normally trigger completeBackgroundJob. The latched flag
        // must suppress it.
        mockState.extractResolve!({
            kind: 'ok',
            cached: false,
            result: {} as any,
            totalPages: 1,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' },
            contentType: 'application/pdf',
        });

        await processOncePromise;
        await stopPromise;

        // Row unchanged: no completion, no release, available_at
        // exactly where the claim left it.
        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(1);
        expect(rows[0].attemptCount).toBe(0);
        expect(rows[0].availableAt).toBe(claimedAvailableAt);
    });

    it('returns shutting_down and does not claim when Zotero.__beaverShuttingDown is set', async () => {
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });
        // Snapshot the row BEFORE shutdown so we can assert nothing changed.
        const before = await db.peekBackgroundJobs();
        expect(before).toHaveLength(1);
        const beforeAvailableAt = before[0].availableAt;

        (Zotero as any).__beaverShuttingDown = true;

        try {
            const { BackgroundExtractor } = await loadProcessor();
            const proc = new BackgroundExtractor();
            const result = await proc.processOnce();

            expect(result).toEqual({ processed: false, reason: 'shutting_down' });
            // No claim happened — extract was not called, available_at
            // unchanged (would have been bumped by VISIBILITY_TIMEOUT_MS).
            expect(mockState.extractCalls).toHaveLength(0);
            const after = await db.peekBackgroundJobs();
            expect(after).toHaveLength(1);
            expect(after[0].availableAt).toBe(beforeAvailableAt);
        } finally {
            (Zotero as any).__beaverShuttingDown = undefined;
        }
    });

    it('skips DB writes when Zotero.__beaverShuttingDown is true', async () => {
        // Models the trailing-async scenario
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });
        mockState.nextResult = {
            kind: 'ok',
            cached: false,
            result: {} as any,
            totalPages: 1,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' },
            contentType: 'application/pdf',
        };
        (Zotero as any).__beaverShuttingDown = true;

        try {
            const { BackgroundExtractor } = await loadProcessor();
            const proc = new BackgroundExtractor();
            await proc.processOnce();

            // Row was claimed but the success path's completeBackgroundJob
            // was skipped — row remains, attempt_count untouched.
            const rows = await db.peekBackgroundJobs();
            expect(rows).toHaveLength(1);
            expect(rows[0].attemptCount).toBe(0);
        } finally {
            (Zotero as any).__beaverShuttingDown = undefined;
        }
    });

    describe('notify()', () => {
        it('is a no-op before start() — does not schedule a tick', async () => {
            const { BackgroundExtractor } = await loadProcessor();
            const proc = new BackgroundExtractor();
            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            const initialCalls = setTimeoutSpy.mock.calls.length;

            proc.notify();

            expect(setTimeoutSpy.mock.calls.length).toBe(initialCalls);
            setTimeoutSpy.mockRestore();
        });

        it('after start(), reschedules the next tick to 0ms', async () => {
            const { BackgroundExtractor } = await loadProcessor();
            const proc = new BackgroundExtractor();
            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

            // start() schedules a tick at BUSY_INTERVAL_MS (10).
            proc.start();
            try {
                const callsAfterStart = setTimeoutSpy.mock.calls.length;
                expect(callsAfterStart).toBeGreaterThan(0);
                // Sanity-check the start delay was nonzero so the
                // 0-delay assertion below is meaningful.
                const startDelay = setTimeoutSpy.mock.calls[callsAfterStart - 1][1];
                expect(startDelay).toBeGreaterThan(0);

                proc.notify();

                // notify() should have installed a fresh setTimeout
                // with delay 0.
                const lastCall = setTimeoutSpy.mock.calls.at(-1);
                expect(lastCall?.[1]).toBe(0);
            } finally {
                // Tear down the scheduled tick so it does not fire into
                // a later test.
                await proc.stop();
                setTimeoutSpy.mockRestore();
            }
        });

        it('is a no-op after stop()', async () => {
            const { BackgroundExtractor } = await loadProcessor();
            const proc = new BackgroundExtractor();
            proc.start();
            await proc.stop();

            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            proc.notify();
            expect(setTimeoutSpy).not.toHaveBeenCalled();
            setTimeoutSpy.mockRestore();
        });

        it('is a no-op while a job is in flight', async () => {
            await db.enqueueBackgroundJob({
                jobType: 'hot_timeout_retry',
                libraryId: 1,
                zoteroKey: 'AAAAAAAA',
                mode: 'structured',
                payload: payload(),
                now: 0,
            });
            mockState.nextResult = new Promise<any>((resolve) => {
                mockState.extractResolve = resolve;
            });

            const { BackgroundExtractor } = await loadProcessor();
            const proc = new BackgroundExtractor();
            proc.start();
            // Drive the tick once by calling processOnce directly so we
            // can observe an in-flight job without racing the timer.
            const processOncePromise = proc.processOnce();
            await new Promise((r) => setTimeout(r, 0));

            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            proc.notify();
            expect(setTimeoutSpy).not.toHaveBeenCalled();
            setTimeoutSpy.mockRestore();

            // Clean up: let the in-flight job finish so stop() returns.
            mockState.extractResolve!({
                kind: 'ok',
                cached: false,
                result: {} as any,
                totalPages: 1,
                resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' },
                contentType: 'application/pdf',
            });
            await processOncePromise;
            await proc.stop();
        });

        it('is a no-op when Zotero.__beaverShuttingDown is set', async () => {
            const { BackgroundExtractor } = await loadProcessor();
            const proc = new BackgroundExtractor();
            proc.start();
            (Zotero as any).__beaverShuttingDown = true;

            const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
            try {
                proc.notify();
                expect(setTimeoutSpy).not.toHaveBeenCalled();
            } finally {
                setTimeoutSpy.mockRestore();
                (Zotero as any).__beaverShuttingDown = undefined;
                await proc.stop();
            }
        });
    });

    it('skips failBackgroundJob during shutdown so transient errors do not write', async () => {
        await db.enqueueBackgroundJob({
            jobType: 'hot_timeout_retry',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            mode: 'structured',
            payload: payload(),
            now: 0,
        });
        mockState.nextResult = {
            kind: 'timeout',
            phase: 'pdf_extract',
            pageCount: null,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'AAAAAAAA' },
        };
        (Zotero as any).__beaverShuttingDown = true;

        try {
            const { BackgroundExtractor } = await loadProcessor();
            const proc = new BackgroundExtractor();
            await proc.processOnce();

            // recordFailure's failBackgroundJob was skipped — attempt_count
            // unchanged, no dead-letter row created.
            const rows = await db.peekBackgroundJobs();
            expect(rows).toHaveLength(1);
            expect(rows[0].attemptCount).toBe(0);
            const stats = await db.getBackgroundQueueStats(Date.now());
            expect(stats.dead).toBe(0);
        } finally {
            (Zotero as any).__beaverShuttingDown = undefined;
        }
    });
});
