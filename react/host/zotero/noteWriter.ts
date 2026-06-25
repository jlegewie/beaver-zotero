import type { NoteWriterHost, SaveNoteRequest, SavedNoteReference } from '../types';
import {
    getZoteroTargetContext,
    getZoteroTargetContextSync,
    getCurrentLibrary,
    isLibraryEditable,
} from '../../../src/utils/zoteroUtils';
import { selectItem, selectItemById } from '../../../src/utils/selectItem';
import {
    generateNoteTitle,
    getBeaverNoteFooterHTML,
    wrapWithSchemaVersion,
} from '../../utils/noteActions';
import { currentThreadIdAtom } from '../../atoms/threads';
import { store } from '../../store';

function isInReader(): boolean {
    const win = Zotero.getMainWindow();
    return win.Zotero_Tabs?.selectedType === 'reader';
}

function getThreadId(request: SaveNoteRequest): string | null {
    return request.format.threadId ?? store.get(currentThreadIdAtom) ?? null;
}

function assembleNoteHtml(request: SaveNoteRequest): string {
    const threadId = getThreadId(request);
    const runId = request.format.runId;

    if (request.format.kind === 'agent-run') {
        const titleHtml = generateNoteTitle(request.format.responseIndex);
        const brandingHtml = threadId ? getBeaverNoteFooterHTML(threadId, runId) : '';
        return `${titleHtml}${brandingHtml}<hr>${request.contentHtml}<hr>${brandingHtml}`;
    }

    const brandingHtml = threadId && runId ? getBeaverNoteFooterHTML(threadId, runId) : '';
    return `${request.contentHtml}${brandingHtml}`;
}

function getSelectedCollection(): Zotero.Collection | null {
    const zp = Zotero.getActiveZoteroPane();
    return zp?.getSelectedCollection() || null;
}

/** Zotero implementation of {@link NoteWriterHost}. */
export const zoteroNoteWriter: NoteWriterHost = {
    isCurrentLibraryEditable(): boolean {
        const currentLibrary = getCurrentLibrary();
        return currentLibrary ? isLibraryEditable(currentLibrary.libraryID) : false;
    },

    canSaveAsChildNote(): boolean {
        return getZoteroTargetContextSync().parentReference !== null;
    },

    async saveNote(request: SaveNoteRequest): Promise<SavedNoteReference | null> {
        const context = await getZoteroTargetContext();
        if (typeof context.targetLibraryId !== 'number') {
            throw new Error('Could not determine target library');
        }
        if (!isLibraryEditable(context.targetLibraryId)) {
            throw new Error('Library is read-only');
        }

        const parentReference = request.asChild ? context.parentReference : null;
        if (request.requireParent && !parentReference) {
            return null;
        }

        const newNote = new Zotero.Item('note');
        if (parentReference) {
            newNote.libraryID = parentReference.library_id;
            newNote.parentKey = parentReference.zotero_key;
        } else {
            newNote.libraryID = context.targetLibraryId;
        }

        newNote.setNote(wrapWithSchemaVersion(assembleNoteHtml(request)));
        await newNote.saveTx();

        const selectedCollection = !parentReference ? getSelectedCollection() : null;
        if (selectedCollection) {
            await Zotero.DB.executeTransaction(async () => {
                selectedCollection.addItem(newNote.id);
            });
        }

        if (!isInReader()) {
            if (parentReference) {
                await selectItem(newNote);
            } else {
                await selectItemById(newNote.id, true, selectedCollection?.id);
            }
        }

        return {
            library_id: newNote.libraryID,
            zotero_key: newNote.key,
            ...(newNote.parentKey ? { parent_key: newNote.parentKey } : {}),
        };
    },
};
