import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchable = vi.hoisted(() => ({ value: true }));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    isLibrarySearchable: () => searchable.value,
}));

import { enqueuePdfExtractionRetry } from '../../../src/services/agentDataProvider/pdfExtractionRetry';
import { MAX_PDF_TIMEOUT_SECONDS } from '../../../src/services/agentDataProvider/timeout';

const enqueueBackgroundJob = vi.fn();
const notify = vi.fn();
const args = { libraryId: 3, zoteroKey: 'ABCD2345', mode: 'structured' as const, maxPages: null, logContext: 'test' };

describe('enqueuePdfExtractionRetry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        searchable.value = true;
        (globalThis as any).Zotero.Beaver = { db: { enqueueBackgroundJob }, backgroundExtractor: { notify } };
    });

    it('queues a background extraction with the long PDF timeout and wakes the extractor', async () => {
        await enqueuePdfExtractionRetry(args);
        expect(enqueueBackgroundJob).toHaveBeenCalledWith(expect.objectContaining({
            jobType: 'document_extract',
            libraryId: 3,
            zoteroKey: 'ABCD2345',
            contentKind: 'pdf',
            payloadKind: 'structured',
            payload: { content_kind: 'pdf', maxPages: null, timeoutSeconds: MAX_PDF_TIMEOUT_SECONDS },
        }));
        expect(notify).toHaveBeenCalledOnce();
    });

    it('never queues work for an excluded library', async () => {
        searchable.value = false;
        await enqueuePdfExtractionRetry(args);
        expect(enqueueBackgroundJob).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('swallows a failed enqueue', async () => {
        enqueueBackgroundJob.mockRejectedValueOnce(new Error('db closed'));
        await expect(enqueuePdfExtractionRetry(args)).resolves.toBeUndefined();
        expect(notify).not.toHaveBeenCalled();
    });
});
