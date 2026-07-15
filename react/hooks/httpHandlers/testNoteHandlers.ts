/**
 * Dev-only HTTP handlers for note seeding, teardown, inspection, editor
 * lifecycle, and undo.
 *
 * Extracted from `useHttpEndpoints.ts`. Handler exports are wired to paths
 * in `useHttpEndpoints.ts` → `registerEndpoints()`.
 */

import { wrapWithSchemaVersion } from '../../utils/noteActions';
import { undoEditNoteAction, undoEditNoteBatchAction } from '../../utils/editNoteActions';
import { getLatestNoteHtml } from '../../../src/utils/noteEditorIO';
import type { AgentAction } from '../../agents/agentActions';
import { UNRESOLVED_LIBRARY_ID } from '../../../src/utils/libraryIdentity';


export async function handleTestNoteCreateHttpRequest(request: any) {
    const { library_id, html, title, parent_key, wrap_schema } = request as {
        library_id?: number;
        html: string;
        title?: string;
        parent_key?: string;
        wrap_schema?: boolean;
    };
    if (typeof html !== 'string') {
        return { error: 'html is required' };
    }
    const note = new Zotero.Item('note');
    if (typeof library_id === 'number') note.libraryID = library_id;
    if (parent_key) note.parentKey = parent_key;

    const body = title ? `<h1>${title}</h1>${html}` : html;
    const wrapped = wrap_schema === false ? body : wrapWithSchemaVersion(body);
    note.setNote(wrapped);
    await note.saveTx();

    return {
        library_id: note.libraryID,
        zotero_key: note.key,
        item_id: note.id,
    };
}

export async function handleTestNoteDeleteHttpRequest(request: any) {
    const { library_id, zotero_key } = request;
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { ok: true, deleted: false };
    if (!item.isNote()) return { error: 'not_a_note' };
    await Zotero.Items.erase([item.id]);
    return { ok: true, deleted: true };
}

export async function handleTestNoteReadHttpRequest(request: any) {
    const { library_id, zotero_key } = request;
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { error: 'not_found' };
    if (!item.isNote()) return { error: 'not_a_note' };
    await item.loadDataType('note');
    const savedHtml: string = item.getNote();
    let liveHtml: string | null = null;
    try {
        liveHtml = getLatestNoteHtml(item);
    } catch {
        liveHtml = null;
    }
    let inEditor = false;
    try {
        const instances = (Zotero as any).Notes._editorInstances;
        if (Array.isArray(instances)) {
            inEditor = instances.some((inst: any) => {
                if (!inst._item || inst._item.id !== item.id) return false;
                try {
                    const frameElement = inst._iframeWindow?.frameElement;
                    return frameElement?.isConnected === true;
                } catch {
                    return false;
                }
            });
        }
    } catch {
        inEditor = false;
    }
    return {
        library_id: item.libraryID,
        zotero_key: item.key,
        item_id: item.id,
        saved_html: savedHtml,
        live_html: liveHtml,
        in_editor: inEditor,
    };
}

export async function handleTestNoteOpenEditorHttpRequest(request: any) {
    const { library_id, zotero_key, open_in_window } = request;
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { error: 'not_found' };
    if (!item.isNote()) return { error: 'not_a_note' };

    const openInWindow = open_in_window !== false;
    await (Zotero as any).Notes.open(item.id, undefined, { openInWindow });

    // Wait briefly for the editor instance to attach
    let inEditor = false;
    for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
            const instances = (Zotero as any).Notes._editorInstances;
            if (Array.isArray(instances)) {
                inEditor = instances.some((inst: any) => {
                    if (!inst._item || inst._item.id !== item.id) return false;
                    const frame = inst._iframeWindow?.frameElement;
                    return frame?.isConnected === true;
                });
            }
        } catch {
            inEditor = false;
        }
        if (inEditor) break;
    }
    return { ok: true, in_editor: inEditor };
}

export async function handleTestNoteCloseEditorHttpRequest(request: any) {
    const { library_id, zotero_key } = request;
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { error: 'not_found' };

    let closed = 0;
    try {
        const instances = (Zotero as any).Notes._editorInstances ?? [];
        for (const inst of [...instances]) {
            if (!inst._item || inst._item.id !== item.id) continue;
            const frame = inst._iframeWindow?.frameElement;
            const instanceWin = frame?.ownerDocument?.defaultView;
            try {
                if (inst.viewMode === 'window' && instanceWin && instanceWin.close) {
                    instanceWin.close();
                    closed++;
                    continue;
                }
                if (inst.tabID) {
                    const mainWin: any = Zotero.getMainWindow?.();
                    if (mainWin?.Zotero_Tabs?.close) {
                        mainWin.Zotero_Tabs.close(inst.tabID);
                        closed++;
                        continue;
                    }
                }
                if (typeof inst.uninit === 'function') {
                    await inst.uninit();
                    closed++;
                }
            } catch {
                // best-effort
            }
        }
    } catch {
        // best-effort
    }
    // Let Zotero settle
    await new Promise((r) => setTimeout(r, 150));
    return { ok: true, closed };
}

export async function handleTestNoteUndoHttpRequest(request: any) {
    const { action } = request as { action: AgentAction };
    if (!action || !action.proposed_data) {
        return { error: 'action with proposed_data is required' };
    }
    try {
        if (action.action_type === 'edit_note_batch') {
            await undoEditNoteBatchAction(action);
        } else {
            await undoEditNoteAction(action);
        }
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
    }
}
