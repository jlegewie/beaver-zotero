import { describe, expect, it, vi } from 'vitest';
import type { TableSpec } from '@beaver/agent-core/layouts/table';

vi.mock('../../../react/components/tables/card/liveSources', () => ({ describeItems: vi.fn() }));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({ getContentKind: vi.fn() }));

import { improvableRowIds, metadataAnsweredItems } from '../../../react/components/tables/TableTabView';

const metadata = { outcome: 'answered', provenance: 'metadata', value: { kind: 'text', text: 'x' } } as const;
const document = { outcome: 'answered', provenance: 'document', value: { kind: 'text', text: 'x' } } as const;

const spec = {
    id: 't',
    title: 'T',
    columns: [{ id: 'q', header: 'Q', type: 'text' }],
    rows: [
        { id: 'unpinned', ref: { kind: 'item', library_ref: 'u', zotero_key: 'ITEMAAAA' }, cells: { q: metadata } },
        {
            id: 'pinned',
            ref: { kind: 'item', library_ref: 'u', zotero_key: 'ITEMBBBB', attachment: { library_ref: 'u', zotero_key: 'ATTBBBBB' } },
            cells: { q: metadata },
        },
        { id: 'read', ref: { kind: 'item', library_ref: 'u', zotero_key: 'ITEMCCCC' }, cells: { q: document } },
    ],
} as unknown as TableSpec;

describe('"Can be improved" rows', () => {
    it('takes only rows with an answer from title and abstract', () => {
        expect([...metadataAnsweredItems(spec).keys()]).toEqual(['u-ITEMAAAA', 'u-ITEMBBBB']);
    });

    it('uses the item\'s documents for a row that names none, and only the named attachment otherwise', () => {
        const candidates = metadataAnsweredItems(spec);
        const items = [
            { item_id: 'u-ITEMAAAA', has_pdf: true },
            // The item has another document, but the row keeps reading the one it names.
            { item_id: 'u-ITEMBBBB', has_pdf: true },
        ];
        expect([...improvableRowIds(candidates, items, () => false)]).toEqual(['unpinned']);
        expect([...improvableRowIds(candidates, items, () => true)]).toEqual(['unpinned', 'pinned']);
        expect([...improvableRowIds(candidates, [{ item_id: 'u-ITEMAAAA', has_pdf: false }], () => true)]).toEqual([]);
        // An item the lookup did not describe (an excluded library) is not offered a fill.
        expect([...improvableRowIds(candidates, [], () => true)]).toEqual([]);
    });
});
