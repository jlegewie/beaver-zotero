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
let notify: ReturnType<typeof vi.fn>;

function setupBeaver(hasOcrAccess: boolean) {
    enqueueBackgroundJob = vi.fn(async () => ({ enqueued: true, id: 1 }));
    isPermFailed = vi.fn(async () => false);
    notify = vi.fn();
    (globalThis as any).Zotero.Beaver = {
        hasOcrAccess,
        db: {
            isDocumentProcessingPermanentlyFailed: isPermFailed,
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

    it('does not enqueue when the attachment has no content hash', async () => {
        setupBeaver(true);

        maybeEnqueueOcrJob({ ...args(), item: makeItem('') });
        await flush();

        expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    });
});
