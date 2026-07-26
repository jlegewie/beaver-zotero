/**
 * Live tests for dollar-sign shielding inside code elements during note edits.
 *
 * Literal `$` characters inside plain `<pre>`/`<code>` (e.g. `"$schema"` in
 * JSON, `$HOME/bin:$PATH` in shell) must never be expanded into math wrappers
 * by `expandToRawHtml` — wrapping them corrupts the note because ProseMirror
 * normalization splits the code block around the bogus math span. These tests
 * drive the real validate → execute → read → undo chain over HTTP against a
 * running Zotero.
 *
 * Prerequisites: Zotero running with a dev build of Beaver loaded and
 * authenticated; library_id 1 searchable in Beaver preferences.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import {
    createNote,
    deleteNote,
    readNote,
    undoEditNote,
    validateEditNote,
    executeEditNote,
    buildUndoAction,
    type EditNoteActionData,
} from './helpers/noteTestClient';

const LIBRARY_ID = Number(process.env.ZOTERO_TEST_LIBRARY_ID ?? 1);

let zoteroAvailable = false;
const createdNotes: Array<{ library_id: number; zotero_key: string }> = [];

beforeAll(async () => {
    zoteroAvailable = await isZoteroAvailable();
    if (!zoteroAvailable) {
        console.warn(
            '\nZotero not available — code-shield live tests will be skipped.\n',
        );
    }
});

afterEach(async () => {
    for (const { library_id, zotero_key } of createdNotes) {
        try { await deleteNote(library_id, zotero_key); } catch { /* ignore */ }
    }
    createdNotes.length = 0;
});

async function seedNote(html: string, title?: string): Promise<{ library_id: number; zotero_key: string }> {
    const res = await createNote({ library_id: LIBRARY_ID, html, title });
    if (res.error) throw new Error(`seedNote failed: ${res.error}`);
    const ref = { library_id: res.library_id, zotero_key: res.zotero_key };
    createdNotes.push(ref);
    return ref;
}

describe('edit_note code shielding', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, zoteroAvailable));

    it('str_replace on a JSON code block with dollars: validate → execute keep dollars literal, undo restores', async () => {
        // Each block carries two `$` characters so an unshielded dollar-math
        // pass would pair them into a math span inside the code block.
        const blockA = '<pre>{ "$schema": "https://a.example/schema.json", "$id": "a" }</pre>';
        const blockB = '<pre>{ "$schema": "https://b.example/schema.json", "$id": "b" }</pre>';
        const ref = await seedNote(`<p>Config A:</p>${blockA}<p>Config B:</p>${blockB}`);

        const edit: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'str_replace',
            old_string: blockA,
            new_string: '<pre>{ "$schema": "https://a.example/schema-v2.json", "$id": "a" }</pre>',
        };

        const validation = await validateEditNote(edit);
        expect(validation.error_code, `validate: ${validation.error}`).toBeFalsy();
        expect(validation.valid).toBe(true);

        const res = await executeEditNote(edit, { timeout: 20000 });
        expect(res.error_code, `execute: ${res.error}`).toBeFalsy();
        expect(res.success).toBe(true);
        expect(res.result_data?.occurrences_replaced).toBe(1);

        const after = await readNote(ref.library_id, ref.zotero_key);
        expect(after.saved_html).toContain('"$schema": "https://a.example/schema-v2.json"');
        expect(after.saved_html).toContain(blockB);
        expect(after.saved_html).not.toContain('class="math"');

        const undoRes = await undoEditNote(buildUndoAction(edit, res));
        expect(undoRes.ok, `undo: ${undoRes.error}`).toBe(true);
        const restored = await readNote(ref.library_id, ref.zotero_key);
        expect(restored.saved_html).toContain('"$schema": "https://a.example/schema.json"');
        expect(restored.saved_html).not.toContain('class="math"');
    });

    it('rewrite with a shell code block keeps $HOME/bin:$PATH literal', async () => {
        const ref = await seedNote('<p>Old body.</p>');

        const edit: EditNoteActionData = {
            library_id: ref.library_id,
            zotero_key: ref.zotero_key,
            operation: 'rewrite',
            new_string: '<p>Shell setup:</p><pre>export PATH=$HOME/bin:$PATH</pre>',
        };

        const res = await executeEditNote(edit, { timeout: 20000 });
        expect(res.error_code, `execute: ${res.error}`).toBeFalsy();
        expect(res.success).toBe(true);

        const after = await readNote(ref.library_id, ref.zotero_key);
        expect(after.saved_html).toContain('<pre>export PATH=$HOME/bin:$PATH</pre>');
        expect(after.saved_html).not.toContain('class="math"');
    });
});
