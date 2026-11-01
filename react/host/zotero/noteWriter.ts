import { logger } from '@beaver/agent-core/platform/logger';
import type { NoteWriterHost, SaveNoteRequest, SavedNoteReference } from '@beaver/agent-ui/host/types';
import { libraryRefForLibraryID } from '../../../src/utils/libraryIdentity';
import { isLibraryEditable } from '../../../src/utils/zoteroUtils';
import { currentThreadIdAtom } from '../../atoms/threads';
import { runWindowOperation } from '../../runtime/libraryMutation';
import { getContextWindow } from '../../runtime/windowRuntime';
import { store } from '../../store';
import {
    generateNoteTitle,
    getBeaverNoteFooterHTML,
    wrapWithSchemaVersion,
} from '../../utils/noteActions';
import { selectItem, selectItemById } from '../../utils/selectItem';
import { getCurrentLibrary, getLibraryViewCollection, getZoteroTargetContextSync, isLibraryTabSelected } from '../../utils/zoteroTargetContext';

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

/** Zotero implementation of {@link NoteWriterHost}. */
export const zoteroNoteWriter: NoteWriterHost = {
    isCurrentLibraryEditable(): boolean {
        const currentLibrary = getCurrentLibrary();
        return currentLibrary ? isLibraryEditable(currentLibrary.libraryID) : false;
    },

    canSaveAsChildNote(): boolean {
        return getZoteroTargetContextSync().parentReference !== null;
    },

    childNoteParentTitle(): string | null {
        const parentReference = getZoteroTargetContextSync().parentReference;
        if (!parentReference) return null;
        try {
            const item = Zotero.Items.getByLibraryAndKey(parentReference.library_id, parentReference.zotero_key);
            return (item && item.getDisplayTitle()) || null;
        } catch {
            // Item data not loaded: the menu names no title rather than failing.
            return null;
        }
    },

    async saveNote(request: SaveNoteRequest): Promise<SavedNoteReference | null> {
        const win = getContextWindow();
        const context = getZoteroTargetContextSync(win);
        // Outside the library tab (a reader, a Beaver tab) the library pane's
        // collection is hidden: the note is not filed there, and saving does
        // not switch tabs to reveal it.
        const inLibraryTab = isLibraryTabSelected(win);
        const selectedCollection = !request.asChild ? getLibraryViewCollection(win) : null;
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

        const html = wrapWithSchemaVersion(assembleNoteHtml(request));
        const newNote = await runWindowOperation('savePreparedNote', [{
            libraryId: parentReference?.library_id ?? context.targetLibraryId,
            parentKey: parentReference?.zotero_key,
            collectionId: selectedCollection?.id,
            html,
        }]);

        // The note is already saved; a failed reveal must not invite a duplicate retry.
        try {
            if (inLibraryTab && !win.closed) {
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
