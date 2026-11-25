import { describe, expect, it, vi } from 'vitest';
const restore = vi.hoisted(() => vi.fn((): Promise<void> => Promise.resolve()));
vi.mock('../../../src/services/restorePreviewEditor', () => ({ restorePreviewEditor: restore }));
import { NotePreviews } from '../../../src/services/notePreviews';

describe('editor preview ownership', () => {
    it('isolates editors and refuses a second owner of the same editor', async () => {
        const previews = new NotePreviews();
        const editorA = {}, editorB = {};
        const dismissA = vi.fn(async () => {}), dismissB = vi.fn(async () => {});
        const releaseA = previews.claim(editorA, { owner: 'A', libraryId: 1, key: 'NOTE', dismiss: dismissA });
        previews.claim(editorB, { owner: 'B', libraryId: 1, key: 'OTHER', dismiss: dismissB });
        expect(previews.claim(editorA, { owner: 'B', libraryId: 1, key: 'NOTE', dismiss: dismissB })).toBeNull();
        await previews.dismissNote(1, 'NOTE');
        expect(dismissA).toHaveBeenCalledOnce();
        expect(dismissB).not.toHaveBeenCalled();
        releaseA!();
        expect(previews.claim(editorA, { owner: 'B', libraryId: 1, key: 'NOTE', dismiss: dismissB })).not.toBeNull();
        releaseA!();
        expect(previews.claim(editorA, { owner: 'C', libraryId: 1, key: 'NOTE', dismiss: dismissB })).toBeNull();
    });

    it('awaits every editor restoration for a note and detaches only the requested owner', async () => {
        const previews = new NotePreviews();
        let resolve!: () => void;
        const pending = new Promise<void>(r => { resolve = r; });
        const other = vi.fn(async () => {});
        const editor = {};
        restore.mockReturnValueOnce(pending);
        previews.claim(editor, { owner: 'A', libraryId: 1, key: 'NOTE', dismiss: () => { previews.restoreEditor(editor, false, 1); } });
        previews.claim({}, { owner: 'B', libraryId: 1, key: 'NOTE', dismiss: other });
        let done = false;
        const detached = previews.detachOwner('A').then(() => { done = true; });
        await Promise.resolve();
        expect(done).toBe(false);
        expect(other).not.toHaveBeenCalled();
        resolve();
        await detached;
        await previews.dismissNote(1, 'NOTE');
        expect(other).toHaveBeenCalledOnce();
    });

    it('tells listeners when a library write ends, not when one starts', () => {
        const previews = new NotePreviews();
        const settled = vi.fn();
        const stop = previews.whenWritesSettle(settled);
        previews.setMutationActive(true);
        expect(previews.isWriting()).toBe(true);
        expect(previews.claim({}, { owner: 'A', libraryId: 1, key: 'NOTE', dismiss: vi.fn() })).toBeNull();
        expect(settled).not.toHaveBeenCalled();
        previews.setMutationActive(false);
        previews.setMutationActive(false);
        expect(settled).toHaveBeenCalledOnce();
        stop();
        previews.setMutationActive(true);
        previews.setMutationActive(false);
        expect(settled).toHaveBeenCalledOnce();
    });
});
