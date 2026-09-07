import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCallPart } from '@beaver/agent-core/agents/types';
import {
    buildEditNoteRenderItems,
    findPendingApprovalForToolcall,
    getEditNoteDisplayStatus,
    getEditNoteGroupExpansionKey,
    getEffectiveEditNotePendingApproval,
    getOverallEditNoteDisplayStatus,
    isEditNoteOrphaned,
    isEditNoteStreamingPlaceholder,
    isOpenableEditNoteTarget,
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

        it('resolves a portable "u-<key>" note_id to the local personal library', () => {
            const original = (globalThis as any).Zotero.Libraries;
            (globalThis as any).Zotero.Libraries = { ...original, userLibraryID: 5 };
            try {
                expect(resolveEditNoteTargetFromData({ note_id: 'u-ABCDE' })).toEqual({
                    libraryId: 5,
                    zoteroKey: 'ABCDE',
                    libraryRef: 'u',
                });
            } finally {
                (globalThis as any).Zotero.Libraries = original;
            }
        });

        it('resolves a portable "g<groupID>-<key>" note_id via the local group registry', () => {
            const originalLibraries = (globalThis as any).Zotero.Libraries;
            const originalGroups = (globalThis as any).Zotero.Groups;
            (globalThis as any).Zotero.Libraries = { ...originalLibraries, userLibraryID: 5 };
            (globalThis as any).Zotero.Groups = {
                getLibraryIDFromGroupID: (groupID: number) => (groupID === 42 ? 12 : null),
            };
            try {
                expect(resolveEditNoteTargetFromData({ note_id: 'g42-FGHIJ' })).toEqual({
                    libraryId: 12,
                    zoteroKey: 'FGHIJ',
                    libraryRef: 'g42',
                });
            } finally {
                (globalThis as any).Zotero.Libraries = originalLibraries;
                (globalThis as any).Zotero.Groups = originalGroups;
            }
        });

        // Action data (unlike the model's own tool args) names the note as a
        // `library_ref` + `zotero_key` pair. Once the backend stops pinning
        // rowids the numeric half is absent or the unresolved sentinel, so the
        // ref is the only thing that identifies the note.
        describe('library_ref + zotero_key targets', () => {
            const originals: any = {};

            beforeEach(() => {
                originals.Libraries = (globalThis as any).Zotero.Libraries;
                originals.Groups = (globalThis as any).Zotero.Groups;
                (globalThis as any).Zotero.Libraries = { ...originals.Libraries, userLibraryID: 5 };
                (globalThis as any).Zotero.Groups = {
                    getLibraryIDFromGroupID: (groupID: number) => (groupID === 42 ? 12 : null),
                };
            });

            afterEach(() => {
                (globalThis as any).Zotero.Libraries = originals.Libraries;
                (globalThis as any).Zotero.Groups = originals.Groups;
            });

            it('resolves a library_ref with no numeric library_id', () => {
                expect(resolveEditNoteTargetFromData({ library_ref: 'g42', zotero_key: 'FGHIJ' })).toEqual({
                    libraryId: 12,
                    zoteroKey: 'FGHIJ',
                    libraryRef: 'g42',
                });
            });

            it('resolves a library_ref carrying the unresolved sentinel', () => {
                expect(resolveEditNoteTargetFromData({
                    library_ref: 'u',
                    library_id: 0,
                    zotero_key: 'FGHIJ',
                })).toEqual({ libraryId: 5, zoteroKey: 'FGHIJ', libraryRef: 'u' });
            });

            it('lets library_ref win over a disagreeing numeric library_id', () => {
                expect(resolveEditNoteTargetFromData({
                    library_ref: 'g42',
                    library_id: 7,
                    zotero_key: 'FGHIJ',
                })).toEqual({ libraryId: 12, zoteroKey: 'FGHIJ', libraryRef: 'g42' });
            });

            it('keeps the identity of a note whose library is not on this device', () => {
                // Dropping the target would make `buildEditNoteRenderItems` read
                // the part as "still streaming" and fold this note's edits into
                // the neighbouring note's group. Same shape the note_id branch
                // produces for an unavailable group.
                expect(resolveEditNoteTargetFromData({
                    library_ref: 'g999999',
                    zotero_key: 'FGHIJ',
                })).toEqual({ libraryId: 0, zoteroKey: 'FGHIJ', libraryRef: 'g999999' });
                expect(resolveEditNoteTargetFromData({ note_id: 'g999999-FGHIJ' }))
                    .toEqual({ libraryId: 0, zoteroKey: 'FGHIJ', libraryRef: 'g999999' });
            });

            it('marks such a target as not openable, so no affordance is offered for it', () => {
                expect(isOpenableEditNoteTarget(
                    resolveEditNoteTargetFromData({ library_ref: 'g999999', zotero_key: 'FGHIJ' }),
                )).toBe(false);
                expect(isOpenableEditNoteTarget(
                    resolveEditNoteTargetFromData({ note_id: 'g999999-FGHIJ' }),
                )).toBe(false);
                expect(isOpenableEditNoteTarget(
                    resolveEditNoteTargetFromData({ library_ref: 'g42', zotero_key: 'FGHIJ' }),
                )).toBe(true);
                expect(isOpenableEditNoteTarget(null)).toBe(false);
            });

            it('carries the portable ref on the target so unavailable libraries stay distinct', () => {
                expect(resolveEditNoteTargetFromData({ note_id: 'g999999-AAAAA' }))
                    .toEqual({ libraryId: 0, zoteroKey: 'AAAAA', libraryRef: 'g999999' });
                expect(resolveEditNoteTargetFromData({ library_ref: 'g999999', zotero_key: 'AAAAA' }))
                    .toEqual({ libraryId: 0, zoteroKey: 'AAAAA', libraryRef: 'g999999' });
            });

            it('keeps edits to different notes in separate groups when neither library is here', () => {
                const items = buildEditNoteRenderItems([
                    makeToolCallPart('tc-1', 'edit_note', { note_id: 'g999999-AAAAA' }),
                    makeToolCallPart('tc-2', 'edit_note', { note_id: 'g888888-BBBBB' }),
                ]);
                expect(items).toHaveLength(2);
                expect(items.every((item) => item.kind === 'edit-note-group')).toBe(true);
            });

            it('does not merge two unavailable libraries that share a zotero_key', () => {
                // Zotero keys are unique only within a library, and every
                // unavailable library reports the same rowid sentinel — so the
                // portable ref is the only thing separating these two notes.
                const items = buildEditNoteRenderItems([
                    makeToolCallPart('tc-1', 'edit_note', { note_id: 'g999999-AAAAA' }),
                    makeToolCallPart('tc-2', 'edit_note', { note_id: 'g888888-AAAAA' }),
                ]);
                expect(items).toHaveLength(2);
            });

            it('still groups consecutive edits to one note named both ways', () => {
                // `u-KEY` and a bare `library_id: 5` name the same resolvable
                // library here, so the run must not be split on the spelling.
                const items = buildEditNoteRenderItems([
                    makeToolCallPart('tc-1', 'edit_note', { note_id: 'u-AAAAA' }),
                    makeToolCallPart('tc-2', 'edit_note', { library_id: 5, zotero_key: 'AAAAA' }),
                ]);
                expect(items).toHaveLength(1);
                expect((items[0] as any).parts).toHaveLength(2);
            });

            it('returns null when nothing names a library', () => {
                expect(resolveEditNoteTargetFromData({ zotero_key: 'FGHIJ' })).toBeNull();
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
