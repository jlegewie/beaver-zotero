import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getZoteroItem: vi.fn() }));
vi.mock('../../../react/utils/sourceUtils', () => ({
    getZoteroItem: mocks.getZoteroItem,
    getDisplayNameFromItem: (item: { name: string }) => item.name,
}));

import { buildFeatureCreditResult } from '../../../react/components/featureCredits/featureCreditResult';

const paper = { name: 'Ng et al. 2010', isAttachment: () => false, isNote: () => false };
const pdf = { libraryID: 1, key: 'PDFKEY01', name: 'pdf', parentItem: paper, isAttachment: () => true, isNote: () => false };

const action = (overrides: Record<string, unknown>) => ({
    id: 'a1',
    run_id: 'r1',
    status: 'applied',
    ...overrides,
}) as any;

describe('feature-credit result line', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getZoteroItem.mockReturnValue(pdf);
    });

    it('names the paper and offers Open PDF for batch highlight annotations', () => {
        const result = buildFeatureCreditResult('annotate', { run_id: 'r1' }, [
            action({
                action_type: 'create_highlight_annotations',
                proposed_data: { resolved_ref: { library_id: 1, zotero_key: 'PDFKEY01' }, items: [{}, {}, {}] },
                result_data: { created: [{ client_item_id: 'x' }, { client_item_id: 'y' }, { client_item_id: 'z' }] },
            }),
        ]);
        expect(mocks.getZoteroItem).toHaveBeenCalledWith(expect.objectContaining({ zotero_key: 'PDFKEY01' }));
        expect(result).toEqual({
            text: 'Beaver added 3 highlights to Ng et al. 2010.',
            target: { kind: 'open_item', ref: { library_id: 1, zotero_key: 'PDFKEY01' }, label: 'Open PDF' },
        });
    });

    it('counts only the run that earned the task, and only accepted changes', () => {
        const result = buildFeatureCreditResult('annotate', { run_id: 'r1' }, [
            action({ run_id: 'other', action_type: 'highlight_annotation', proposed_data: { attachment_key: 'PDFKEY01' }, result_data: { zotero_key: 'A', library_id: 1 } }),
            action({ status: 'rejected', action_type: 'highlight_annotation', proposed_data: { attachment_key: 'PDFKEY01' }, result_data: { zotero_key: 'B', library_id: 1 } }),
        ]);
        expect(result).toBeNull();
    });

    it('describes a table from the grant alone', () => {
        expect(buildFeatureCreditResult('research_table', { job_id: 'j1', table_title: 'Methods' }, [])).toEqual({
            text: 'Your table "Methods" is filled.',
            target: { kind: 'open_table', jobId: 'j1', label: 'Open table' },
        });
    });
});
