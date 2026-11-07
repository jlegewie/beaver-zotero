/**
 * What the end-of-run artifact cards say: one shape for notes and tables
 * (a headline, a condition line, a marked tail), and the groups that fold
 * many artifacts of one kind into a single card.
 *
 * Pure, so the cards and the list stay thin and the wording is tested here.
 */

import { isUnconfirmedAction, type AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { TableArtifact } from '@beaver/agent-core/run-state/tableResults';
import type { NoteEditSummary, ReviewRow } from '../reviewChangeRows';
import { unconfirmedCaption } from '../agentActionViewHelpers';

function count(n: number, one: string, many = `${one}s`): string {
    return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** Words in a note's text, Markdown or HTML: tags and markup are not words. */
export function noteWordCount(content: string | null | undefined): number {
    if (!content) return 0;
    const text = content
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-z#0-9]+;/gi, ' ')
        .replace(/[#*_`>[\]()|~-]+/g, ' ');
    return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** What a created note's card can do next. */
export type CreatedNoteMove =
    /** The note is in the library: open it, export it. */
    | 'open'
    /** A proposal nobody decided: create it or reject it. */
    | 'decide'
    /** Rejected or undone: it can be created again. */
    | 'recreate'
    /** Creating it failed: try again. */
    | 'retry'
    /** Nothing to offer (Zotero did not report the outcome). */
    | 'none';

export interface CreatedNoteCard {
    headline: string;
    condition: string;
    warning: string | null;
    move: CreatedNoteMove;
}

/**
 * A `create_note` row as its card shows it. Line two says what kind of note
 * it is and how long, or, when the note is not in the library, why not.
 */
export function createdNoteCard(row: ReviewRow): CreatedNoteCard {
    const action: AgentAction = row.actions[0];
    const data = (action.proposed_data ?? {}) as { title?: string; content?: string; parent_item_id?: string | null };
    const result = action.result_data as { parent_key?: string } | undefined;
    const headline = data.title?.trim() || 'Untitled note';
    const words = noteWordCount(data.content);
    // Where it was written decides; a proposal for a parent can end standalone
    // (a parent that cannot hold notes). Without a result, the proposal says.
    const child = action.result_data != null ? !!result?.parent_key : !!data.parent_item_id;
    const kind = child ? 'Child note' : 'Note';
    const described = words > 0 ? `${kind} · ${count(words, 'word')}` : kind;

    switch (action.status) {
        case 'applied':
            return { headline, condition: described, warning: null, move: 'open' };
        case 'pending':
            return { headline, condition: `${kind} · waiting for approval`, warning: null, move: 'decide' };
        case 'rejected':
            return { headline, condition: 'Not created', warning: null, move: 'recreate' };
        case 'undone':
            return { headline, condition: 'Deleted with Undo', warning: null, move: 'recreate' };
        case 'error': {
            if (isUnconfirmedAction(action))
                return { headline, condition: '', warning: unconfirmedCaption(row.actions), move: 'none' };
            // An action whose undo failed keeps its result: the note is still there.
            if (action.result_data != null)
                return { headline, condition: described, warning: 'Undo did not finish', move: 'open' };
            return { headline, condition: '', warning: "Couldn't create the note", move: 'retry' };
        }
        default:
            return { headline, condition: described, warning: null, move: 'none' };
    }
}

/** An edited note's condition: "Edited · 3 changes", with any still pending. */
export function editedNoteCondition(summary: Pick<NoteEditSummary, 'appliedChanges' | 'pendingChanges'>): string {
    const { appliedChanges: applied, pendingChanges: pending } = summary;
    if (applied === 0) return `${count(pending, 'change')} waiting for approval`;
    return pending > 0
        ? `Edited · ${count(applied, 'change')} · ${pending.toLocaleString('en-US')} pending`
        : `Edited · ${count(applied, 'change')}`;
}

/** The end-of-run artifacts, one entry per card. */
export type ArtifactEntry =
    | { kind: 'createdNote'; key: string; row: ReviewRow }
    | { kind: 'editedNote'; key: string; summary: NoteEditSummary }
    | { kind: 'table'; key: string; row: TableArtifact };

/**
 * Each tool call's place in an answer, keyed `${runId}:${toolCallId}`: the
 * order the answer made its artifacts in. Actions can reach the store in
 * another order.
 */
export function toolCallOrder(runs: ReadonlyArray<Pick<AgentRun, 'id' | 'model_messages'>>): Map<string, number> {
    const order = new Map<string, number>();
    for (const run of runs) {
        for (const message of run.model_messages ?? []) {
            if (message.kind !== 'response') continue;
            for (const part of message.parts) {
                if (part.part_kind === 'tool-call') order.set(`${run.id}:${part.tool_call_id}`, order.size);
            }
        }
    }
    return order;
}

/** Artifacts in the order the answer made them; one whose call is not found keeps its place after the others. */
export function inAnswerOrder<T extends { runId: string; toolcallId: string }>(items: T[], order: ReadonlyMap<string, number>): T[] {
    const position = (item: T) => order.get(`${item.runId}:${item.toolcallId}`) ?? Number.MAX_SAFE_INTEGER;
    return [...items].sort((a, b) => position(a) - position(b));
}

/** Each run's actions in the answer's tool-call order; actions not found keep their place after the others. */
export function actionsInAnswerOrder(actionsByRun: AgentAction[][], order: ReadonlyMap<string, number>): AgentAction[][] {
    return actionsByRun.map((actions) =>
        inAnswerOrder(
            actions.map((action) => ({ action, runId: action.run_id, toolcallId: action.toolcall_id ?? action.id })),
            order,
        ).map(({ action }) => action),
    );
}

/** A kind with this many artifacts or more folds into one group card. */
export const GROUP_THRESHOLD = 4;

export type ArtifactCardEntry =
    | ArtifactEntry
    | { kind: 'group'; key: string; of: ArtifactEntry['kind']; entries: ArtifactEntry[] };

/**
 * The cards of an answer's artifacts: each kind keeps its place in the
 * order, and a kind with {@link GROUP_THRESHOLD} artifacts or more becomes
 * one group card in place of its first, so a run that wrote thirty notes
 * reads as one card.
 */
export function groupArtifacts(entries: ArtifactEntry[]): ArtifactCardEntry[] {
    const byKind = new Map<ArtifactEntry['kind'], ArtifactEntry[]>();
    for (const entry of entries) {
        const same = byKind.get(entry.kind);
        if (same) same.push(entry);
        else byKind.set(entry.kind, [entry]);
    }
    const cards: ArtifactCardEntry[] = [];
    for (const entry of entries) {
        const same = byKind.get(entry.kind)!;
        if (same.length < GROUP_THRESHOLD) cards.push(entry);
        else if (same[0] === entry) cards.push({ kind: 'group', key: `group:${entry.kind}`, of: entry.kind, entries: same });
    }
    return cards;
}

/** A group card's two lines. */
export function groupCard(of: ArtifactEntry['kind'], entries: ArtifactEntry[]): { headline: string; condition: string } {
    if (of === 'createdNote') {
        const statuses = entries.map((entry) => (entry.kind === 'createdNote' ? entry.row.actions[0].status : null));
        const created = statuses.filter((status) => status === 'applied').length;
        const waiting = statuses.filter((status) => status === 'pending').length;
        const failed = statuses.filter((status) => status === 'error').length;
        const rejected = statuses.filter((status) => status === 'rejected').length;
        const undone = statuses.filter((status) => status === 'undone').length;
        const parts = [
            created ? `${created.toLocaleString('en-US')} created` : null,
            waiting ? `${waiting.toLocaleString('en-US')} waiting for approval` : null,
            failed ? `${failed.toLocaleString('en-US')} failed` : null,
            rejected ? `${rejected.toLocaleString('en-US')} not created` : null,
            undone ? `${undone.toLocaleString('en-US')} deleted` : null,
        ].filter(Boolean);
        // Nothing to report: say what the notes are.
        if (created === entries.length) {
            const first = entries[0].kind === 'createdNote' ? createdNoteCard(entries[0].row).headline : '';
            return { headline: count(entries.length, 'note'), condition: `${first} and ${(entries.length - 1).toLocaleString('en-US')} more` };
        }
        return { headline: count(entries.length, 'note'), condition: parts.join(' · ') || 'None created' };
    }
    if (of === 'editedNote') {
        const totals = { appliedChanges: 0, pendingChanges: 0 };
        for (const entry of entries) {
            if (entry.kind !== 'editedNote') continue;
            totals.appliedChanges += entry.summary.appliedChanges;
            totals.pendingChanges += entry.summary.pendingChanges;
        }
        return { headline: count(entries.length, 'edited note'), condition: editedNoteCondition(totals) };
    }
    const made = entries.filter((entry) => entry.kind === 'table' && entry.row.created).length;
    const edited = entries.length - made;
    const parts = [made ? `${made.toLocaleString('en-US')} made` : null, edited ? `${edited.toLocaleString('en-US')} edited` : null];
    return { headline: count(entries.length, 'table'), condition: parts.filter(Boolean).join(' · ') };
}
