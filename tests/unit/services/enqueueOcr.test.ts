import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { enqueueOcrJob, maybeEnqueueOcrJob } from '../../../src/services/ocr/enqueueOcr';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import {
    OCR_ENGINE_VERSION,
    OCR_PRIORITY_BACKFILL,
    OCR_PRIORITY_ON_DEMAND,
} from '../../../src/services/ocr/constants';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let enqueueBackgroundJob: ReturnType<typeof vi.fn>;
let isPermFailed: ReturnType<typeof vi.fn>;
let promote: ReturnType<typeof vi.fn>;
let notify: ReturnType<typeof vi.fn>;

function setupBeaver(hasOcrAccess: boolean) {
    enqueueBackgroundJob = vi.fn(async () => ({ enqueued: true, id: 1 }));
    isPermFailed = vi.fn(async () => false);
    promote = vi.fn(async () => ({ exists: false, promoted: false }));
    notify = vi.fn();
    (globalThis as any).Zotero.Beaver = {
        hasOcrAccess,
        libraryScopeInitialized: true,
        searchableLibraryIds: [1],
        db: {
            isDocumentProcessingPermanentlyFailed: isPermFailed,
            promotePendingBackgroundJob: promote,
            enqueueBackgroundJob,
        },
        backgroundExtractor: { notify },
    };
}

function makeItem(hash: string | undefined = 'hash123') {
    return { libraryID: 1, key: 'AAAAAAAA', id: 42, attachmentHash: hash } as any;
}

const args = () => ({
    item: makeItem(),
    libraryId: 1,
    zoteroKey: 'AAAAAAAA',
    itemId: 42,
    pageCount: 7,
});

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    (globalThis as any).Zotero.Beaver = undefined;
});

describe('maybeEnqueueOcrJob', () => {
    it('enqueues a document_ocr job when entitled and not loop-guarded', async () => {
        setupBeaver(true);

        maybeEnqueueOcrJob(args());
        await flush();

        expect(isPermFailed).toHaveBeenCalledWith('hash123', 'ocr', OCR_ENGINE_VERSION);
        expect(enqueueBackgroundJob).toHaveBeenCalledOnce();
        const input = enqueueBackgroundJob.mock.calls[0][0];
        expect(input).toMatchObject({
            jobType: 'document_ocr',
            libraryId: 1,
            zoteroKey: 'AAAAAAAA',
            contentKind: 'pdf',
            payloadKind: 'structured',
            payload: null,
            priority: OCR_PRIORITY_ON_DEMAND,
        });
        expect(notify).toHaveBeenCalledOnce();
    });

    it('defaults to on-demand priority and honors an explicit backfill priority', async () => {
        setupBeaver(true);

        maybeEnqueueOcrJob(args());
        await flush();
        expect(enqueueBackgroundJob.mock.calls[0][0].priority).toBe(OCR_PRIORITY_ON_DEMAND);

        enqueueBackgroundJob.mockClear();
        maybeEnqueueOcrJob({ ...args(), priority: OCR_PRIORITY_BACKFILL });
        await flush();
        expect(enqueueBackgroundJob.mock.calls[0][0].priority).toBe(OCR_PRIORITY_BACKFILL);
    });

    it('does not enqueue when the user lacks OCR entitlement', async () => {
        setupBeaver(false);

        maybeEnqueueOcrJob(args());
        await flush();

        expect(enqueueBackgroundJob).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('does not enqueue, promote, or hash a scan in an excluded library', async () => {
        setupBeaver(true);
        (globalThis as any).Zotero.Beaver.searchableLibraryIds = [2];
        const item = {
            libraryID: 1,
            key: 'AAAAAAAA',
            id: 42,
            get attachmentHash() {
                throw new Error('excluded library must not be hashed');
            },
        } as any;

        maybeEnqueueOcrJob({ ...args(), item });
        await flush();

        expect(promote).not.toHaveBeenCalled();
        expect(enqueueBackgroundJob).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('does not hash or enqueue when the library is excluded during the pending probe', async () => {
        setupBeaver(true);
        promote.mockImplementation(async () => {
            // The user excludes the library while this probe is pending.
            (globalThis as any).Zotero.Beaver.searchableLibraryIds = [];
            return { exists: false, promoted: false };
        });
        const item = {
            libraryID: 1,
            key: 'AAAAAAAA',
            id: 42,
            get attachmentHash() {
                throw new Error('excluded library must not be hashed');
            },
        } as any;

        maybeEnqueueOcrJob({ ...args(), item });
        await flush();

        expect(enqueueBackgroundJob).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('does not wake the dispatcher when the library is excluded during a promotion', async () => {
        setupBeaver(true);
        promote.mockImplementation(async () => {
            (globalThis as any).Zotero.Beaver.searchableLibraryIds = [];
            return { exists: true, promoted: true };
        });

        maybeEnqueueOcrJob(args());
        await flush();

        expect(enqueueBackgroundJob).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('does not enqueue when the library is excluded while hashing', async () => {
        setupBeaver(true);
        const item = {
            libraryID: 1,
            key: 'AAAAAAAA',
            id: 42,
            get attachmentHash() {
                return Promise.resolve('hash123').then((hash) => {
                    (globalThis as any).Zotero.Beaver.searchableLibraryIds = [];
                    return hash;
                });
            },
        } as any;

        maybeEnqueueOcrJob({ ...args(), item });
        await flush();

        expect(enqueueBackgroundJob).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('does not wake the dispatcher when the library is excluded during the insert', async () => {
        setupBeaver(true);
        enqueueBackgroundJob.mockImplementation(async () => {
            (globalThis as any).Zotero.Beaver.searchableLibraryIds = [];
            return { enqueued: true, id: 1 };
        });

        maybeEnqueueOcrJob(args());
        await flush();

        // The row lands (the insert was already in flight) but stays inert:
        // the dispatcher is not woken and its claim-time gate retires it.
        expect(enqueueBackgroundJob).toHaveBeenCalledOnce();
        expect(notify).not.toHaveBeenCalled();
    });

    it('does not enqueue while the library scope is unknown', async () => {
        setupBeaver(true);
        (globalThis as any).Zotero.Beaver.libraryScopeInitialized = false;

        maybeEnqueueOcrJob(args());
        await flush();

        expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    });

    it('does not enqueue a loop-guarded (hopeless) scan', async () => {
        setupBeaver(true);
        isPermFailed.mockResolvedValue(true);

        maybeEnqueueOcrJob(args());
        await flush();

        expect(isPermFailed).toHaveBeenCalledOnce();
        expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    });

    // Spy the content-hash getter to prove it is never read on the fast path.
    function spyHashItem() {
        const hashAccessed = vi.fn(() => 'hash123');
        const item = {
            libraryID: 1,
            key: 'AAAAAAAA',
            id: 42,
            get attachmentHash() {
                return hashAccessed();
            },
        } as any;
        return { item, hashAccessed };
    }

    it('skips file hashing and enqueue when a same-priority ticket is already queued', async () => {
        setupBeaver(true);
        promote.mockResolvedValue({ exists: true, promoted: false });

        const { item, hashAccessed } = spyHashItem();
        maybeEnqueueOcrJob({ ...args(), item });
        await flush();

        expect(promote).toHaveBeenCalledWith(
            'document_ocr', 1, 'AAAAAAAA', 'structured', OCR_PRIORITY_ON_DEMAND, undefined,
        );
        expect(hashAccessed).not.toHaveBeenCalled();
        expect(isPermFailed).not.toHaveBeenCalled();
        expect(enqueueBackgroundJob).not.toHaveBeenCalled();
        // No promotion happened, so the dispatcher is not woken.
        expect(notify).not.toHaveBeenCalled();
    });

    it('promotes (and wakes the dispatcher for) a queued lower-priority ticket without hashing', async () => {
        setupBeaver(true);
        promote.mockResolvedValue({ exists: true, promoted: true });

        const { item, hashAccessed } = spyHashItem();
        maybeEnqueueOcrJob({ ...args(), item });
        await flush();

        expect(promote).toHaveBeenCalledWith(
            'document_ocr', 1, 'AAAAAAAA', 'structured', OCR_PRIORITY_ON_DEMAND, undefined,
        );
        expect(hashAccessed).not.toHaveBeenCalled();
        expect(enqueueBackgroundJob).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledOnce();
    });

    it('does not enqueue when the attachment has no content hash', async () => {
        setupBeaver(true);

        maybeEnqueueOcrJob({ ...args(), item: makeItem('') });
        await flush();

        expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    });

    it('falls back to the synced hash for a remote-only attachment and enqueues', async () => {
        setupBeaver(true);
        // Remote-only: attachmentHash (hashes the local file) is undefined.
        const item = {
            libraryID: 1,
            key: 'AAAAAAAA',
            id: 42,
            attachmentHash: undefined,
            attachmentSyncedHash: 'syncedABC',
        } as any;

        maybeEnqueueOcrJob({ ...args(), item });
        await flush();

        // Loop guard uses the synced hash, matching the executor.
        expect(isPermFailed).toHaveBeenCalledWith('syncedABC', 'ocr', OCR_ENGINE_VERSION);
        expect(enqueueBackgroundJob).toHaveBeenCalledOnce();
        expect(notify).toHaveBeenCalledOnce();
    });

    it('does not enqueue a remote-only attachment with no synced hash', async () => {
        setupBeaver(true);
        const item = {
            libraryID: 1,
            key: 'AAAAAAAA',
            id: 42,
            attachmentHash: undefined,
            attachmentSyncedHash: '',
        } as any;

        maybeEnqueueOcrJob({ ...args(), item });
        await flush();

        expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    });
});

it.each(['new', 'existing', 'insert-race'])('persists the preparation marker on %s OCR tickets', async (scenario) => {
    setupBeaver(true);
    const connection = new MockDBConnection();
    const db = new BeaverDB(connection);
    try {
        await db.initDatabase('0.99.0');
        (Zotero.Beaver as any).db = db;
        const seed = () => db.enqueueBackgroundJob({
            jobType: 'document_ocr', libraryId: 1, zoteroKey: 'AAAAAAAA',
            contentKind: 'pdf', payloadKind: 'structured', priority: OCR_PRIORITY_BACKFILL,
            payload: null, now: Date.now(),
        });
        if (scenario === 'existing') await seed();
        if (scenario === 'insert-race') {
            vi.spyOn(db, 'promotePendingBackgroundJob').mockImplementationOnce(async () => {
                await seed();
                return { exists: false, promoted: false };
            });
        }
        await enqueueOcrJob({ ...args(), priority: OCR_PRIORITY_BACKFILL, prepareCache: true });
        const jobs = await db.peekBackgroundJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({ priority: OCR_PRIORITY_BACKFILL, payload: { content_kind: 'pdf', prepare_cache: true } });
        await enqueueOcrJob(args());
        expect((await db.peekBackgroundJobs())[0].priority).toBe(OCR_PRIORITY_ON_DEMAND);
    } finally {
        await connection.closeDatabase();
    }
});

it('does not apply preparation limits to an existing on-demand OCR ticket', async () => {
    setupBeaver(true);
    const connection = new MockDBConnection();
    const db = new BeaverDB(connection);
    try {
        await db.initDatabase('0.99.0');
        (Zotero.Beaver as any).db = db;
        await enqueueOcrJob(args());
        await enqueueOcrJob({ ...args(), priority: OCR_PRIORITY_BACKFILL, prepareCache: true });
        expect((await db.peekBackgroundJobs())[0]).toMatchObject({ priority: OCR_PRIORITY_ON_DEMAND, payload: null });
    } finally {
        await connection.closeDatabase();
    }
});
