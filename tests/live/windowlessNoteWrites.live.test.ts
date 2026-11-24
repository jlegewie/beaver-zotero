/**
 * Live tests: note writes render their Markdown in the plugin realm, so they
 * work with no Zotero window open and write the same note HTML as with one.
 *
 * Writes go through `/beaver/agent-action/execute`, the originless path the
 * backend's data requests and MCP use. Closing every main window is only
 * possible on macOS, where Zotero keeps running without one; elsewhere the
 * suite skips.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { post } from '../helpers/zoteroHttpClient';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { deleteNote, executeCreateNote, executeEditNote, readNote } from './helpers/noteTestClient';

interface MainWindowsState {
    ok?: boolean;
    error?: string;
    mainWindows: number;
    readyMainWindows: number;
    canClose: boolean;
}

const mainWindows = (body: Record<string, unknown> = {}) =>
    post<MainWindowsState>('/beaver/test/main-windows', body, { timeout: 30_000 });

const CONTENT = [
    '## Windowless heading',
    '',
    'Text with **bold**, it\'s `a < b` & $x^2$.[^1]',
    '',
    '| Measure | Value |',
    '|:--|--:|',
    '| Age (years) | 42 |',
    '',
    '- [x] done item',
    '',
    '```html',
    '<citation id="u-EXAMPLE1"/> stays code',
    '```',
    '',
    '[^1]: A footnote.',
].join('\n');

/** The note body without the parts that differ per note. */
function noteBody(html: string): string {
    return html.replace(/<h1>[^<]*<\/h1>/, '<h1/>');
}

let available = false;
let canClose = false;
const created: Array<{ library_id: number; zotero_key: string }> = [];

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (available) canClose = (await mainWindows()).canClose;
});

afterAll(async () => {
    if (!available) return;
    await mainWindows({ action: 'open' });
    for (const note of created) await deleteNote(note.library_id, note.zotero_key).catch(() => {});
});

describe('note writes with no main window (live)', () => {
    beforeEach(ctx => {
        skipIfNoZotero(ctx, available);
        if (!canClose) ctx.skip();
    });

    it('creates and edits a note with every main window closed, as it does with one open', async () => {
        const windowed = await executeCreateNote({ title: 'TEST-BEAVER windowless A', content: CONTENT });
        expect(windowed.success, windowed.error ?? '').toBe(true);
        created.push(windowed.result_data!);
        const windowedHtml = (await readNote(windowed.result_data!.library_id, windowed.result_data!.zotero_key)).saved_html;

        const closed = await mainWindows({ action: 'close' });
        expect(closed).toMatchObject({ ok: true, mainWindows: 0, readyMainWindows: 0 });

        try {
            const windowless = await executeCreateNote({ title: 'TEST-BEAVER windowless B', content: CONTENT });
            expect(windowless.success, windowless.error ?? '').toBe(true);
            created.push(windowless.result_data!);
            const { library_id, zotero_key } = windowless.result_data!;

            const html = (await readNote(library_id, zotero_key)).saved_html;
            expect(noteBody(html)).toBe(noteBody(windowedHtml));
            expect(html).toContain('<span class="math">$x^2$</span>');
            expect(html).toContain('<th style="text-align:left">Measure</th>');
            expect(html).toContain('<h2>Notes</h2>');
            expect(html).toContain('&lt;citation id=&quot;u-EXAMPLE1&quot;/&gt; stays code');

            // A Markdown old_string reaches the note through the render fallback.
            const edit = await executeEditNote({
                library_id,
                zotero_key,
                old_string: '## Windowless heading',
                new_string: '## Windowless heading, **edited**',
            });
            expect(edit.success, edit.error ?? '').toBe(true);
            expect((await readNote(library_id, zotero_key)).saved_html)
                .toContain('<h2>Windowless heading, <strong>edited</strong></h2>');

            expect((await mainWindows()).mainWindows).toBe(0);
        } finally {
            const reopened = await mainWindows({ action: 'open' });
            expect(reopened).toMatchObject({ ok: true });
        }
    }, 120_000);
});
