import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { createNote, executeCreateNote, deleteNote, readNote, openNoteEditor, closeNoteEditor } from './helpers/noteTestClient';

// Supply an existing standalone *file* attachment in the isolated test library.
const key = process.env.ZOTERO_TEST_STANDALONE_KEY;
const libraryID = Number(process.env.ZOTERO_TEST_LIBRARY_ID ?? 1);
const notes: string[] = [];
let available = false;
const tag = (loc = 'page6') => `<citation id="${libraryID}-${key}" loc="${loc}"/>`;
// A standalone attachment link opens the file. Matched as a prefix because a
// PDF also carries the cited `?page=`, while other file types do not.
const href = `zotero://open/library/items/${key}`;

async function assertSavedLink(noteKey: string) {
    const html = (await readNote(libraryID, noteKey)).saved_html;
    expect(html).toContain(`href="${href}`);
    expect(html).not.toContain('data-citation=');
    expect(html).toContain('p. 6');
    return html.match(/<a\b[^>]*>[^<]*<\/a>/g)?.find(link => link.includes(href));
}

beforeAll(async () => { available = await isZoteroAvailable(); });
afterEach(async () => {
    await post('/beaver/test/note-preview', { dismiss: true });
    for (const noteKey of notes.splice(0)) {
        await closeNoteEditor(libraryID, noteKey);
        await deleteNote(libraryID, noteKey);
    }
});

describe.skipIf(!key)('standalone attachment note links (live)', () => {
    beforeEach(ctx => skipIfNoZotero(ctx, available));

    it('creates and edits the same link, preserving it through editor saves and read-back edits', async () => {
        const created = await executeCreateNote({ library_id: libraryID, title: 'Standalone citation test', content: `Source ${tag()}` });
        expect(created.success, JSON.stringify(created)).toBe(true);
        const createdKey = created.result_data!.zotero_key;
        notes.push(createdKey);
        const createdLink = await assertSavedLink(createdKey);

        const edited = await createNote({ library_id: libraryID, html: '<p>Anchor</p>' });
        notes.push(edited.zotero_key);
        const data = { library_id: libraryID, zotero_key: edited.zotero_key,
            operation: 'append', new_string: `<p>Source ${tag()}</p>` };
        const validation = await post<any>('/beaver/agent-action/validate', { action_type: 'edit_note', action_data: data });
        expect(validation.valid, JSON.stringify(validation)).toBe(true);
        const result = await post<any>('/beaver/agent-action/execute', {
            action_type: 'edit_note', action_data: { ...data, ...validation.normalized_action_data },
        });
        expect(result.success, JSON.stringify(result)).toBe(true);
        expect(await assertSavedLink(edited.zotero_key)).toBe(createdLink);
        for (const noteKey of notes) {
            const opened = await openNoteEditor(libraryID, noteKey);
            expect(opened.ok, JSON.stringify(opened)).toBe(true);
            expect(opened.in_editor, JSON.stringify(opened)).toBe(true);
            expect((await closeNoteEditor(libraryID, noteKey)).ok).toBe(true);
            await assertSavedLink(noteKey);
            const read = await post<any>('/beaver/note/read', { note_id: `${libraryID}-${noteKey}` });
            expect(read.success, JSON.stringify(read)).toBe(true);
            expect(read.content).toContain(`ref="c_${key}_0"`);
            const edit = await post<any>('/beaver/agent-action/execute', { action_type: 'edit_note', action_data: {
                library_id: libraryID, zotero_key: noteKey, operation: 'str_replace',
                old_string: ', p. 6', new_string: ', p. 7',
            } });
            expect(edit.success, JSON.stringify(edit)).toBe(true);
            const html = (await readNote(libraryID, noteKey)).saved_html;
            expect(html).toContain(`href="${href}`);
            expect(html).toContain('p. 7');
        }
    });

    it.skipIf(!process.env.ZOTERO_TEST_SENTENCE_LOCATOR)('uses the same resolved page display for sentence citations in create, edit, and preview', async () => {
        const content = tag(process.env.ZOTERO_TEST_SENTENCE_LOCATOR!);
        const expectedPage = process.env.ZOTERO_TEST_SENTENCE_PAGE!;
        const created = await executeCreateNote({ library_id: libraryID, title: 'Sentence locator test', content });
        expect(created.success, JSON.stringify(created)).toBe(true);
        notes.push(created.result_data!.zotero_key);
        const edited = await createNote({ library_id: libraryID, html: '<p>Anchor</p>' });
        notes.push(edited.zotero_key);
        const preview = await post<any>('/beaver/test/note-preview', {
            library_id: libraryID, zotero_key: edited.zotero_key,
            edits: [{ oldString: 'Anchor', newString: content }],
        });
        expect(preview.ok, JSON.stringify(preview)).toBe(true);
        expect(preview.html).toContain(`, p. ${expectedPage}`);
        expect(preview.html).not.toContain('sentence ');
        await post('/beaver/test/note-preview', { dismiss: true });
        const data = {
            library_id: libraryID, zotero_key: edited.zotero_key,
            edits: [{ index: 0, operation: 'str_replace', old_string: 'Anchor', new_string: content }],
        };
        const validation = await post<any>('/beaver/agent-action/validate', { action_type: 'edit_note_batch', action_data: data });
        expect(validation.valid, JSON.stringify(validation)).toBe(true);
        const applied = await post<any>('/beaver/agent-action/execute', { action_type: 'edit_note_batch',
            action_data: { ...data, ...validation.normalized_action_data },
        });
        expect(applied.success, JSON.stringify(applied)).toBe(true);
        for (const noteKey of notes) {
            const html = (await readNote(libraryID, noteKey)).saved_html;
            expect(html).toContain(`href="${href}`);
            expect(html).toContain(`, p. ${expectedPage}`);
            expect(html).not.toContain('sentence ');
        }
    });

    it('previews and applies a batch link with the same title and locator, then undoes it', async () => {
        const note = await createNote({ library_id: libraryID, html: '<p>Anchor</p>' });
        notes.push(note.zotero_key);
        const edit = { index: 0, operation: 'str_replace', old_string: 'Anchor', new_string: tag() };
        const preview = await post<any>('/beaver/test/note-preview', {
            library_id: libraryID, zotero_key: note.zotero_key,
            edits: [{ oldString: edit.old_string, newString: edit.new_string }],
        });
        expect(preview.ok, JSON.stringify(preview)).toBe(true);
        expect(preview.html).toContain(href);
        await post('/beaver/test/note-preview', { dismiss: true });
        const action = { id: 'standalone-link-test', action_type: 'edit_note_batch', proposed_data: {
            library_id: libraryID, zotero_key: note.zotero_key, edits: [edit],
        } };
        const applied = await post<any>('/beaver/test/note-apply', { action });
        expect(applied.ok, JSON.stringify(applied)).toBe(true);
        const link = await assertSavedLink(note.zotero_key);
        expect(preview.html).toContain(link);
        const undo = await post<any>('/beaver/test/note-undo', {
            action: { ...action, status: 'applied', result_data: applied.result_data },
        });
        expect(undo.ok, JSON.stringify(undo)).toBe(true);
        expect((await readNote(libraryID, note.zotero_key)).saved_html).toContain('Anchor');
    });
});
