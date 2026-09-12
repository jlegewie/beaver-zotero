import { handleTestNoteCreateHttpRequest, handleTestNoteDeleteHttpRequest, handleTestNoteReadHttpRequest } from '../../../src/services/localEndpoints/handlers/testNoteHandlers';
export { handleTestNoteCreateHttpRequest, handleTestNoteDeleteHttpRequest, handleTestNoteReadHttpRequest } from '../../../src/services/localEndpoints/handlers/testNoteHandlers';
/**
 * Dev-only HTTP handlers for note seeding, teardown, inspection, editor
 * lifecycle, and undo.
 *
 * Extracted from `useHttpEndpoints.ts`. Handler exports are wired to paths
 * in `useHttpEndpoints.ts` → `registerEndpoints()`.
 */

import { UNRESOLVED_LIBRARY_ID } from '../../../src/utils/libraryIdentity';
import { getLatestNoteHtml, isLiveNoteEditor } from '../../../src/utils/noteEditorIO';
import { containsPreviewMarkers } from '../../../src/utils/notePreviewGuard';
import type { AgentAction } from '../../agents/agentActions';
import { executeEditNoteOrBatchAction, undoEditNoteOrBatchAction } from '../../utils/editNoteActions';
import { wrapWithSchemaVersion } from '../../utils/noteActions';

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
                    // Zotero can expose the content window without frameElement.
                    const editor = inst._iframeWindow?.document?.querySelector('.ProseMirror');
                    return editor?.isConnected === true;
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
                    const mainWin: any = Zotero.getMainWindows().find(win => win.Zotero_Tabs?._tabs?.some((tab: any) => tab.id === inst.tabID));
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
        await undoEditNoteOrBatchAction(action);
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
    }
}


/** Exercise the same local executor used when approving a stored note action. */
export async function handleTestNoteApplyHttpRequest(request: any) {
    const action = request.action as AgentAction;
    if (!action?.proposed_data || !['edit_note', 'edit_note_batch'].includes(action.action_type)) {
        return { ok: false, error: 'An edit_note or edit_note_batch action is required' };
    }
    try {
        return { ok: true, result_data: await executeEditNoteOrBatchAction(action) };
    } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
    }
}

/** Render a real note-editor preview and return its displayed HTML for live checks. */
export async function handleTestNotePreviewHttpRequest(request: any) {
    const { showDiffPreview, dismissDiffPreview } = await import('../../utils/noteEditorDiffPreview');
    if (request.dismiss) {
        await dismissDiffPreview();
        return { ok: true };
    }
    const { library_id, zotero_key, edits } = request;
    if (typeof library_id !== 'number' || typeof zotero_key !== 'string' || !Array.isArray(edits)) {
        return { ok: false, error: 'Provide library_id, zotero_key and edits' };
    }
    const shown = await showDiffPreview(library_id, zotero_key, edits);
    const itemID = Zotero.Items.getIDFromLibraryAndKey(library_id, zotero_key);
    const instance = (Zotero as any).Notes._editorInstances.find((inst: any) => (
        inst.itemID === itemID && inst._disableSaving
    ));
    const readHtml = () => instance?._iframeWindow?.wrappedJSObject?._currentEditorInstance?._editorCore?.view?.dom?.innerHTML;
    let html = readHtml();
    // The editor receives its update asynchronously through postMessage.
    for (let attempt = 0; shown && !containsPreviewMarkers(html ?? '') && attempt < 60; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        html = readHtml();
    }
    return { ok: shown, html };
}
