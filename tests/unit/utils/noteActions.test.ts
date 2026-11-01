import { installMutationInstance } from '../../helpers/mutationInstance';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/store', () => ({
    store: {
        get: vi.fn(() => ''),
        set: vi.fn(),
    },
}));

vi.mock('../../../react/atoms/threads', () => ({
    currentThreadNameAtom: Symbol('currentThreadNameAtom'),
}));

import {
    buildProvenanceNoteHTML,
    createProvenanceNote,
} from '../../../react/utils/noteActions';
import { store } from '../../../react/store';

class MockNoteItem {
    libraryID?: number;
    parentKey?: string;
    key = 'NOTEKEY';
    setNote = vi.fn();
    saveTx = vi.fn(async () => 123);
}

describe('buildProvenanceNoteHTML', () => {
    it('includes marker, escaped reason, and a conversation link', () => {
        const html = buildProvenanceNoteHTML({
            reason: 'because <important> & useful',
            threadId: 'thread-1',
            runId: 'run-1',
        });

        expect(html).toContain('<strong>Added by Beaver</strong>');
        expect(html).toContain('because &lt;important&gt; &amp; useful');
        expect(html).toContain('zotero://beaver/thread/thread-1/run/run-1');
    });

    it('omits the conversation link when no thread ID is available', () => {
        const html = buildProvenanceNoteHTML({ reason: 'Imported from search' });

        expect(html).toContain('<strong>Added by Beaver</strong>');
        expect(html).not.toContain('zotero://beaver/thread/');
    });
});

describe('createProvenanceNote', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        installMutationInstance();
    });

    it('creates a schema-wrapped child note', async () => {
        const note = new MockNoteItem();
        (globalThis as any).Zotero.Item = vi.fn(() => note);

        await createProvenanceNote(
            { library_id: 12, zotero_key: 'PARENTKEY' },
            { threadId: 'thread-1' },
        );

        expect(note.libraryID).toBe(12);
        expect(note.parentKey).toBe('PARENTKEY');
        expect(note.setNote).toHaveBeenCalledWith(expect.stringContaining('data-schema-version="9"'));
        expect(note.saveTx).toHaveBeenCalled();
    });
});
