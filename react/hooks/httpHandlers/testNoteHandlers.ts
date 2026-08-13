/**
 * Dev-only HTTP handlers for note seeding, teardown, inspection, editor
 * lifecycle, and undo.
 *
 * Extracted from `useHttpEndpoints.ts`. Handler exports are wired to paths
 * in `useHttpEndpoints.ts` → `registerEndpoints()`.
 */

import { wrapWithSchemaVersion } from '../../utils/noteActions';
import { undoEditNoteVariantAction } from '../../utils/editNoteActions';
import {
    getLatestNoteHtml,
    isNoteInEditor,
    isNoteEditorFrameConnected,
    noteEditorFrameElement,
} from '../../../src/utils/noteEditorIO';
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

/**
 * Return three views of a note:
 *   - `saved_html`  what the DB holds,
 *   - `live_html`   what Beaver's read path sees (unsaved editor content
 *                   included),
 *   - `editor_html` the open editor's own serialization, unconditionally
 *                   (see `editorSerializedHtml`), or null when none is open.
 */
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
    const inEditor = isNoteInEditor(item.id);
    return {
        library_id: item.libraryID,
        zotero_key: item.key,
        item_id: item.id,
        saved_html: savedHtml,
        live_html: liveHtml,
        editor_html: editorSerializedHtml(item.id),
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
    for (let i = 0; i < 30 && !inEditor; i++) {
        await new Promise((r) => setTimeout(r, 100));
        inEditor = isNoteInEditor(item.id);
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
            const instanceWin = noteEditorFrameElement(inst)?.ownerDocument?.defaultView;
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

/**
 * Zotero's note editor debounces its save by 1s after a document change
 * (`debouncedUpdate` in note-editor's `editor-core.js`). Held here so the
 * unsaved-content handler can wait the debounce out.
 */
const NOTE_EDITOR_SAVE_DEBOUNCE_MS = 1000;

/** Connected editor instances pointing at `itemId`, in registry order. */
function connectedEditorInstances(itemId: number): any[] {
    const instances = (Zotero as any).Notes?._editorInstances;
    if (!Array.isArray(instances)) return [];
    return instances.filter(
        (inst: any) => inst?._item?.id === itemId && isNoteEditorFrameConnected(inst),
    );
}

/**
 * The note editor's own serialization of its live ProseMirror document.
 *
 * `getDataSync(true)` — what the read path uses — returns null unless the
 * document changed since the last save, so it cannot show what an untouched
 * editor made of the stored HTML. Called with no argument it always serializes,
 * which is the only way to observe a ProseMirror parse + serialize round trip
 * from outside the editor.
 *
 * Returns null when no connected editor instance produces one.
 */
function editorSerializedHtml(itemId: number): string | null {
    for (const inst of connectedEditorInstances(itemId)) {
        try {
            const data = inst._iframeWindow.wrappedJSObject.getDataSync();
            // Clone out of the XPCOM sandbox wrapper before reading.
            const html = data ? JSON.parse(JSON.stringify(data)).html : null;
            if (typeof html === 'string') return html;
        } catch {
            continue;
        }
    }
    return null;
}

/** The note-editor's `EditorCore` inside the iframe, or null if uninitialized. */
function editorCoreOf(inst: any): any | null {
    try {
        return inst?._iframeWindow?.wrappedJSObject?._currentEditorInstance?._editorCore ?? null;
    } catch {
        return null;
    }
}

/**
 * Put UNSAVED content into an open note editor.
 *
 * Types `text` into the note's live ProseMirror document and leaves the editor
 * dirty — `getLatestNoteHtml(item)` sees the text while `item.getNote()` does
 * not — which is the state a user produces by typing and not waiting for the
 * autosave. Nothing else in the test harness can reach it, and the
 * validate/execute asymmetry in `edit_note_blocks` (validate digests the live
 * editor, execute digests the DB after `flushLiveEditorToDB`) is only
 * observable from it.
 *
 * Mechanics, and why the call takes over a second. A doc-changing transaction
 * schedules the editor's 1s-debounced save, and that save has to be neutralized
 * on BOTH of the paths that would end the unsaved state:
 *
 *   - `EditorInstance._disableSaving` is held across the debounce window so
 *     `_save` returns early and the DB never moves. It is then RESTORED, which
 *     is load-bearing: `collectLiveCandidates` skips `_disableSaving`
 *     instances, so leaving it set would hide the dirty editor from exactly the
 *     read path under test.
 *   - `EditorCore.docChanged` is re-armed afterwards. The debounce still fires
 *     and `update()` clears that flag even though nothing was persisted, and
 *     `getDataSync(true)` — the accessor `collectLiveCandidates` reads — returns
 *     null while it is false. Without this the editor would hold unsaved text
 *     that it refuses to hand out.
 *
 * The dirty state then survives until the next doc change in that editor.
 *
 * Request: `{ library_id, zotero_key, text, at?: 'end' | 'start' }`
 * (`at` defaults to `'end'` — the text lands in the last/first text block).
 */
export async function handleTestNoteSetUnsavedHttpRequest(request: any) {
    const { library_id, zotero_key, text, at } = request as {
        library_id?: number;
        zotero_key?: string;
        text?: string;
        at?: 'end' | 'start';
    };
    if (library_id == null || zotero_key == null || library_id === UNRESOLVED_LIBRARY_ID) {
        return { error: 'Provide library_id + zotero_key' };
    }
    if (typeof text !== 'string' || text === '') {
        return { error: 'text is required' };
    }
    if (at !== undefined && at !== 'end' && at !== 'start') {
        return { error: "at must be 'end' or 'start'" };
    }

    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { error: 'not_found' };
    if (!item.isNote()) return { error: 'not_a_note' };
    await item.loadDataType('note');

    const instances = connectedEditorInstances(item.id);
    const inst = instances.find((candidate) => editorCoreOf(candidate)?.view);
    if (!inst) {
        return { error: 'no_live_editor', instances_matched: instances.length };
    }
    if (inst._readOnly) return { error: 'editor_read_only' };

    const core = editorCoreOf(inst);
    const view = core.view;
    const savedBefore: string = item.getNote();
    const wasSavingDisabled = !!inst._disableSaving;

    try {
        inst._disableSaving = true;

        // `Selection` reached through the live selection's prototype chain so
        // every argument stays in the content compartment — the same
        // cross-compartment constraint `selectAndScrollInNoteEditor` documents.
        const SelectionClass = Object.getPrototypeOf(
            Object.getPrototypeOf(view.state.selection),
        ).constructor;
        const edge = at === 'start'
            ? SelectionClass.atStart(view.state.doc)
            : SelectionClass.atEnd(view.state.doc);
        view.dispatch(view.state.tr.insertText(text, edge.head));

        // Wait the editor's save debounce out while saving is still disabled.
        await new Promise((r) => setTimeout(r, NOTE_EDITOR_SAVE_DEBOUNCE_MS + 400));
    } catch (e: any) {
        return { error: `insert_failed: ${e?.message || e}` };
    } finally {
        // Order matters: re-arm the "has unsaved changes" flag the swallowed
        // save cleared BEFORE saving is possible again, so no window exists in
        // which a doc change could persist the marker.
        try { core.docChanged = true; } catch { /* best-effort */ }
        inst._disableSaving = wasSavingDisabled;
    }

    const savedHtml: string = item.getNote();
    let liveHtml: string | null = null;
    try {
        liveHtml = getLatestNoteHtml(item);
    } catch {
        liveHtml = null;
    }

    return {
        ok: true,
        // The caller's contract: the editor holds content the DB has not seen.
        // False means the save leaked through (or the wrong instance was
        // dirtied) — reported rather than thrown so the test can say so.
        dirty: liveHtml !== null && liveHtml !== savedHtml && liveHtml.includes(text),
        saved_changed: savedHtml !== savedBefore,
        instances_matched: instances.length,
        saved_html: savedHtml,
        live_html: liveHtml,
    };
}

export async function handleTestNoteUndoHttpRequest(request: any) {
    const { action } = request as { action: AgentAction };
    if (!action || !action.proposed_data) {
        return { error: 'action with proposed_data is required' };
    }
    try {
        // This endpoint has always accepted an action WITHOUT an `action_type`
        // and treated it as a v1 single edit — the router it calls used to be a
        // ternary on `=== 'edit_note_batch'` that fell through to the v1 path.
        // That router is now an exhaustive switch that THROWS on an unknown
        // type (so a missing registration fails loudly instead of silently
        // mis-dispatching), which would otherwise turn every existing
        // `action_type`-less caller into an error. Default here rather than
        // loosening the router: production callers always carry a real type.
        await undoEditNoteVariantAction(
            action.action_type ? action : { ...action, action_type: 'edit_note' },
        );
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
    }
}
