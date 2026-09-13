import { UNRESOLVED_LIBRARY_ID } from '../../../utils/libraryIdentity';
import { getLatestNoteHtml, isLiveNoteEditor } from '../../../utils/noteEditorIO';
import { wrapWithSchemaVersion } from '../../../utils/noteProvenance';

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
                    return isLiveNoteEditor(inst);
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
