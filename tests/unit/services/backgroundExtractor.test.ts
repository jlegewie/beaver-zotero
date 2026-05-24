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

vi.mock('../../../src/utils/zoteroUtils', () => ({
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
        const { safeIsInTrash } = await import('../../../src/utils/zoteroUtils');
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

        // Give the extractor a chance to claim and start the job.
        await new Promise((r) => setTimeout(r, 0));
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

        // Job released, not failed.
        const rows = await db.peekBackgroundJobs();
        expect(rows).toHaveLength(1);
        expect(rows[0].attemptCount).toBe(0);
        // Worker dispose called for background slot.
        expect(mockState.disposeCalls).toContain('background');
    });
});
