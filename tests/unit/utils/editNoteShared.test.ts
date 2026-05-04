import { describe, expect, it } from 'vitest';
import type { ToolCallPart } from '../../../react/agents/types';
import {
    buildEditNoteRenderItems,
    findPendingApprovalForToolcall,
    getEditNoteDisplayStatus,
    getEditNoteGroupExpansionKey,
    getEffectiveEditNotePendingApproval,
    getOverallEditNoteDisplayStatus,
    isEditNoteOrphaned,
    isEditNoteStreamingPlaceholder,
    parseEditNoteToolCallArgs,
    resolveEditNoteTargetFromData,
} from '../../../react/components/agentRuns/editNoteShared';

function makeToolCallPart(
    tool_call_id: string,
    tool_name: string,
    args: ToolCallPart['args'],
): ToolCallPart {
    return {
        part_kind: 'tool-call',
        tool_call_id,
        tool_name,
        args,
    };
}

describe('editNoteShared', () => {
    describe('resolveEditNoteTargetFromData', () => {
        it('resolves note_id targets', () => {
            expect(resolveEditNoteTargetFromData({ note_id: '5-ABCDE' })).toEqual({
                libraryId: 5,
                zoteroKey: 'ABCDE',
            });
        });

        it('resolves library_id/zotero_key targets', () => {
            expect(resolveEditNoteTargetFromData({
                library_id: '7',
                zotero_key: 'FGHIJ',
            })).toEqual({
                libraryId: 7,
                zoteroKey: 'FGHIJ',
            });
        });
    });

    describe('parseEditNoteToolCallArgs', () => {
        it('rejects arrays from object and JSON inputs', () => {
            expect(parseEditNoteToolCallArgs([])).toBeNull();
            expect(parseEditNoteToolCallArgs('[]')).toBeNull();
        });
    });

    describe('buildEditNoteRenderItems', () => {
        it('wraps a single edit_note in an edit-note-group container', () => {
            const items = buildEditNoteRenderItems([
                makeToolCallPart('tc-1', 'edit_note', { note_id: '1-AAAAA' }),
            ]);

            expect(items).toHaveLength(1);
            expect(items[0]).toEqual({
                kind: 'edit-note-group',
                parts: [makeToolCallPart('tc-1', 'edit_note', { note_id: '1-AAAAA' })],
                target: {
                    libraryId: 1,
                    zoteroKey: 'AAAAA',
                },
            });
        });

        it('keeps consecutive same-note edits together and splits on note changes', () => {
            const items = buildEditNoteRenderItems([
                makeToolCallPart('tc-1', 'edit_note', { note_id: '1-AAAAA' }),
                makeToolCallPart('tc-2', 'edit_note', { library_id: 1, zotero_key: 'AAAAA' }),
                makeToolCallPart('tc-3', 'edit_note', { note_id: '1-BBBBB' }),
            ]);

            expect(items).toHaveLength(2);
            expect(items[0]).toMatchObject({
                kind: 'edit-note-group',
                target: { libraryId: 1, zoteroKey: 'AAAAA' },
            });
            expect(items[1]).toMatchObject({
                kind: 'edit-note-group',
                target: { libraryId: 1, zoteroKey: 'BBBBB' },
            });
        });

        it('lets pending edit_note args extend a run until a target resolves', () => {
            const items = buildEditNoteRenderItems([
                makeToolCallPart('tc-1', 'edit_note', '{"note_id":"1-AAAAA"'),
                makeToolCallPart('tc-2', 'edit_note', { note_id: '1-AAAAA' }),
            ]);

            expect(items).toHaveLength(1);
            expect(items[0]).toMatchObject({
                kind: 'edit-note-group',
                target: { libraryId: 1, zoteroKey: 'AAAAA' },
            });
            expect(items[0].kind === 'edit-note-group' ? items[0].parts.map((part) => part.tool_call_id) : []).toEqual([
                'tc-1',
                'tc-2',
            ]);
        });

        it('uses streaming_args to split live edit_note groups once note ids are known', () => {
            const first = makeToolCallPart('tc-1', 'edit_note', '{"note_id":"1-AAAAA"');
            const second = makeToolCallPart('tc-2', 'edit_note', '{"note_id":"1-BBBBB"');
            first.streaming_args = { note_id: '1-AAAAA' };
            second.streaming_args = { note_id: '1-BBBBB' };

            const items = buildEditNoteRenderItems([first, second]);

            expect(items).toHaveLength(2);
            expect(items[0]).toMatchObject({
                kind: 'edit-note-group',
                target: { libraryId: 1, zoteroKey: 'AAAAA' },
            });
            expect(items[1]).toMatchObject({
                kind: 'edit-note-group',
                target: { libraryId: 1, zoteroKey: 'BBBBB' },
            });
        });

        it('flushes edit_note runs when a non-edit tool appears', () => {
            const items = buildEditNoteRenderItems([
                makeToolCallPart('tc-1', 'edit_note', { note_id: '1-AAAAA' }),
                makeToolCallPart('tc-2', 'read_note', { note_id: '1-AAAAA' }),
            ]);

            expect(items).toHaveLength(2);
            expect(items[0]).toMatchObject({ kind: 'edit-note-group' });
            expect(items[1]).toMatchObject({
                kind: 'single',
                part: expect.objectContaining({ tool_call_id: 'tc-2' }),
            });
        });

        it('preserves unresolved single edit_note runs as pending groups', () => {
            const items = buildEditNoteRenderItems([
                makeToolCallPart('tc-1', 'edit_note', '{"note_id":"1-AAAAA"'),
            ]);

            expect(items).toHaveLength(1);
            expect(items[0]).toEqual({
                kind: 'edit-note-group',
                parts: [makeToolCallPart('tc-1', 'edit_note', '{"note_id":"1-AAAAA"')],
                target: null,
            });
        });
    });

    describe('edit note status helpers', () => {
        it('finds pending approvals by tool call id and returns null on miss', () => {
            const approvals = [
                {
                    actionId: 'action-1',
                    toolcallId: 'tc-1',
                    actionType: 'edit_note',
                    actionData: { note_id: '1-AAAAA' },
                },
            ];

            expect(findPendingApprovalForToolcall('tc-1', approvals)).toEqual(approvals[0]);
            expect(findPendingApprovalForToolcall('tc-2', approvals)).toBeNull();
        });

        it('builds unique expansion keys for separate same-note segments', () => {
            expect(getEditNoteGroupExpansionKey('run-1', 0, [
                makeToolCallPart('tc-1', 'edit_note', { note_id: '1-AAAAA' }),
            ])).not.toBe(getEditNoteGroupExpansionKey('run-1', 0, [
                makeToolCallPart('tc-2', 'edit_note', { note_id: '1-AAAAA' }),
            ]));
        });

        it('covers awaiting and finalized display-status branches', () => {
            expect(getEditNoteDisplayStatus({
                action: null,
                pendingApproval: {
                    actionId: 'action-1',
                    toolcallId: 'tc-1',
                    actionType: 'edit_note',
                    actionData: {},
                },
                toolCallStatus: 'in_progress',
            })).toBe('awaiting');
            expect(getEditNoteDisplayStatus({
                action: { status: 'applied' },
                pendingApproval: null,
                toolCallStatus: 'completed',
            })).toBe('applied');
            expect(getEditNoteDisplayStatus({
                action: { status: 'rejected' },
                pendingApproval: null,
                toolCallStatus: 'completed',
            })).toBe('rejected');
            expect(getEditNoteDisplayStatus({
                action: { status: 'undone' },
                pendingApproval: null,
                toolCallStatus: 'completed',
            })).toBe('undone');
        });

        it('treats terminal tool failures without actions as errors', () => {
            expect(getEditNoteDisplayStatus({
                action: null,
                pendingApproval: null,
                toolCallStatus: 'error',
            })).toBe('error');
        });

        it('detects streaming placeholders and orphaned rows', () => {
            expect(isEditNoteStreamingPlaceholder({
                action: null,
                pendingApproval: null,
                toolCallStatus: 'in_progress',
            })).toBe(true);
            expect(isEditNoteOrphaned({
                action: null,
                pendingApproval: null,
                toolCallStatus: 'error',
            })).toBe(true);
        });

        it('suppresses reused pending approvals once a row action is final', () => {
            const pendingApproval = {
                actionId: 'action-2',
                toolcallId: 'tc-1',
                actionType: 'edit_note',
                actionData: { note_id: '1-AAAAA' },
            };

            expect(getEffectiveEditNotePendingApproval(
                { status: 'applied' },
                pendingApproval,
            )).toBeNull();
        });

        it('aggregates row-level tool failures as group errors', () => {
            expect(getOverallEditNoteDisplayStatus([])).toBe('pending');
            expect(getOverallEditNoteDisplayStatus(['error'])).toBe('error');
            expect(getOverallEditNoteDisplayStatus(['applied', 'error'])).toBe('applied');
        });
    });
});
