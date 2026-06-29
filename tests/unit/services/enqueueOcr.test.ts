import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

import { maybeEnqueueOcrJob } from '../../../src/services/ocr/enqueueOcr';
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
            'document_ocr', 1, 'AAAAAAAA', 'structured', OCR_PRIORITY_ON_DEMAND,
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
            'document_ocr', 1, 'AAAAAAAA', 'structured', OCR_PRIORITY_ON_DEMAND,
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
});
