import { beforeEach, describe, expect, it, vi } from 'vitest';

// `toAgentAction` transitively imports the Supabase client and Zotero-aware
// profile atoms, which require live globals at import time. Stub the leaf
// modules before the SUT is loaded so unit tests can run cold.
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemDataWithAllTypes: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

import type { AgentAction } from '../../../react/agents/agentActions';
import { toAgentAction, validateAppliedAgentAction } from '../../../react/agents/agentActions';
import { getAppliedPdfAnnotationCount } from '../../../react/agents/agentActionCounts';
import type {
    CreateHighlightAnnotationsProposedData,
    CreateNoteAnnotationsProposedData,
} from '../../../react/types/agentActions/createAnnotations';
import type { CreateItemProposedData } from '../../../react/types/agentActions/items';

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
        zotero.Items = { ...zotero.Items, getByLibraryAndKeyAsync };
        zotero.Libraries = { ...zotero.Libraries, userLibraryID: 1 };
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

    it('returns unverifiable when a group-library item does not resolve', async () => {
        // Group libraryIDs are device-local: a failed lookup on this device
        // must not be treated as a revert (it would persist a false undo).
        getByLibraryAndKeyAsync.mockResolvedValue(null);
        expect(await validateAppliedAgentAction(appliedAction(5))).toBe('unverifiable');
    });

    it('returns valid when a group-library item resolves', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue({ isAnnotation: () => false });
        expect(await validateAppliedAgentAction(appliedAction(5))).toBe('valid');
    });

    it('returns invalid when an annotation action resolves to a non-annotation', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue({ isAnnotation: () => false });
        const action = appliedAction(1, { action_type: 'highlight_annotation' } as Partial<AgentAction>);
        expect(await validateAppliedAgentAction(action)).toBe('invalid');
    });

    it('returns unverifiable for bulk annotations in an unresolvable group library', async () => {
        getByLibraryAndKeyAsync.mockResolvedValue(null);
        const action = appliedAction(5, {
            action_type: 'create_highlight_annotations',
            result_data: {
                created: [
                    { library_id: 5, zotero_key: 'AAAAAAA1' },
                    { library_id: 5, zotero_key: 'AAAAAAA2' },
                ],
            },
        } as Partial<AgentAction>);
        expect(await validateAppliedAgentAction(action)).toBe('unverifiable');
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
