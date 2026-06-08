import { describe, expect, it, vi } from 'vitest';

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
import { toAgentAction } from '../../../react/agents/agentActions';
import { getAppliedPdfAnnotationCount } from '../../../react/agents/agentActionCounts';
import type {
    CreateHighlightAnnotationsProposedData,
    CreateNoteAnnotationsProposedData,
} from '../../../react/types/agentActions/createAnnotations';

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
        expect(data.items[0].page_locations[0].reading_order_offset).toBe(7);
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
        expect(data.items[0].page_locations[0].reading_order_offset).toBe(3);
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
});
