import { beforeEach, describe, expect, it, vi } from 'vitest';

// `toAgentAction` transitively imports the Supabase client and Zotero-aware
// profile atoms, which require live globals at import time. Stub the leaf
// modules before the SUT is loaded so unit tests can run cold.
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemDataWithAllTypes: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));
const checkLibraryExcluded = vi.hoisted(() => vi.fn(() => null as { message: string } | null));
vi.mock('../../../src/services/agentDataProvider/utils', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    checkLibraryExcluded,
}));

import type { AgentAction } from '../../../react/agents/agentActions';
import { toAgentAction, validateAppliedAgentAction } from '../../../react/agents/agentActions';
import { getAppliedPdfAnnotationCount } from '../../../react/agents/agentActionCounts';
import type {
    CreateHighlightAnnotationsProposedData,
    CreateNoteAnnotationsProposedData,
} from '@beaver/agent-core/types/agentActions/createAnnotations';
import type { CreateItemProposedData } from '@beaver/agent-core/types/agentActions/items';

describe('validateAppliedAgentAction', () => {
    const zotero = (globalThis as any).Zotero;
    const getByLibraryAndKeyAsync = vi.fn();

    const appliedAction = (library_id: number, overrides: Partial<AgentAction> = {}): AgentAction => ({
        id: 'action-1',
        run_id: 'run-1',
        action_type: 'edit_metadata',
        status: 'applied',
        proposed_data: {},
        result_data: { library_id, zotero_key: 'AAAAAAA1' },
        ...overrides,
    } as AgentAction);

    beforeEach(() => {
        getByLibraryAndKeyAsync.mockReset();
        checkLibraryExcluded.mockReturnValue(null);
        zotero.Items = { ...zotero.Items, getByLibraryAndKeyAsync };
        zotero.Libraries = { ...zotero.Libraries, userLibraryID: 1 };
        zotero.Groups = {
            ...zotero.Groups,
            getLibraryIDFromGroupID: vi.fn((groupID: number) => groupID === 50 ? 5 : null),
        };
    });

    it('returns valid when the applied item resolves', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue({ isAnnotation: () => false });
        expect(await validateAppliedAgentAction(appliedAction(1))).toBe('valid');
    });

    it('returns valid for actions without an applied Zotero item', async () => {
        const action = appliedAction(1, { status: 'pending' });
        expect(await validateAppliedAgentAction(action)).toBe('valid');
        expect(getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('returns invalid when a personal-library item is gone', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue(null);
        expect(await validateAppliedAgentAction(appliedAction(1))).toBe('invalid');
    });

    it('returns invalid when a resolved group-library item is gone', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue(null);
        expect(await validateAppliedAgentAction(appliedAction(5, {
            result_data: { library_id: 99, library_ref: 'g50', zotero_key: 'AAAAAAA1' },
        }))).toBe('invalid');
        expect(getByLibraryAndKeyAsync).toHaveBeenCalledWith(5, 'AAAAAAA1');
    });

    it('returns unverifiable when a group library is unavailable on this device', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue(null);
        expect(await validateAppliedAgentAction(appliedAction(5, {
            result_data: { library_id: 5, library_ref: 'g999', zotero_key: 'AAAAAAA1' },
        }))).toBe('unverifiable');
        expect(getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('returns valid when a group-library item resolves', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue({ isAnnotation: () => false });
        expect(await validateAppliedAgentAction(appliedAction(5))).toBe('valid');
    });

    it('returns unverifiable when a legacy group-library item (no library_ref) is not found', async () => {
        // A device-local group library_id is not a portable identity: a miss
        // may just mean that id maps to a different group here, so it must not
        // be treated as a revert. This covers all data written before library_ref.
        getByLibraryAndKeyAsync.mockResolvedValue(null);
        expect(await validateAppliedAgentAction(appliedAction(5))).toBe('unverifiable');
        expect(getByLibraryAndKeyAsync).toHaveBeenCalledWith(5, 'AAAAAAA1');
    });

    it('returns unverifiable without reading an excluded library', async () => {
        // Validation can flip an action to "undone" on the backend, so it must
        // not resolve items in a library the user excluded after the run.
        checkLibraryExcluded.mockReturnValue({ message: 'excluded' });
        const action = appliedAction(1, {
            action_type: 'edit_annotations',
            result_data: {
                operation: 'edit',
                applied_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u' }],
            },
        } as Partial<AgentAction>);
        expect(await validateAppliedAgentAction(action)).toBe('unverifiable');
        expect(getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('returns invalid when an annotation action resolves to a non-annotation', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue({ isAnnotation: () => false });
        const action = appliedAction(1, { action_type: 'highlight_annotation' } as Partial<AgentAction>);
        expect(await validateAppliedAgentAction(action)).toBe('invalid');
    });

    it('returns unverifiable for bulk annotations in an unavailable group library', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue(null);
        const action = appliedAction(5, {
            action_type: 'create_highlight_annotations',
            result_data: {
                created: [
                    { library_id: 5, library_ref: 'g999', zotero_key: 'AAAAAAA1' },
                    { library_id: 5, library_ref: 'g999', zotero_key: 'AAAAAAA2' },
                ],
            },
        } as Partial<AgentAction>);
        expect(await validateAppliedAgentAction(action)).toBe('unverifiable');
    });

    it('returns valid for a deleted-annotation action while the annotations are still trashed', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue({ isAnnotation: () => true, deleted: true });
        const action = appliedAction(1, {
            action_type: 'edit_annotations',
            result_data: {
                operation: 'delete',
                applied_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1' }],
            },
        } as Partial<AgentAction>);
        expect(await validateAppliedAgentAction(action)).toBe('valid');
    });

    it('returns invalid when a deleted annotation was restored from the trash', async () => {
        // A soft-deleted annotation always resolves, so existence proves nothing:
        // restoring it from the trash is the user reverting the delete.
        getByLibraryAndKeyAsync.mockResolvedValue({ isAnnotation: () => true, deleted: false });
        const action = appliedAction(1, {
            action_type: 'edit_annotations',
            result_data: {
                operation: 'delete',
                applied_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1' }],
            },
        } as Partial<AgentAction>);
        expect(await validateAppliedAgentAction(action)).toBe('invalid');
    });

    it('does not require the trash state for non-delete annotation edits', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue({ isAnnotation: () => true, deleted: false });
        const action = appliedAction(1, {
            action_type: 'edit_annotations',
            result_data: {
                operation: 'edit',
                applied_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1' }],
            },
        } as Partial<AgentAction>);
        expect(await validateAppliedAgentAction(action)).toBe('valid');
    });

    it('returns invalid for bulk annotations when a personal-library annotation is gone', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue(null);
        const action = appliedAction(1, {
            action_type: 'create_highlight_annotations',
            result_data: {
                created: [{ library_id: 1, zotero_key: 'AAAAAAA1' }],
            },
        } as Partial<AgentAction>);
        expect(await validateAppliedAgentAction(action)).toBe('invalid');
    });
});

describe('getAppliedPdfAnnotationCount', () => {
    it('counts unique logical annotations for bulk annotation actions', () => {
        const action = {
            id: 'action-1',
            run_id: 'run-1',
            action_type: 'create_highlight_annotations',
            status: 'applied',
            proposed_data: { items: [] },
            result_data: {
                created: [
                    {
                        library_id: 1,
                        zotero_key: 'AAAAAAA1',
                        client_item_id: 'item-1',
                        index: 0,
                        loc_raw: '1',
                    },
                    {
                        library_id: 1,
                        zotero_key: 'AAAAAAA2',
                        client_item_id: 'item-1',
                        index: 0,
                        loc_raw: '1',
                    },
                    {
                        library_id: 1,
                        zotero_key: 'AAAAAAA3',
                        client_item_id: 'item-2',
                        index: 1,
                        loc_raw: '2',
                    },
                ],
                failed: [],
                total_created: 3,
                total_failed: 0,
            },
        } as AgentAction;

        expect(getAppliedPdfAnnotationCount(action)).toBe(2);
    });

    it('counts legacy single annotation actions as one', () => {
        const action = {
            id: 'action-1',
            run_id: 'run-1',
            action_type: 'highlight_annotation',
            status: 'applied',
            proposed_data: {},
            result_data: {
                library_id: 1,
                zotero_key: 'AAAAAAA1',
                attachment_key: 'BBBBBBB1',
            },
        } as AgentAction;

        expect(getAppliedPdfAnnotationCount(action)).toBe(1);
    });
});

describe('toAgentAction create_item normalization', () => {
    it('parses a string library_id into a numeric library_id', () => {
        const action = toAgentAction({
            action_type: 'create_item',
            proposed_data: {
                library_id: '42',
                item: { title: 'Imported item' },
                file_available: false,
            },
        });

        const data = action.proposed_data as CreateItemProposedData;
        expect(data.library_id).toBe(42);
    });

    it('parses a camelCase string libraryId into a numeric library_id', () => {
        const action = toAgentAction({
            action_type: 'create_item',
            proposed_data: {
                libraryId: '43',
                item: { title: 'Imported item' },
                fileAvailable: true,
            },
        });

        const data = action.proposed_data as CreateItemProposedData;
        expect(data.library_id).toBe(43);
    });
});

describe('toAgentAction reading_order_offset plumbing', () => {
    it('preserves reading_order_offset on bulk highlight page_locations', () => {
        const action = toAgentAction({
            id: 'a',
            run_id: 'r',
            action_type: 'create_highlight_annotations',
            status: 'pending',
            proposed_data: {
                requested_ref: { library_id: 1, zotero_key: 'P' },
                resolved_ref: { library_id: 1, zotero_key: 'P' },
                items: [
                    {
                        index: 0,
                        client_item_id: 'c1',
                        title: '',
                        loc_raw: 's4',
                        loc: { kind: 'sentence', value: '4', raw: 's4' },
                        text: 'hi',
                        color: 'yellow',
                        page_locations: [
                            { page_idx: 6, boxes: [], reading_order_offset: 7 },
                        ],
                    },
                ],
            },
        });
        const data = action.proposed_data as CreateHighlightAnnotationsProposedData;
        expect(data.items[0]?.page_locations?.[0]?.reading_order_offset).toBe(7);
    });

    it('accepts camelCase readingOrderOffset on the wire for highlights', () => {
        const action = toAgentAction({
            action_type: 'create_highlight_annotations',
            proposed_data: {
                items: [
                    {
                        index: 0,
                        client_item_id: 'c1',
                        loc_raw: 's4',
                        loc: { kind: 'sentence', value: '4', raw: 's4' },
                        text: 'hi',
                        color: 'yellow',
                        page_locations: [
                            { page_idx: 0, boxes: [], readingOrderOffset: 3 },
                        ],
                    },
                ],
            },
        });
        const data = action.proposed_data as CreateHighlightAnnotationsProposedData;
        expect(data.items[0]?.page_locations?.[0]?.reading_order_offset).toBe(3);
    });

    it('preserves reading_order_offset on bulk note items', () => {
        const action = toAgentAction({
            id: 'a',
            run_id: 'r',
            action_type: 'create_note_annotations',
            status: 'pending',
            proposed_data: {
                requested_ref: { library_id: 1, zotero_key: 'P' },
                resolved_ref: { library_id: 1, zotero_key: 'P' },
                items: [
                    {
                        index: 0,
                        client_item_id: 'c1',
                        title: '',
                        loc_raw: 's4',
                        loc: { kind: 'sentence', value: '4', raw: 's4' },
                        comment: 'hi',
                        note_position: { page_index: 6, side: 'right', x: 400, y: 200 },
                        reading_order_offset: 11,
                    },
                ],
            },
        });
        const data = action.proposed_data as CreateNoteAnnotationsProposedData;
        expect(data.items[0].reading_order_offset).toBe(11);
    });

    it('preserves color on bulk note items', () => {
        const action = toAgentAction({
            id: 'a',
            run_id: 'r',
            action_type: 'create_note_annotations',
            status: 'pending',
            proposed_data: {
                requested_ref: { library_id: 1, zotero_key: 'P' },
                resolved_ref: { library_id: 1, zotero_key: 'P' },
                items: [
                    {
                        index: 0,
                        client_item_id: 'c1',
                        title: '',
                        loc_raw: 's4',
                        loc: { kind: 'sentence', value: '4', raw: 's4' },
                        comment: 'hi',
                        color: 'blue',
                        note_position: { page_index: 6, side: 'right', x: 400, y: 200 },
                    },
                ],
            },
        });
        const data = action.proposed_data as CreateNoteAnnotationsProposedData;
        expect(data.items[0].color).toBe('blue');
    });

    it('accepts camelCase readingOrderOffset on the wire for notes', () => {
        const action = toAgentAction({
            action_type: 'create_note_annotations',
            proposed_data: {
                items: [
                    {
                        index: 0,
                        client_item_id: 'c1',
                        loc_raw: 's4',
                        loc: { kind: 'sentence', value: '4', raw: 's4' },
                        comment: 'hi',
                        note_position: { page_index: 0, side: 'left', x: 12, y: 100 },
                        readingOrderOffset: 4,
                    },
                ],
            },
        });
        const data = action.proposed_data as CreateNoteAnnotationsProposedData;
        expect(data.items[0].reading_order_offset).toBe(4);
    });

    it('preserves EPUB locator fields for manual-apply bulk annotations', () => {
        const highlightAction = toAgentAction({
            action_type: 'create_highlight_annotations',
            proposed_data: {
                items: [
                    {
                        index: 0,
                        client_item_id: 'h1',
                        loc_raw: 's4',
                        loc: { kind: 'sentence', value: '4', raw: 's4' },
                        text: 'Highlighted text.',
                        color: 'yellow',
                        page_label: '191',
                        section_href: 'OEBPS/ch1.xhtml',
                        section_ordinal: 18,
                        anchor_id: 'para-4',
                    },
                ],
            },
        });
        const highlightData = highlightAction.proposed_data as CreateHighlightAnnotationsProposedData;
        expect(highlightData.items[0]).toMatchObject({
            text: 'Highlighted text.',
            page_label: '191',
            section_href: 'OEBPS/ch1.xhtml',
            section_ordinal: 18,
            anchor_id: 'para-4',
        });

        const noteAction = toAgentAction({
            action_type: 'create_note_annotations',
            proposed_data: {
                items: [
                    {
                        index: 0,
                        client_item_id: 'n1',
                        loc_raw: 'p2',
                        loc: { kind: 'paragraph', value: '2', raw: 'p2' },
                        comment: 'Note.',
                        text: 'Anchor text.',
                        page_label: '192',
                        sectionHref: 'OEBPS/ch2.xhtml',
                        sectionOrdinal: 19,
                        anchorId: 'para-5',
                    },
                ],
            },
        });
        const noteData = noteAction.proposed_data as CreateNoteAnnotationsProposedData;
        expect(noteData.items[0]).toMatchObject({
            text: 'Anchor text.',
            page_label: '192',
            section_href: 'OEBPS/ch2.xhtml',
            section_ordinal: 19,
            anchor_id: 'para-5',
        });
    });
});

describe('toAgentAction created-annotation page plumbing', () => {
    const createdAction = (created: Record<string, unknown>[]) =>
        toAgentAction({
            id: 'a',
            run_id: 'r',
            action_type: 'create_highlight_annotations',
            status: 'applied',
            proposed_data: { items: [] },
            result_data: { created, failed: [] },
        });

    it('preserves page_idx and page_label on created annotations', () => {
        // Rows of a page-spanning highlight are otherwise identical, so losing
        // the page here would make them indistinguishable after a thread reload.
        const action = createdAction([
            { library_id: 1, zotero_key: 'AAAAAAA1', client_item_id: 'c1', index: 0, loc_raw: 's4-s9', page_idx: 0, page_label: '7' },
            { library_id: 1, zotero_key: 'AAAAAAA2', client_item_id: 'c1', index: 0, loc_raw: 's4-s9', page_idx: 1, page_label: '8' },
        ]);

        const created = (action.result_data as any).created;
        expect(created.map((c: any) => c.page_idx)).toEqual([0, 1]);
        expect(created.map((c: any) => c.page_label)).toEqual(['7', '8']);
    });

    it('accepts camelCase pageIdx / pageLabel on the wire', () => {
        const action = createdAction([
            { libraryId: 1, zoteroKey: 'AAAAAAA1', clientItemId: 'c1', index: 0, locRaw: 's4', pageIdx: 3, pageLabel: 'iv' },
        ]);

        const created = (action.result_data as any).created;
        expect(created[0].page_idx).toBe(3);
        expect(created[0].page_label).toBe('iv');
    });

    it('leaves both fields absent on rows created before they existed', () => {
        const action = createdAction([
            { library_id: 1, zotero_key: 'AAAAAAA1', client_item_id: 'c1', index: 0, loc_raw: 's4' },
        ]);

        const created = (action.result_data as any).created;
        expect('page_idx' in created[0]).toBe(false);
        expect('page_label' in created[0]).toBe(false);
    });
});

describe('toAgentAction edit_annotations normalized contract', () => {
    it('preserves per-group edits and the applied/before pairing', () => {
        const action = toAgentAction({
            id: 'edit-annotations-1', run_id: 'run-1', action_type: 'edit_annotations', status: 'applied',
            proposed_data: {
                operation: 'edit',
                edits: [
                    {
                        annotation_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u' }],
                        changes: { color: 'blue', add_tags: ['topic'] },
                    },
                    {
                        annotation_refs: [{ library_id: 1, zotero_key: 'BBBBBBB2', library_ref: 'u' }],
                        changes: { comment: '' },
                    },
                ],
                skipped: [{ annotation_id: '1-CCCCCCC3', reason: 'annotation was not found' }],
            },
            result_data: {
                operation: 'edit',
                applied_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u' }],
                before: [{
                    annotation_id: 'u-AAAAAAA1', library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u',
                    color: '#ffd400', comment: 'old', tags: ['old-tag'],
                }],
            },
        });

        expect(action.proposed_data).toEqual({
            operation: 'edit',
            edits: [
                {
                    annotation_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u' }],
                    changes: { color: 'blue', add_tags: ['topic'] },
                },
                {
                    annotation_refs: [{ library_id: 1, zotero_key: 'BBBBBBB2', library_ref: 'u' }],
                    changes: { comment: '' },
                },
            ],
            skipped: [{ annotation_id: '1-CCCCCCC3', reason: 'annotation was not found' }],
        });
        expect(action.result_data).toEqual({
            operation: 'edit',
            applied_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u' }],
            before: [{
                annotation_id: 'u-AAAAAAA1', library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u',
                color: '#ffd400', comment: 'old', tags: ['old-tag'],
            }],
        });
    });

    it('keeps the undo tag snapshot intact for an untagged annotation', () => {
        const action = toAgentAction({
            id: 'edit-annotations-tags', run_id: 'run-1', action_type: 'edit_annotations', status: 'applied',
            result_data: {
                operation: 'edit',
                applied_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u' }],
                before: [{
                    annotation_id: 'u-AAAAAAA1', library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u',
                    color: '#ffd400', comment: '', tags: [],
                }],
            },
        });

        expect(action.result_data?.before[0].tags).toEqual([]);
        expect(action.result_data?.before[0]).not.toHaveProperty('automatic_tags');
    });

    it('carries automatic tag types through a history round trip', () => {
        const action = toAgentAction({
            id: 'edit-annotations-auto-tags', run_id: 'run-1', action_type: 'edit_annotations', status: 'applied',
            result_data: {
                operation: 'edit',
                applied_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u' }],
                before: [{
                    annotation_id: 'u-AAAAAAA1', library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u',
                    color: '#ffd400', comment: '', tags: ['manual', 'auto'],
                    automatic_tags: ['auto'],
                }],
            },
        });

        expect(action.result_data?.before[0]).toMatchObject({
            tags: ['manual', 'auto'],
            automatic_tags: ['auto'],
        });
    });

    it('preserves a delete payload and its flat target list', () => {
        const action = toAgentAction({
            id: 'edit-annotations-2', run_id: 'run-1', action_type: 'edit_annotations', status: 'applied',
            proposed_data: {
                operation: 'delete',
                annotation_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u' }],
            },
            result_data: {
                operation: 'delete',
                applied_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u' }],
                before: [],
            },
        });

        expect(action.proposed_data).toEqual({
            operation: 'delete',
            annotation_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u' }],
            skipped: [],
        });
        expect(action.result_data?.operation).toBe('delete');
    });

    it('preserves resolved relocation payloads, placement snapshots, and legacy mappings', () => {
        const action = toAgentAction({
            id: 'edit-annotations-3', run_id: 'run-1', action_type: 'edit_annotations', status: 'applied',
            proposed_data: {
                operation: 'edit',
                edits: [{
                    annotation_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u' }],
                    relocation: {
                        loc_raw: 'heading3',
                        content_kind: 'pdf',
                        attachment_ref: { library_id: 1, zotero_key: 'ATTACH01', library_ref: 'u' },
                        page_locations: [{
                            page_idx: 3,
                            boxes: [{ l: 1, t: 2, r: 3, b: 4, coord_origin: 't' }],
                            page_label: 'iv',
                        }],
                        text: 'Moved text',
                    },
                }],
            },
            result_data: {
                operation: 'edit',
                applied_refs: [{ library_id: 1, zotero_key: 'BBBBBBB2', library_ref: 'u' }],
                before: [{
                    annotation_id: 'u-AAAAAAA1', library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u',
                    color: '#ffd400', comment: 'old', tags: [], annotation_type: 'highlight',
                    text: 'Old text', page_label: 'iii', sort_index: '00002|000001|00002',
                    position: '{"pageIndex":2}',
                    moved_to: {
                        text: 'Moved text', page_label: 'iv', sort_index: '00003|000002|00003',
                        position: '{"pageIndex":3}',
                    },
                }],
                relocated: [{
                    old_ref: { library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u' },
                    new_ref: { library_id: 1, zotero_key: 'BBBBBBB2', library_ref: 'u' },
                }],
            },
        });

        expect((action.proposed_data as any).edits[0].relocation).toMatchObject({
            loc_raw: 'heading3',
            content_kind: 'pdf',
            attachment_ref: { library_id: 1, zotero_key: 'ATTACH01', library_ref: 'u' },
            text: 'Moved text',
        });
        expect(action.result_data?.before[0]).toMatchObject({
            annotation_type: 'highlight',
            text: 'Old text',
            page_label: 'iii',
            sort_index: '00002|000001|00002',
            position: '{"pageIndex":2}',
            moved_to: {
                text: 'Moved text',
                page_label: 'iv',
                sort_index: '00003|000002|00003',
                position: '{"pageIndex":3}',
            },
        });
        expect(action.result_data?.relocated).toEqual([{
            old_ref: { library_id: 1, zotero_key: 'AAAAAAA1', library_ref: 'u' },
            new_ref: { library_id: 1, zotero_key: 'BBBBBBB2', library_ref: 'u' },
        }]);
    });
});

describe('toAgentAction edit_annotations previews', () => {
    const preview = (key: string) => ({
        annotation_id: `u-${key}`,
        library_id: 1,
        library_ref: 'u',
        zotero_key: key,
        annotation_type: 'highlight',
        color: '#ffd400',
        comment: 'a comment',
        tags: ['read'],
        page_label: '4',
        text: 'Highlighted passage',
    });

    /**
     * proposed_data is rebuilt field by field here, so anything this normalizer
     * does not carry never reaches the card — and the previews are the only
     * copy of the pre-change state left once an action is undone or rejected.
     */
    it('carries the previews through an edit', () => {
        const action = toAgentAction({
            action_type: 'edit_annotations',
            proposed_data: {
                operation: 'edit',
                edits: [
                    {
                        annotation_refs: [{ library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAA1' }],
                        changes: { color: 'blue' },
                    },
                ],
                annotation_previews: [preview('AAAAAAA1')],
            },
        });

        expect((action.proposed_data as any).annotation_previews).toEqual([
            preview('AAAAAAA1'),
        ]);
    });

    it('carries the previews through a deletion', () => {
        const action = toAgentAction({
            action_type: 'edit_annotations',
            proposed_data: {
                operation: 'delete',
                annotation_refs: [{ library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAA1' }],
                annotation_previews: [preview('AAAAAAA1')],
            },
        });

        expect((action.proposed_data as any).annotation_previews).toEqual([
            preview('AAAAAAA1'),
        ]);
    });

    it('omits the field for an action that has none', () => {
        const action = toAgentAction({
            action_type: 'edit_annotations',
            proposed_data: {
                operation: 'edit',
                edits: [
                    {
                        annotation_refs: [{ library_id: 1, zotero_key: 'AAAAAAA1' }],
                        changes: { color: 'blue' },
                    },
                ],
            },
        });

        expect('annotation_previews' in (action.proposed_data as any)).toBe(false);
    });
});

describe('undoAgentActionAtom', () => {
    const appliedEdit = (): AgentAction => ({
        id: 'action-1',
        run_id: 'run-1',
        toolcall_id: 'tool-1',
        action_type: 'edit_annotations',
        status: 'applied',
        proposed_data: {
            operation: 'edit',
            edits: [
                {
                    annotation_refs: [{ library_id: 1, library_ref: 'u', zotero_key: 'AAAAAAA1' }],
                    changes: { color: 'blue' },
                },
            ],
            annotation_previews: [
                {
                    annotation_id: 'u-AAAAAAA1',
                    library_id: 1,
                    library_ref: 'u',
                    zotero_key: 'AAAAAAA1',
                    color: '#ffd400',
                    comment: '',
                    tags: [],
                },
            ],
        },
        result_data: { operation: 'edit', applied_refs: [], before: [] },
    } as unknown as AgentAction);

    /**
     * The card renders from the previews on the proposal, so undo must leave
     * proposed_data exactly as the handler will see it when the action is
     * applied again — it rejects any field it does not know.
     */
    it('leaves the executable payload untouched', async () => {
        const { createStore } = await import('jotai');
        const { threadAgentActionsAtom, undoAgentActionAtom } = await import(
            '../../../react/agents/agentActions'
        );

        const store = createStore();
        const before = appliedEdit().proposed_data;
        store.set(threadAgentActionsAtom, [appliedEdit()]);
        store.set(undoAgentActionAtom, 'action-1');

        const undone = store.get(threadAgentActionsAtom)[0];
        expect(undone.status).toBe('undone');
        expect(undone.result_data).toBeUndefined();
        expect(undone.proposed_data).toEqual(before);
    });
});
