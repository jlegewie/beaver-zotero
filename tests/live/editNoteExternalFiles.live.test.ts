import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { attachExternalFileForTest, deleteExternalFileForTest, post } from '../helpers/zoteroHttpClient';
import { createNote, deleteNote, readNote, openNoteEditor, closeNoteEditor } from './helpers/noteTestClient';

const LIBRARY_ID = Number(process.env.ZOTERO_TEST_LIBRARY_ID ?? 1);
let available = false;
let tempDir: string;
let file: { extKey: string; filename: string; storedPath: string };
let note: { library_id: number; zotero_key: string } | undefined;

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) return;
    tempDir = mkdtempSync(join(tmpdir(), 'beaver-note-files-'));
    const path = join(tempDir, 'Report & findings.txt');
    writeFileSync(path, `A source for live note citation tests: ${tempDir}`);
    const response = await attachExternalFileForTest(path);
    expect(response.ok, response.error).toBe(true);
    file = response.record!;
});
afterEach(async () => {
    if (note) {
        await post('/beaver/test/note-preview', { dismiss: true });
        await closeNoteEditor(note.library_id, note.zotero_key);
        await deleteNote(note.library_id, note.zotero_key);
        note = undefined;
    }
});
afterAll(async () => {
    if (file) await deleteExternalFileForTest(file.extKey);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

const tag = (loc = 'page6', key = file.extKey) => `<citation id="ext-${key}" loc="${loc}"/>`;
async function seed() {
    const created = await createNote({ library_id: LIBRARY_ID, html: '<p>First anchor.</p><p>Second anchor.</p>' });
    expect(created.error).toBeFalsy();
    note = { library_id: created.library_id, zotero_key: created.zotero_key };
}
async function apply(actionType: string, data: any, useNormalized = true) {
    const validation = await post<any>('/beaver/agent-action/validate', { action_type: actionType, action_data: data });
    expect(validation.valid, JSON.stringify(validation)).toBe(true);
    const result = await post<any>('/beaver/agent-action/execute', {
        action_type: actionType, action_data: useNormalized ? { ...data, ...validation.normalized_action_data } : data,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    return { validation, result };
}

function expectFileReference(html: string) {
    expect(html).toContain('Report &amp; findings.txt</a>');
    expect(html).toContain(pathToFileURL(file.storedPath).href.replace(/&/g, '&amp;'));
    expect(html).toContain('p. 6');
    expect(html).not.toContain('<citation');
    expect(html).not.toContain('data-citation=');
}

describe('external-file note citations (live)', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it.each(['rewrite', 'append', 'str_replace'])('supports single %s, editor round-trip, read and targeted edit', async (operation) => {
        await seed();
        await apply('edit_note', { ...note, operation, old_string: 'First anchor.', new_string: `<p>Source ${tag()}</p>` });
        expectFileReference((await readNote(note!.library_id, note!.zotero_key)).saved_html);
        await openNoteEditor(note!.library_id, note!.zotero_key);
        await closeNoteEditor(note!.library_id, note!.zotero_key);
        expectFileReference((await readNote(note!.library_id, note!.zotero_key)).saved_html);
        const read = await post<any>('/beaver/note/read', { note_id: `${note!.library_id}-${note!.zotero_key}` });
        expect(read.success, JSON.stringify(read)).toBe(true);
        const link = read.content.match(/<a\b[^>]*>Report &amp; findings\.txt<\/a>/)?.[0];
        expect(link, read.content).toBeTruthy();
        await apply('edit_note', { ...note, old_string: link, new_string: link.replace('Report &amp; findings.txt', 'Renamed source') });
        expect((await readNote(note!.library_id, note!.zotero_key)).saved_html).toContain('Renamed source</a>');
    });

    it.each([true, false])('applies a mixed batch with a file link and fallback (normalized=%s)', async (useNormalized) => {
        await seed();
        const { validation, result } = await apply('edit_note_batch', {
            ...note,
            edits: [
                { index: 0, old_string: 'First anchor.', new_string: tag() },
                { index: 1, old_string: 'Second anchor.', new_string: tag('s4', 'ZZZZZZZZ') },
            ],
        }, useNormalized);
        const html = (await readNote(note!.library_id, note!.zotero_key)).saved_html;
        expectFileReference(html);
        expect(html).toContain('(Attached file ext-ZZZZZZZZ, sentence 4)');
        expect(validation.warnings?.join(' ')).toContain('ext-ZZZZZZZZ');
        if (!useNormalized) expect(result.result_data.warnings.join(' ')).toContain('ext-ZZZZZZZZ');
    });

    it.each(['edit_note', 'edit_note_batch'])('previews, approves and undoes a %s action with an external-file link', async (actionType) => {
        await seed();
        const original = (await readNote(note!.library_id, note!.zotero_key)).saved_html;
        const opened = await openNoteEditor(note!.library_id, note!.zotero_key, false);
        expect(opened.ok, opened.error).toBe(true);
        const newString = tag();
        const preview = await post<any>('/beaver/test/note-preview', {
            ...note, edits: [{ oldString: 'First anchor.', newString }],
        });
        expect(preview.ok, JSON.stringify(preview)).toBe(true);
        expect(preview.html).toContain('Report &amp; findings.txt');
        expect(preview.html).toContain(pathToFileURL(file.storedPath).href.replace(/&/g, '&amp;'));
        expect(preview.html).not.toContain('Attached file ext-');
        expect((await readNote(note!.library_id, note!.zotero_key)).saved_html).toBe(original);
        await post('/beaver/test/note-preview', { dismiss: true });
        const edit = { index: 0, operation: 'str_replace', old_string: 'First anchor.', new_string: newString };
        const action = {
            id: `external-note-${actionType}`, action_type: actionType, status: 'pending',
            proposed_data: actionType === 'edit_note' ? { ...note, ...edit } : { ...note, edits: [edit] },
        };
        const applied = await post<any>('/beaver/test/note-apply', { action });
        expect(applied.ok, JSON.stringify(applied)).toBe(true);
        expectFileReference((await readNote(note!.library_id, note!.zotero_key)).saved_html);
        if (actionType === 'edit_note') {
            delete applied.result_data.undo_new_html;
            delete applied.result_data.undo_old_html;
        }
        const undo = await post<any>('/beaver/test/note-undo', {
            action: { ...action, status: 'applied', result_data: applied.result_data },
        });
        expect(undo.ok, JSON.stringify(undo)).toBe(true);
        const restored = (await readNote(note!.library_id, note!.zotero_key)).saved_html;
        expect(restored).toContain('First anchor.');
        expect(restored).not.toContain('Report &amp; findings.txt');
    });

    it.each(['edit_note', 'edit_note_batch'])('reports missing filename metadata in React %s approval', async (actionType) => {
        await seed();
        const edit = { index: 0, operation: 'str_replace', old_string: 'First anchor.', new_string: tag('1/2', 'ZZZZZZZZ') };
        const applied = await post<any>('/beaver/test/note-apply', { action: {
            id: 'external-note-missing', action_type: actionType,
            proposed_data: actionType === 'edit_note' ? { ...note, ...edit } : { ...note, edits: [edit] },
        } });
        expect(applied.ok, JSON.stringify(applied)).toBe(true);
        expect(applied.result_data.warnings.join(' ')).toContain('no available filename metadata');
        const html = (await readNote(note!.library_id, note!.zotero_key)).saved_html;
        expect(html).toContain('(Attached file ext-ZZZZZZZZ, 1/2)');
        expect(html).not.toContain('<citation');
    });

    it('supports batch rewrite and preserves page ranges', async () => {
        await seed();
        await apply('edit_note_batch', { ...note, edits: [{ index: 0, operation: 'rewrite', new_string: `<p>${tag('page6-8')}</p>` }] });
        const html = (await readNote(note!.library_id, note!.zotero_key)).saved_html;
        expect(html).toContain('p. 6-8');
        expect(html).toContain('Report &amp; findings.txt</a>');
    });

    it('uses the filename when the managed copy is deleted before execution', async () => {
        await seed();
        // This unique source is separate from the fixture used by other tests.
        const path = join(tempDir, 'Missing copy.txt');
        writeFileSync(path, `Missing copy fixture ${tempDir}`);
        const attached = await attachExternalFileForTest(path);
        expect(attached.ok).toBe(true);
        const record = attached.record!;
        try {
            const data = { ...note, operation: 'append', new_string: `<p>${tag('paragraph2', record.extKey)}</p>` };
            const validation = await post<any>('/beaver/agent-action/validate', { action_type: 'edit_note', action_data: data });
            expect(validation.valid).toBe(true);
            rmSync(record.storedPath);
            const execution = await post<any>('/beaver/agent-action/execute', { action_type: 'edit_note', action_data: data });
            expect(execution.success, JSON.stringify(execution)).toBe(true);
            expect(execution.result_data.warnings.join(' ')).toContain(`ext-${record.extKey}`);
            const html = (await readNote(note!.library_id, note!.zotero_key)).saved_html;
            expect(html).toContain('(Missing copy.txt, paragraph 2)');
            expect(html).not.toContain('file:');
        } finally {
            await deleteExternalFileForTest(record.extKey);
        }
    });
});
