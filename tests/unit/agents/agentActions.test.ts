import { describe, expect, it } from 'vitest';
import type { AgentAction } from '../../../react/agents/agentActions';
import { getAppliedPdfAnnotationCount } from '../../../react/agents/agentActionCounts';

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
