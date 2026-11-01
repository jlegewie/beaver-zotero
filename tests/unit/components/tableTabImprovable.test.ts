import { describe, expect, it, vi } from 'vitest';
import type { TableSpec } from '@beaver/agent-core/layouts/table';

vi.mock('../../../react/components/tables/card/liveSources', () => ({ describeItems: vi.fn() }));

import { improvableRowIds, titleAbstractAnsweredItems } from '../../../react/components/tables/TableTabView';

const fromAbstract = { outcome: 'answered', provenance: 'model', value: { kind: 'text', text: 'x' } } as const;
const fromDocument = {
    outcome: 'answered',
    provenance: 'model',
    documents: ['u-ATTCCCCC'],
    value: { kind: 'text', text: 'x' },
} as const;
const byUser = { outcome: 'answered', provenance: 'user', value: { kind: 'text', text: 'x' } } as const;

const spec = {
    id: 't',
    title: 'T',
    columns: [{ id: 'q', header: 'Q', type: 'text' }],
    rows: [
        { id: 'abstract', ref: { kind: 'item', library_ref: 'u', zotero_key: 'ITEMAAAA' }, cells: { q: fromAbstract } },
        {
            // Names a document already: its title-and-abstract answers are stale, not improvable.
            id: 'named',
            ref: { kind: 'item', library_ref: 'u', zotero_key: 'ITEMBBBB' },
            documents: ['u-ATTBBBBB'],
            cells: { q: fromAbstract },
        },
        {
            id: 'read',
            ref: { kind: 'item', library_ref: 'u', zotero_key: 'ITEMCCCC' },
            documents: ['u-ATTCCCCC'],
            cells: { q: fromDocument },
        },
        { id: 'user', ref: { kind: 'item', library_ref: 'u', zotero_key: 'ITEMDDDD' }, cells: { q: byUser } },
    ],
} as unknown as TableSpec;

describe('"Can be improved" rows', () => {
    it('takes only item rows answered from title and abstract that name no document yet', () => {
        expect(Object.fromEntries(titleAbstractAnsweredItems(spec))).toEqual({ 'u-ITEMAAAA': ['abstract'] });
    });

    it('offers a fill once the item has a document', () => {
        const candidates = titleAbstractAnsweredItems(spec);
        expect([...improvableRowIds(candidates, [{ item_id: 'u-ITEMAAAA', has_pdf: true }])]).toEqual(['abstract']);
        expect([...improvableRowIds(candidates, [{ item_id: 'u-ITEMAAAA', has_pdf: false }])]).toEqual([]);
        // An item the lookup did not describe (an excluded library) is not offered a fill.
        expect([...improvableRowIds(candidates, [])]).toEqual([]);
    });
});
