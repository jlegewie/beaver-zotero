import { beforeAll, describe, expect, it } from 'vitest';
import { isZoteroAvailable } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { createNote, deleteNote, readNote } from './helpers/noteTestClient';

const path = '/beaver/test/window-runtime';

describe.runIf(process.env.BEAVER_MULTI_WINDOW_TEST === '1')('mutations from independent renderer bundles', () => {
    beforeAll(async () => { expect(await isZoteroAvailable()).toBe(true); });

    it('preserves both windows’ edits to the same note and coordinates undo from the other window', async () => {
        const { windows } = await post<{ windows: { id: string }[] }>(path, { command: 'list' });
        expect(windows.length).toBeGreaterThanOrEqual(2);
        const note = await createNote({ html: '<p>Alpha original.</p><p>Beta original.</p>', library_id: 1 });
        const edit = (index: number, oldString: string, newString: string) => post<any>(path, {
            command: 'execute-action', windowId: windows[index].id,
            mutation: {
                event: 'agent_action_execute', request_id: `multi-window-${index}`,
                action_type: 'edit_note',
                action_data: { library_id: note.library_id, zotero_key: note.zotero_key, old_string: oldString, new_string: newString },
            },
        });
        try {
            const [a, b] = await Promise.all([edit(0, 'Alpha original.', 'Alpha changed.'), edit(1, 'Beta original.', 'Beta changed.')]);
            expect(a.success, a.error).toBe(true);
            expect(b.success, b.error).toBe(true);
            const after = await readNote(note.library_id, note.zotero_key);
            expect(after.saved_html).toContain('Alpha changed.');
            expect(after.saved_html).toContain('Beta changed.');
            const undone = await post<any>(path, {
                command: 'undo-note-action', windowId: windows[1].id,
                undo: { action_type: 'edit_note', status: 'applied', result_data: a.result_data,
                    proposed_data: { library_id: note.library_id, zotero_key: note.zotero_key, old_string: 'Alpha original.', new_string: 'Alpha changed.' } },
            });
            expect(undone.ok).toBe(true);
            const final = await readNote(note.library_id, note.zotero_key);
            expect(final.saved_html).toContain('Alpha original.');
            expect(final.saved_html).toContain('Beta changed.');
        } finally {
            await deleteNote(note.library_id, note.zotero_key);
        }
    });
});
