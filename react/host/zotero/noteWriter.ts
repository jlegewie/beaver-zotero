import { logger } from '@beaver/agent-core/platform/logger';
import { getContextWindow } from '../../runtime/windowRuntime';
import type { NoteWriterHost, SaveNoteRequest, SavedNoteReference } from '@beaver/agent-ui/host/types';
import {
    getZoteroTargetContextSync,
    getCurrentLibrary,
    isLibraryEditable,
} from '../../../src/utils/zoteroUtils';
import { selectItem, selectItemById } from '../../utils/selectItem';
import { getSelectedCollection as getSelectedZoteroCollection } from '../../../src/utils/zoteroSelection';
import {
    generateNoteTitle,
    getBeaverNoteFooterHTML,
    wrapWithSchemaVersion,
} from '../../utils/noteActions';
import { currentThreadIdAtom } from '../../atoms/threads';
import { store } from '../../store';
import { libraryRefForLibraryID } from '../../../src/utils/libraryIdentity';

function isInReader(): boolean {
    const win = getContextWindow();
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
    const zp = getContextWindow()?.ZoteroPane;
    return getSelectedZoteroCollection(zp);
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
        const win = getContextWindow();
        const context = getZoteroTargetContextSync(win);
        const selectedCollection = !request.asChild ? getSelectedCollection() : null;
        const inReader = isInReader();
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

        if (selectedCollection) {
            await Zotero.DB.executeTransaction(async () => {
                selectedCollection.addItem(newNote.id);
            });
        }

        // The note is already saved; a failed reveal must not invite a duplicate retry.
        try {
            if (!inReader && !win.closed) {
                if (parentReference) {
                    await selectItem(newNote, true, win);
                } else {
                    await selectItemById(newNote.id, true, selectedCollection?.id, win);
                }
            }
        } catch (error) {
            logger(`saveNote: saved note could not be revealed: ${error}`, 2);
        }

        return {
            library_id: newNote.libraryID,
            zotero_key: newNote.key,
            library_ref: libraryRefForLibraryID(newNote.libraryID) ?? undefined,
            ...(newNote.parentKey ? { parent_key: newNote.parentKey } : {}),
        };
    },
};
