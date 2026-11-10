/**
 * The result line of a feature-credit completion card, built from the
 * accepted changes of the run that earned it. Needs that run's actions,
 * which the window has while that chat is open; otherwise there is no result
 * line and the card shows only the credits.
 */
import type { AgentAction } from '../../agents/agentActions';
import type { FeatureCreditSource } from '@beaver/agent-core/types/profile';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { parseItemReference } from '@beaver/agent-core/identity/libraryRef';
import { getAppliedPdfAnnotationCount } from '../../agents/agentActionCounts';
import { getDisplayNameFromItem, getZoteroItem } from '../../utils/sourceUtils';

export type FeatureCreditResultTarget =
    | { kind: 'open_item'; ref: ZoteroItemReference; label: string }
    | { kind: 'reveal_item'; ref: ZoteroItemReference; label: string }
    | { kind: 'open_table'; jobId: string; label: string };

export interface FeatureCreditResult {
    text: string;
    target: FeatureCreditResultTarget | null;
    /** The note the task created, for the Export follow-up. */
    note?: ZoteroItemReference;
}

const ANNOTATION_TYPES = new Set(['create_highlight_annotations', 'create_note_annotations', 'highlight_annotation', 'note_annotation']);
const ORGANIZE_TYPES = new Set(['organize_items', 'manage_tags', 'create_collection', 'manage_collections', 'edit_metadata', 'merge_items']);

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function lookupItem(ref: { library_id?: number; library_ref?: string; zotero_key?: string }): Zotero.Item | null {
    return ref.zotero_key ? getZoteroItem({ library_id: ref.library_id, library_ref: ref.library_ref, zotero_key: ref.zotero_key } as ZoteroItemReference) : null;
}

function itemRef(item: Zotero.Item): ZoteroItemReference {
    return { library_id: item.libraryID, zotero_key: item.key };
}

function paperName(item: Zotero.Item | null): string | null {
    if (!item) return null;
    const paper = (item.isAttachment() || item.isNote()) && item.parentItem ? item.parentItem : item;
    return getDisplayNameFromItem(paper);
}

function annotateResult(actions: AgentAction[]): FeatureCreditResult | null {
    const applied = actions.filter((action) => ANNOTATION_TYPES.has(action.action_type));
    const count = applied.reduce((sum, action) => sum + getAppliedPdfAnnotationCount(action), 0);
    if (count === 0) return null;
    // The batch tools name the document as `resolved_ref`; the single
    // annotation tools carry its key directly.
    const documentRef = (action: AgentAction) => {
        const data = action.proposed_data ?? {};
        return data.resolved_ref ?? { library_id: data.library_id, library_ref: data.library_ref, zotero_key: data.attachment_key };
    };
    const documents = new Set(applied.map((action) => {
        const ref = documentRef(action);
        return ref?.zotero_key ? `${ref.library_ref ?? ref.library_id}-${ref.zotero_key}` : null;
    }).filter(Boolean));
    const attachment = documents.size === 1 ? lookupItem(documentRef(applied[0])) : null;
    const name = paperName(attachment);
    const what = plural(count, 'highlight');
    return {
        text: name ? `Beaver added ${what} to ${name}.` : `Beaver added ${what}.`,
        target: attachment ? { kind: 'open_item', ref: itemRef(attachment), label: 'Open PDF' } : null,
    };
}

function noteResult(actions: AgentAction[], source: FeatureCreditSource): FeatureCreditResult | null {
    const notes = actions.filter((action) => action.action_type === 'create_note');
    const action = notes.find((candidate) => candidate.id === source.action_id) ?? notes[0];
    if (!action) return null;
    const note = lookupItem({
        library_id: action.result_data?.library_id,
        library_ref: action.result_data?.library_ref,
        zotero_key: action.result_data?.zotero_key,
    });
    if (!note) return { text: 'Your note is saved in Zotero.', target: null };
    const parent = note.parentItem ? getDisplayNameFromItem(note.parentItem) : null;
    let where = 'in your library';
    if (parent) where = `under ${parent}`;
    else {
        const collectionID = note.getCollections()[0];
        const collection = collectionID ? Zotero.Collections.get(collectionID) : null;
        if (collection) where = `in ${collection.name}`;
    }
    return {
        text: `Your note is saved ${where}.`,
        target: { kind: 'open_item', ref: itemRef(note), label: 'Open note' },
        note: itemRef(note),
    };
}

function organizeResult(actions: AgentAction[]): FeatureCreditResult | null {
    const applied = actions.filter((action) => ORGANIZE_TYPES.has(action.action_type));
    if (applied.length === 0) return null;
    const items = new Set<string>();
    let first: ZoteroItemReference | null = null;
    const addItem = (ref: { library_id?: number; library_ref?: string; zotero_key?: string } | null) => {
        if (!ref?.zotero_key) return;
        const key = `${ref.library_ref ?? ref.library_id}-${ref.zotero_key}`;
        if (items.has(key)) return;
        items.add(key);
        if (!first) {
            const item = lookupItem(ref);
            if (item) first = itemRef(item);
        }
    };
    for (const action of applied) {
        const data = action.proposed_data ?? {};
        if (Array.isArray(data.item_ids)) {
            for (const id of data.item_ids) addItem(typeof id === 'string' ? parseItemReference(id) : null);
        }
        if (typeof data.zotero_key === 'string') {
            addItem({ library_id: data.library_id, library_ref: data.library_ref, zotero_key: data.zotero_key });
        }
    }
    const text = items.size > 0
        ? `Beaver organized ${plural(items.size, 'item')} in your library.`
        : `Beaver made ${plural(applied.length, 'change')} to your library.`;
    return {
        text,
        target: first ? { kind: 'reveal_item', ref: first, label: 'Show in library' } : null,
    };
}

function tableResult(source: FeatureCreditSource): FeatureCreditResult {
    const title = source.table_title?.trim();
    return {
        text: title ? `Your table "${title}" is filled.` : 'Your table is filled.',
        target: source.job_id ? { kind: 'open_table', jobId: source.job_id, label: 'Open table' } : null,
    };
}

/** The completion card's result line, or null when the run's changes are not available here. */
export function buildFeatureCreditResult(
    key: string,
    source: FeatureCreditSource | null,
    threadActions: AgentAction[],
): FeatureCreditResult | null {
    if (!source) return null;
    if (key === 'research_table') return tableResult(source);
    if (!source.run_id) return null;
    const actions = threadActions.filter((action) => action.run_id === source.run_id && action.status === 'applied');
    switch (key) {
        case 'annotate':
            return annotateResult(actions);
        case 'note':
            return noteResult(actions, source);
        case 'organize':
            return organizeResult(actions);
        default:
            return null;
    }
}
