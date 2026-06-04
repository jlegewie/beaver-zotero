/**
 * Live tests — background queue content-kind / payload-kind dispatch.
 *
 * Complements `backgroundExtractor.live.test.ts` (queue mechanics) by
 * exercising the content-kind / payload-kind model on the background
 * extraction queue:
 *
 *   - Payload parsing on read: the queue rejects rows whose `content_kind`
 *     column disagrees with the payload JSON discriminator, or whose PDF
 *     payload is malformed, surfacing `payload: null` on peek while still
 *     returning the row.
 *   - Enqueue merge across a content-kind change: re-enqueuing the same
 *     dedupe identity `(job_type, library_id, zotero_key, payload_kind)`
 *     with a different `content_kind` overwrites the stored content kind and
 *     payload; a same-kind, lower-priority re-enqueue leaves the payload
 *     untouched; a same-kind, higher-priority re-enqueue overwrites it.
 *   - `BackgroundExtractor.processOnce()` content-kind dispatch:
 *       * a job whose recorded content kind no longer matches the live
 *         attachment is dropped without extracting;
 *       * a job whose content kind is a non-PDF kind the background worker
 *         does not handle is dropped without extracting;
 *       * a PDF job whose payload is missing or non-PDF is dropped without
 *         extracting;
 *       * a PDF job recorded against a regular parent item still resolves to
 *         its single child PDF and extracts.
 *
 * The internal drop reason is emitted on the `background-job:done` event, not
 * returned by `processOnce` (which reports `job_done` once a row is claimed).
 * These tests therefore assert the observable contract: the row drains in a
 * single pass with no retry / dead-letter, and — for the drop paths — no
 * cache payload is written.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build running (`npm start`), authenticated, fixtures seeded.
 *   - PARENT_ITEM is a regular item whose single child PDF is the SMALL_PDF
 *     attachment; resolving either yields the same attachment key.
 *
 * Run: npm run test:live -- backgroundContentKind
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { SMALL_PDF, NON_PDF, IMAGE, PARENT_ITEM } from '../helpers/fixtures';
import {
    backgroundEnqueue,
    backgroundPeek,
    backgroundStats,
    backgroundProcessOnce,
    backgroundClear,
    invalidateCache,
    getCacheMetadata,
    getCachePayload,
    resolveItem,
    type BackgroundJobPayload,
} from '../helpers/cacheInspector';

let available: boolean;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

// A valid PDF payload with a recognizable page bound, for round-trip checks.
function pdfPayload(maxPages: number | null): BackgroundJobPayload {
    return {
        content_kind: 'pdf',
        maxPages,
        maxFileSizeMB: 25,
        timeoutSeconds: 120,
    };
}

describe('background queue — payload parsing on read', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!available) return;
        await backgroundClear();
    });

    it('round-trips a well-formed PDF payload', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            payload: pdfPayload(7),
        });
        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(1);
        const job = peek.jobs![0];
        expect(job.contentKind).toBe('pdf');
        expect(job.payloadKind).toBe('structured');
        expect(job.payload).toEqual({
            content_kind: 'pdf',
            maxPages: 7,
            maxFileSizeMB: 25,
            timeoutSeconds: 120,
        });
    });

    it('accepts a PDF payload with maxPages: null (unbounded)', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            payload: pdfPayload(null),
        });
        const peek = await backgroundPeek();
        expect(peek.jobs![0].payload).toEqual({
            content_kind: 'pdf',
            maxPages: null,
            maxFileSizeMB: 25,
            timeoutSeconds: 120,
        });
    });

    it('nulls the payload when the column content_kind and payload discriminator disagree', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            // Column says pdf, JSON discriminator says epub → rejected on read.
            payload: { content_kind: 'epub' } as unknown as BackgroundJobPayload,
        });
        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(1);
        expect(peek.jobs![0].contentKind).toBe('pdf');
        expect(peek.jobs![0].payload).toBeNull();
    });

    it('nulls a PDF payload missing required numeric fields', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            // Missing maxFileSizeMB and timeoutSeconds.
            payload: { content_kind: 'pdf', maxPages: null } as unknown as BackgroundJobPayload,
        });
        const peek = await backgroundPeek();
        expect(peek.jobs![0].payload).toBeNull();
    });

    it('nulls a PDF payload whose maxPages is the wrong type', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            payload: {
                content_kind: 'pdf',
                maxPages: 'all',
                maxFileSizeMB: 25,
                timeoutSeconds: 120,
            } as unknown as BackgroundJobPayload,
        });
        const peek = await backgroundPeek();
        expect(peek.jobs![0].payload).toBeNull();
    });

    it('preserves a non-PDF (epub) payload as-is', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'epub',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            payload: { content_kind: 'epub' },
        });
        const peek = await backgroundPeek();
        expect(peek.jobs![0].contentKind).toBe('epub');
        expect(peek.jobs![0].payload).toEqual({ content_kind: 'epub' });
    });

    it('nulls the payload when none was stored', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            payload: null,
        });
        const peek = await backgroundPeek();
        expect(peek.jobs![0].payload).toBeNull();
    });
});

describe('background queue — enqueue merge across content_kind change', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!available) return;
        await backgroundClear();
    });

    it('overwrites content_kind and payload when the incoming content kind differs', async () => {
        const first = await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            priority: 100,
            payload: pdfPayload(5),
        });
        expect(first.enqueued).toBe(true);

        // Same dedupe identity (job_type, library_id, zotero_key, payload_kind),
        // different content_kind, no higher priority. Merge must still adopt the
        // new content_kind and its payload.
        const second = await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'epub',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            priority: 100,
            payload: { content_kind: 'epub' },
        });
        expect(second.enqueued).toBe(false);
        expect(second.id).toBe(first.id);

        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(1);
        const job = peek.jobs![0];
        expect(job.contentKind).toBe('epub');
        expect(job.payload).toEqual({ content_kind: 'epub' });
        expect(job.priority).toBe(100);
        expect(job.attemptCount).toBe(0);
    });

    it('keeps the existing payload on a same-kind, lower-priority re-enqueue', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            priority: 100,
            payload: pdfPayload(5),
        });
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            priority: 200, // numerically lower priority
            payload: pdfPayload(99),
        });
        const peek = await backgroundPeek();
        const job = peek.jobs![0];
        expect(job.priority).toBe(100); // MIN(existing, incoming)
        expect(job.contentKind).toBe('pdf');
        expect((job.payload as { maxPages: number }).maxPages).toBe(5); // untouched
    });

    it('overwrites the payload and lowers priority on a same-kind, higher-priority re-enqueue', async () => {
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            priority: 100,
            payload: pdfPayload(5),
        });
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            priority: 10, // numerically higher priority
            payload: pdfPayload(99),
        });
        const peek = await backgroundPeek();
        const job = peek.jobs![0];
        expect(job.priority).toBe(10);
        expect((job.payload as { maxPages: number }).maxPages).toBe(99); // overwritten
    });
});

describe('background queue — content_kind dispatch in processOnce', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!available) return;
        await backgroundClear();
    });

    it('drops a PDF attachment recorded as a stale content kind without extracting', async () => {
        // Live attachment is a PDF, but the job claims content_kind 'epub'.
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'epub',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            payload: { content_kind: 'epub' },
        });

        const res = await backgroundProcessOnce();
        expect(res.processed).toBe(true);
        expect(res.reason).toBe('job_done');

        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(0);
        const stats = await backgroundStats();
        expect(stats.queue!.pending).toBe(0);
        expect(stats.queue!.dead).toBe(0);

        // The stale guard short-circuits before extraction: cache stays cold.
        const payload = await getCachePayload(SMALL_PDF.library_id, SMALL_PDF.zotero_key, 'structured');
        expect(payload).toBeNull();
    }, 60_000);

    it('drops a job whose live item resolves to no extractable content kind', async () => {
        // A PNG attachment: live content kind is null and it is not a regular
        // item, so a PDF-recorded job cannot be salvaged and is dropped.
        await backgroundEnqueue({
            library_id: IMAGE.library_id,
            zotero_key: IMAGE.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            payload: pdfPayload(null),
        });

        const res = await backgroundProcessOnce();
        expect(res.processed).toBe(true);
        expect(res.reason).toBe('job_done');

        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(0);
        const stats = await backgroundStats();
        expect(stats.queue!.dead).toBe(0);
    }, 60_000);

    it('drops a job whose content kind is a non-PDF kind the worker does not handle', async () => {
        // Live attachment is an EPUB and the job correctly records 'epub', so it
        // passes the staleness guard — but the background worker only extracts
        // PDFs, so the job is dropped as unsupported.
        await invalidateCache(NON_PDF.library_id, NON_PDF.zotero_key);
        await backgroundEnqueue({
            library_id: NON_PDF.library_id,
            zotero_key: NON_PDF.zotero_key,
            content_kind: 'epub',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            payload: { content_kind: 'epub' },
        });

        const res = await backgroundProcessOnce();
        expect(res.processed).toBe(true);
        expect(res.reason).toBe('job_done');

        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(0);
        const stats = await backgroundStats();
        expect(stats.queue!.dead).toBe(0);

        const payload = await getCachePayload(NON_PDF.library_id, NON_PDF.zotero_key, 'structured');
        expect(payload).toBeNull();
    }, 60_000);

    it('drops a PDF job with a missing payload without extracting', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            payload: null,
        });

        const res = await backgroundProcessOnce();
        expect(res.processed).toBe(true);
        expect(res.reason).toBe('job_done');

        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(0);

        const payload = await getCachePayload(SMALL_PDF.library_id, SMALL_PDF.zotero_key, 'structured');
        expect(payload).toBeNull();
    }, 60_000);

    it('drops a PDF job whose payload discriminator was rejected on read', async () => {
        // Column content_kind 'pdf' but payload JSON discriminator 'epub' →
        // payload parses to null → treated as a missing PDF payload.
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        await backgroundEnqueue({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            payload: { content_kind: 'epub' } as unknown as BackgroundJobPayload,
        });

        const res = await backgroundProcessOnce();
        expect(res.processed).toBe(true);
        expect(res.reason).toBe('job_done');

        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(0);

        const payload = await getCachePayload(SMALL_PDF.library_id, SMALL_PDF.zotero_key, 'structured');
        expect(payload).toBeNull();
    }, 60_000);

    it('resolves a PDF job recorded against a regular parent item and extracts', async () => {
        // The parent regular item has no content kind of its own (live kind is
        // null), but the PDF-recorded job is kept alive via parent resolution
        // and extracts the single child PDF.
        const resolved = await resolveItem(PARENT_ITEM.library_id, PARENT_ITEM.zotero_key);
        expect(resolved.is_attachment).toBe(false);
        expect(resolved.resolved_pdf_key).toBe(`${SMALL_PDF.library_id}-${SMALL_PDF.zotero_key}`);

        // Start the resolved child cold so a populated cache proves extraction ran.
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        await backgroundEnqueue({
            library_id: PARENT_ITEM.library_id,
            zotero_key: PARENT_ITEM.zotero_key,
            content_kind: 'pdf',
            payload_kind: 'structured',
            job_type: 'document_timeout_retry',
            payload: pdfPayload(null),
        });

        const res = await backgroundProcessOnce();
        expect(res.processed).toBe(true);
        expect(res.reason).toBe('job_done');

        const peek = await backgroundPeek();
        expect(peek.jobs?.length).toBe(0);

        // Extraction caches under the resolved child attachment key.
        const record = await getCacheMetadata(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(record).not.toBeNull();
        expect(record?.pageCount).toBeGreaterThan(0);
        expect(record?.errorCode).toBeNull();
    }, 180_000);
});
