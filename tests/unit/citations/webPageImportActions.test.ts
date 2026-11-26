import { describe, expect, it } from 'vitest';
import { withoutDuplicateWebPages } from '../../../react/host/zotero/components/AgentActionsReview';

const importAction = (id: string, externalId: string, status = 'pending') => ({
    id,
    action_type: 'import_item',
    status,
    toolcall_id: 'citations',
    proposed_data: { source: { kind: 'external', input: externalId, external_id: externalId } },
}) as any;

describe('citation import actions for a web page that is a cited work', () => {
    const references: Record<string, any> = {
        W4384918448: { source: 'openalex', source_id: 'W4384918448', identifiers: { doi: '10.48550/arxiv.2307.09288' }, library_items: [] },
        'web-XVI34QLCT5': { source: 'exa', source_id: 'web-XVI34QLCT5', identifiers: { arXivID: '2307.09288' }, library_items: [] },
        'web-MJNNMKH4ED': { source: 'exa', source_id: 'web-MJNNMKH4ED', library_items: [] },
    };

    it('offers the work once and keeps unrelated pages and decided actions', () => {
        const actions = [
            importAction('a', 'W4384918448'),
            importAction('b', 'web-XVI34QLCT5'),
            importAction('c', 'web-MJNNMKH4ED'),
            importAction('d', 'web-XVI34QLCT5', 'applied'),
        ];
        expect(withoutDuplicateWebPages(actions, references).map((action) => action.id)).toEqual(['a', 'c', 'd']);
    });
});
