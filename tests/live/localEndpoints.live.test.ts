import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { post } from '../helpers/zoteroHttpClient';
import { SMALL_PDF } from '../helpers/fixtures';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';

let available = false;
beforeAll(async () => { available = await isZoteroAvailable(); });
beforeEach(ctx => skipIfNoZotero(ctx, available));

describe('instance-owned local endpoints', () => {
    it('enumerates runtimes without requiring a UI target', async () => {
        const { windows } = await post<any>('/beaver/test/window-runtime', { command: 'list' });
        expect(Array.isArray(windows)).toBe(true);
        expect(new Set(windows.map((win: any) => win.id)).size).toBe(windows.length);
        if (process.env.BEAVER_ZERO_WINDOW_TEST === '1') expect(windows).toEqual([]);
    });

    it('serves instance data even when a supplied UI target does not exist', async () => {
        const result = await post<any>('/beaver/library/libraries', { windowId: 'missing-runtime' });
        expect(result.libraries.length).toBeGreaterThan(0);
        expect(result.error).toBeFalsy();
    });

    it('rejects missing UI targets instead of switching to another renderer', async () => {
        await expect(post('/beaver/test/current-ids', { windowId: 'missing-runtime' }))
            .rejects.toThrow('window_unavailable');
        const { windows } = await post<any>('/beaver/test/window-runtime', { command: 'list' });
        if (!windows.length) {
            await expect(post('/beaver/test/current-ids', {})).rejects.toThrow('window_unavailable');
        } else {
            for (const win of windows) expect(await post('/beaver/test/current-ids', { windowId: win.id })).toBeTruthy();
        }
    });

    it('creates, reads, and removes a fixture note without a renderer command', async () => {
        const note = await post<any>('/beaver/test/note-create', { library_id: 1, html: '<p>Instance endpoint fixture</p>' });
        expect(note.zotero_key).toBeTruthy();
        try {
            const read = await post<any>('/beaver/test/note-read', note);
            expect(read.saved_html).toContain('Instance endpoint fixture');
        } finally {
            expect(await post('/beaver/test/note-delete', note)).toMatchObject({ ok: true });
        }
    });

    it('invokes MuPDF directly through an instance endpoint', async () => {
        const result = await post<any>('/beaver/test/pdf-page-count', SMALL_PDF);
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result.count).toBeGreaterThan(0);
    });
});
