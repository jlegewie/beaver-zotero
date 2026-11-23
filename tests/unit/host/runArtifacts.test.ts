import { describe, expect, it } from 'vitest';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import type { TableArtifact } from '@beaver/agent-core/run-state/tableResults';
import type { NoteEditSummary, ReviewRow } from '../../../react/host/zotero/components/reviewChangeRows';
import { buildEditedNoteArtifacts } from '../../../react/host/zotero/components/reviewChangeRows';
import {
    actionsInAnswerOrder,
    createdNoteCard,
    editedNoteCondition,
    groupArtifacts,
    groupCard,
    GROUP_THRESHOLD,
    inAnswerOrder,
    noteWordCount,
    toolCallOrder,
    type ArtifactEntry,
} from '../../../react/host/zotero/components/reviewChanges/runArtifacts';

function noteRow(action: Partial<AgentAction> = {}, toolcallId = 'call-1'): ReviewRow {
    return {
        runId: 'run-1',
        toolcallId,
        actionType: 'create_note',
        bulkApplicable: true,
        resolved: action.status !== 'pending',
        actions: [
            {
                id: `action-${toolcallId}`,
                run_id: 'run-1',
                toolcall_id: toolcallId,
                action_type: 'create_note',
                status: 'applied',
                proposed_data: { title: 'Summary of the evidence', content: '# Summary\n\nPolicing lowers *graduation* rates.' },
                result_data: { library_id: 1, library_ref: 'u', zotero_key: 'NOTE0001' },
                ...action,
            } as AgentAction,
        ],
    };
}

const created = (toolcallId: string, status: AgentAction['status'] = 'applied'): ArtifactEntry => ({
    kind: 'createdNote',
    key: toolcallId,
    row: noteRow({ status, ...(status === 'applied' ? {} : { result_data: undefined }) }, toolcallId),
});

describe('noteWordCount', () => {
    it('counts the words of Markdown or HTML, not its markup', () => {
        expect(noteWordCount('# Summary\n\nPolicing lowers *graduation* rates.')).toBe(5);
        expect(noteWordCount('<h1>Summary</h1><p>Two&nbsp;words</p>')).toBe(3);
        expect(noteWordCount('')).toBe(0);
        expect(noteWordCount(undefined)).toBe(0);
    });
});

describe('a created note card', () => {
    it('names the note, says what kind of note it is and how long, and opens', () => {
        expect(createdNoteCard(noteRow())).toEqual({
            headline: 'Summary of the evidence',
            condition: 'Note · 5 words',
            warning: null,
            move: 'open',
        });
    });

    it('calls a note written under a parent a child note, and trusts where it was written over the proposal', () => {
        const child = noteRow({ result_data: { library_id: 1, zotero_key: 'N', parent_key: 'PARENT01' } });
        expect(createdNoteCard(child).condition).toBe('Child note · 5 words');
        // Proposed under a parent, saved standalone.
        const standalone = noteRow({
            proposed_data: { title: 'T', content: 'One two', parent_item_id: 'u-PARENT01' },
            result_data: { library_id: 1, zotero_key: 'N' },
        });
        expect(createdNoteCard(standalone).condition).toBe('Note · 2 words');
        const proposal = noteRow({ status: 'pending', result_data: undefined, proposed_data: { title: 'T', content: 'x', parent_item_id: 'u-P' } });
        expect(createdNoteCard(proposal)).toMatchObject({ condition: 'Child note · waiting for approval', move: 'decide' });
    });

    it('says why a note is not in the library, and what can be done', () => {
        expect(createdNoteCard(noteRow({ status: 'rejected', result_data: undefined }))).toMatchObject({ condition: 'Not created', move: 'recreate' });
        expect(createdNoteCard(noteRow({ status: 'undone', result_data: undefined }))).toMatchObject({ condition: 'Deleted with Undo', move: 'recreate' });
        expect(createdNoteCard(noteRow({ status: 'error', result_data: undefined }))).toMatchObject({ warning: "Couldn't create the note", move: 'retry' });
        // An undo that failed leaves the note in place.
        expect(createdNoteCard(noteRow({ status: 'error' }))).toMatchObject({ warning: 'Undo did not finish', move: 'open' });
    });

    it('falls back to a placeholder title', () => {
        expect(createdNoteCard(noteRow({ proposed_data: { title: '  ', content: '' } })).headline).toBe('Untitled note');
    });
});

describe('an edited note card', () => {
    it('counts the changes in the library, and those still pending', () => {
        expect(editedNoteCondition({ appliedChanges: 3, pendingChanges: 0 })).toBe('Edited · 3 changes');
        expect(editedNoteCondition({ appliedChanges: 1, pendingChanges: 2 })).toBe('Edited · 1 change · 2 pending');
        expect(editedNoteCondition({ appliedChanges: 0, pendingChanges: 1 })).toBe('1 change waiting for approval');
    });
});

describe('grouping the artifacts of a run', () => {
    const table = (id: string, isCreated = true): ArtifactEntry => ({
        kind: 'table',
        key: id,
        row: { runId: 'run-1', toolcallId: id, recordRunId: 'run-1', created: isCreated, record: {} as TableArtifact['record'] },
    });

    it(`keeps fewer than ${GROUP_THRESHOLD} of a kind as their own cards`, () => {
        const entries = [created('a'), created('b'), created('c'), table('t')];
        expect(groupArtifacts(entries)).toEqual(entries);
    });

    it('folds a kind with many artifacts into one card, where its first one was', () => {
        const notes = ['a', 'b', 'c', 'd', 'e'].map((id) => created(id));
        const cards = groupArtifacts([table('t1'), ...notes, table('t2')]);
        expect(cards.map((card) => card.kind)).toEqual(['table', 'group', 'table']);
        expect(cards[1]).toMatchObject({ of: 'createdNote', entries: notes });
    });

    it('names a group of created notes by its first note when all were created, else by what became of them', () => {
        const notes = ['a', 'b', 'c', 'd', 'e'].map((id) => created(id));
        expect(groupCard('createdNote', notes)).toEqual({ headline: '5 notes', condition: 'Summary of the evidence and 4 more' });
        const mixed = [...notes.slice(0, 3), created('f', 'pending'), created('g', 'error')];
        expect(groupCard('createdNote', mixed)).toEqual({ headline: '5 notes', condition: '3 created · 1 waiting for approval · 1 failed' });
        const settled = [...notes.slice(0, 3), created('h', 'rejected'), created('i', 'undone')];
        expect(groupCard('createdNote', settled).condition).toBe('3 created · 1 not created · 1 deleted');
    });

    it('sums an edited group\'s changes, and counts a table group\'s made and edited tables', () => {
        const edited = (applied: number): ArtifactEntry => ({
            kind: 'editedNote',
            key: String(applied),
            summary: { appliedChanges: applied, pendingChanges: 0 } as NoteEditSummary,
        });
        expect(groupCard('editedNote', [edited(1), edited(2), edited(3), edited(4)])).toEqual({
            headline: '4 edited notes',
            condition: 'Edited · 10 changes',
        });
        const pending = (n: number): ArtifactEntry => ({
            kind: 'editedNote',
            key: `p${n}`,
            summary: { appliedChanges: 0, pendingChanges: n } as NoteEditSummary,
        });
        expect(groupCard('editedNote', [pending(1), pending(1), pending(2), pending(1)]).condition).toBe('5 changes waiting for approval');
        expect(groupCard('table', [table('a'), table('b', false), table('c', false), table('d')])).toEqual({
            headline: '4 tables',
            condition: '2 made · 2 edited',
        });
    });
});

describe('the order of the cards', () => {
    it('orders edited notes by their first edit in the answer, whatever order the store holds the edits in', () => {
        const call = (id: string) => ({ part_kind: 'tool-call', tool_call_id: id, tool_name: 'edit_note', args: {} });
        const order = toolCallOrder([{ id: 'run-1', model_messages: [{ kind: 'response', parts: [call('a1'), call('b1'), call('a2')] }] }] as never);
        const edit = (id: string, key: string) => ({
            id,
            run_id: 'run-1',
            toolcall_id: id,
            action_type: 'edit_note',
            status: 'applied',
            proposed_data: { library_ref: 'u', zotero_key: key },
            result_data: { library_ref: 'u', zotero_key: key },
        }) as unknown as AgentAction;
        const stored = [[edit('a2', 'NOTEA'), edit('b1', 'NOTEB'), edit('a1', 'NOTEA')]];
        const summaries = buildEditedNoteArtifacts(actionsInAnswerOrder(stored, order));
        expect(inAnswerOrder(summaries, order).map((summary) => summary.note.zotero_key)).toEqual(['NOTEA', 'NOTEB']);
        // Without the order, the store's first edit of A comes after B's.
        expect(inAnswerOrder(buildEditedNoteArtifacts(stored), order).map((summary) => summary.note.zotero_key)).toEqual(['NOTEB', 'NOTEA']);
    });

    it('follows the order the answer made its tool calls, across its runs', () => {
        const call = (id: string) => ({ part_kind: 'tool-call', tool_call_id: id, tool_name: 'create_note', args: {} });
        const order = toolCallOrder([
            { id: 'run-1', model_messages: [{ kind: 'response', parts: [call('a'), call('b')] }] },
            { id: 'run-2', model_messages: [{ kind: 'request', parts: [] }, { kind: 'response', parts: [call('c')] }] },
        ] as never);
        const items = [
            { runId: 'run-2', toolcallId: 'c' },
            { runId: 'run-1', toolcallId: 'zz' },
            { runId: 'run-1', toolcallId: 'b' },
            { runId: 'run-1', toolcallId: 'a' },
        ];
        expect(inAnswerOrder(items, order).map((item) => item.toolcallId)).toEqual(['a', 'b', 'c', 'zz']);
    });
});
