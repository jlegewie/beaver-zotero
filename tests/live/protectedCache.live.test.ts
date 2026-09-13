import { beforeAll, beforeEach, expect, it } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { getBaseUrl, SMALL_PDF, NO_TEXT_PDF } from '../helpers/fixtures';
import { backgroundPeek, invalidateCache, readAttachment, triggerFileStatus } from '../helpers/cacheInspector';

let available = false;
beforeAll(async () => { available = await isZoteroAvailable(); });
beforeEach(ctx => skipIfNoZotero(ctx, available));

it('keeps prepared text readable through maintenance in a disposable real SQLite cache', async () => {
    const response = await fetch(`${getBaseUrl()}/beaver/test/protected-cache-check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SMALL_PDF),
    });
    expect(response.ok).toBe(true);
    const result = await response.json();
    expect(result).toMatchObject({ ok: true, nativeCleared: true, readableAfterClearResetReopen: true, invalidated: true });
    expect(result.protectedBytes).toBeGreaterThan(0);
}, 60_000);

it('reading and validating a cold scan do not create or promote its OCR ticket', async () => {
    const tickets = async () => {
        const result = await backgroundPeek({ limit: 10000 });
        expect(result.ok).toBe(true);
        expect(result.jobs!.length).toBeLessThan(10000);
        return result.jobs!.filter(job => job.jobType === 'document_ocr'
            && job.libraryId === NO_TEXT_PDF.library_id && job.zoteroKey === NO_TEXT_PDF.zotero_key)
            .map(job => ({ id: job.id, priority: job.priority }));
    };
    const before = await tickets();
    await invalidateCache(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);
    const status = await triggerFileStatus(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);
    expect(status.status).toBe('unreadable');
    expect(status.status_code).toBe('pdf_needs_ocr');
    await readAttachment({ attachment_id: `${NO_TEXT_PDF.library_id}-${NO_TEXT_PDF.zotero_key}`, start_page: 1 });
    expect(await tickets()).toEqual(before);
}, 60_000);
