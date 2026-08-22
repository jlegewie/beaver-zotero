import { describe, expect, it } from 'vitest';
import type { Citation } from '@beaver/agent-core/types/citations';
import {
    cellIdFor,
    cellSortKey,
    citationKeysInTable,
    citationKeysInText,
    citationsByKey,
    columnAlign,
    filterRows,
    isCellEmpty,
    isColumnSortable,
    rowIdFor,
    selectLabelsInColumn,
    sortRows,
    toCsv,
    validateTableSpec,
    type Row,
    type TableSpec,
} from '@beaver/agent-core/layouts/table';
import { isTableView, isToolResultView } from '@beaver/agent-core/run-state/toolResultViews';

function row(id: string, cells: Row['cells']): Row {
    return { id, cells };
}

const spec: TableSpec = {
    id: 't1',
    columns: [
        { id: 'ref', header: 'Reference', type: 'reference' },
        { id: 'year', header: 'Year', type: 'date' },
        { id: 'cites', header: 'Citations', type: 'number' },
        { id: 'type', header: 'Type', type: 'select', options: [{ label: 'Article' }, { label: 'Book' }] },
        { id: 'oa', header: 'Open access', type: 'boolean' },
        { id: 'methods', header: 'Methods', type: 'text' },
    ],
    rows: [
        row('a', {
            ref: { value: { kind: 'reference', display_name: 'Smith 2020', subtitle: 'Alpha' } },
            year: { value: { kind: 'date', value: '2020' } },
            cites: { value: { kind: 'number', value: 120 } },
            type: { value: { kind: 'select', label: 'Article' } },
            oa: { value: { kind: 'boolean', value: true } },
            methods: { value: { kind: 'text', text: 'Survey, n = 1,200' } },
        }),
        row('b', {
            ref: { value: { kind: 'reference', display_name: 'Jones 2018' } },
            year: { value: { kind: 'date', value: '2018-05' } },
            cites: { value: { kind: 'number', value: 7 } },
            type: { value: { kind: 'select', label: 'Book' } },
            oa: { value: { kind: 'boolean', value: false } },
        }),
        row('c', {
            ref: { value: { kind: 'reference', display_name: 'adams 2022' } },
            year: { value: { kind: 'date', value: '2022-01-15' } },
            type: { value: { kind: 'select', label: 'Article' } },
            methods: { value: { kind: 'text', text: 'Interviews' } },
        }),
    ],
};

describe('ids', () => {
    it('derives stable row ids from the reference', () => {
        expect(rowIdFor({ kind: 'item', library_id: 1, zotero_key: 'ABCD1234', library_ref: 'u' })).toBe('item:u:ABCD1234');
        expect(rowIdFor({ kind: 'item', library_id: 3, zotero_key: 'ABCD1234' })).toBe('item:3:ABCD1234');
        expect(rowIdFor({ kind: 'external', source: 'openalex', source_id: 'W123' })).toBe('ext:openalex:W123');
        expect(cellIdFor('ext:openalex:W123', 'year')).toBe('ext:openalex:W123/year');
    });
});

describe('defaults', () => {
    it('treats reference and link columns as unsortable unless declared', () => {
        expect(isColumnSortable({ id: 'r', header: '', type: 'reference' })).toBe(false);
        expect(isColumnSortable({ id: 'r', header: '', type: 'reference', sortable: true })).toBe(true);
        expect(isColumnSortable({ id: 'n', header: '', type: 'number' })).toBe(true);
    });

    it('right-aligns numbers and dates by default', () => {
        expect(columnAlign({ id: 'n', header: '', type: 'number' })).toBe('end');
        expect(columnAlign({ id: 't', header: '', type: 'text' })).toBe('start');
        expect(columnAlign({ id: 'n', header: '', type: 'number', align: 'start' })).toBe('start');
    });

    it('reads a missing value as an empty cell', () => {
        expect(isCellEmpty(undefined)).toBe(true);
        expect(isCellEmpty({ status: 'pending' })).toBe(true);
        expect(isCellEmpty({ value: { kind: 'boolean', value: false } })).toBe(false);
    });
});

describe('sortRows', () => {
    it('sorts numbers numerically and puts empty cells last in both directions', () => {
        expect(sortRows(spec, { column_id: 'cites', direction: 'asc' }).map((r) => r.id)).toEqual(['b', 'a', 'c']);
        expect(sortRows(spec, { column_id: 'cites', direction: 'desc' }).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    });

    it('sorts ISO dates of mixed precision lexically', () => {
        expect(sortRows(spec, { column_id: 'year', direction: 'asc' }).map((r) => r.id)).toEqual(['b', 'a', 'c']);
    });

    it('sorts text case-insensitively', () => {
        expect(cellSortKey({ value: { kind: 'reference', display_name: 'Zed' } })).toBe('zed');
        expect(sortRows(spec, { column_id: 'ref', direction: 'asc' }).map((r) => r.id)).toEqual(['c', 'b', 'a']);
    });

    it('sorts booleans false before true and keeps input order among equals', () => {
        expect(sortRows(spec, { column_id: 'oa', direction: 'asc' }).map((r) => r.id)).toEqual(['b', 'a', 'c']);
        expect(sortRows(spec, { column_id: 'type', direction: 'asc' }).map((r) => r.id)).toEqual(['a', 'c', 'b']);
    });

    it('returns the rows unchanged without a sort or for an unknown column', () => {
        expect(sortRows(spec, undefined)).toBe(spec.rows);
        expect(sortRows(spec, { column_id: 'nope', direction: 'asc' })).toBe(spec.rows);
    });
});

describe('filterRows', () => {
    it('matches text by case-insensitive substring', () => {
        expect(filterRows(spec, [{ column_id: 'methods', kind: 'contains', text: 'survey' }]).map((r) => r.id)).toEqual(['a']);
    });

    it('applies inclusive ranges to numbers and dates, excluding empty cells', () => {
        expect(filterRows(spec, [{ column_id: 'cites', kind: 'range', min: 7, max: 119 }]).map((r) => r.id)).toEqual(['b']);
        expect(filterRows(spec, [{ column_id: 'year', kind: 'range', min: '2020' }]).map((r) => r.id)).toEqual(['a', 'c']);
    });

    it('filters select membership and boolean equality', () => {
        expect(filterRows(spec, [{ column_id: 'type', kind: 'in', labels: ['Book'] }]).map((r) => r.id)).toEqual(['b']);
        expect(filterRows(spec, [{ column_id: 'oa', kind: 'equals', value: true }]).map((r) => r.id)).toEqual(['a']);
    });

    it('filters on emptiness and ANDs multiple filters', () => {
        expect(filterRows(spec, [{ column_id: 'cites', kind: 'empty', empty: true }]).map((r) => r.id)).toEqual(['c']);
        expect(
            filterRows(spec, [
                { column_id: 'type', kind: 'in', labels: ['Article'] },
                { column_id: 'methods', kind: 'empty', empty: false },
                { column_id: 'cites', kind: 'empty', empty: false },
            ]).map((r) => r.id),
        ).toEqual(['a']);
    });

    it('ignores filters on unknown columns', () => {
        expect(filterRows(spec, [{ column_id: 'nope', kind: 'contains', text: 'x' }])).toBe(spec.rows);
    });

    it('lists distinct select labels in first-seen order', () => {
        expect(selectLabelsInColumn(spec, 'type')).toEqual(['Article', 'Book']);
    });
});

describe('citations', () => {
    const citation: Citation = {
        citation_id: 'c1',
        requested_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ABCD1234', loc: { kind: 'sentence', raw: 's12', value: '12' } as any },
        resolved_ref: { kind: 'zotero', library_id: 1, zotero_key: 'ABCD1234', library_ref: 'u', loc: { kind: 'sentence', raw: 's12', value: '12' } as any },
        raw_tag: '<citation id="1-ABCD1234" loc="s12"/>',
    };

    it('finds citation keys in text', () => {
        expect(citationKeysInText('Surveys <citation id="1-ABCD1234" loc="s12"/> and <citation external_id="W1"/>.')).toEqual([
            'zotero:1-ABCD1234:s12',
            'external:W1',
        ]);
        expect(citationKeysInText('no tags')).toEqual([]);
    });

    it('collects keys from values and details, de-duplicated', () => {
        const withCites: TableSpec = {
            ...spec,
            rows: [
                row('a', {
                    methods: {
                        value: { kind: 'text', text: 'x <citation id="1-ABCD1234" loc="s12"/>' },
                        details: { kind: 'list', items: ['y <citation id="1-ABCD1234" loc="s12"/>', 'z <citation external_id="W1"/>'] },
                    },
                }),
            ],
        };
        expect(citationKeysInTable(withCites)).toEqual(['zotero:1-ABCD1234:s12', 'external:W1']);
    });

    it('indexes citation metadata under requested, resolved and raw-tag keys', () => {
        const byKey = citationsByKey([citation]);
        expect(byKey['zotero:1-ABCD1234:s12']).toBe(citation);
        expect(byKey['zotero:u-ABCD1234:s12']).toBe(citation);
    });
});

describe('validateTableSpec', () => {
    it('accepts a well-formed spec', () => {
        expect(validateTableSpec(spec)).toEqual([]);
    });

    it('reports duplicate ids, unknown columns and sort columns', () => {
        const bad: TableSpec = {
            id: 't',
            columns: [
                { id: 'a', header: 'A', type: 'text' },
                { id: 'a', header: 'A2', type: 'text' },
            ],
            rows: [row('r', { zzz: {} }), row('r', {})],
            sort: { column_id: 'missing', direction: 'asc' },
        };
        expect(validateTableSpec(bad).map((i) => i.code)).toEqual([
            'duplicate_column_id',
            'unknown_sort_column',
            'unknown_column',
            'duplicate_row_id',
        ]);
    });

    it('reports a value kind that disagrees with the column type', () => {
        const bad: TableSpec = {
            id: 't',
            columns: [{ id: 'n', header: 'N', type: 'number' }],
            rows: [row('r', { n: { value: { kind: 'text', text: '12' } } })],
        };
        expect(validateTableSpec(bad)).toMatchObject([{ code: 'value_kind_mismatch', row_id: 'r', column_id: 'n' }]);
    });

    it('checks select labels only when the column declares options', () => {
        const declared: TableSpec = {
            ...spec,
            rows: [row('r', { type: { value: { kind: 'select', label: 'Preprint' } } })],
        };
        expect(validateTableSpec(declared)).toMatchObject([{ code: 'unknown_select_label' }]);

        const free: TableSpec = {
            id: 't',
            columns: [{ id: 'type', header: 'T', type: 'select' }],
            rows: [row('r', { type: { value: { kind: 'select', label: 'Preprint' } } })],
        };
        expect(validateTableSpec(free)).toEqual([]);
    });

    it('reports citation tags without matching metadata', () => {
        const cited: TableSpec = {
            id: 't',
            columns: [{ id: 'm', header: 'M', type: 'text' }],
            rows: [row('r', { m: { value: { kind: 'text', text: 'see <citation external_id="W9"/>' } } })],
        };
        expect(validateTableSpec(cited)).toMatchObject([{ code: 'unresolved_citation' }]);
        expect(
            validateTableSpec({
                ...cited,
                citations: [{ citation_id: 'x', requested_ref: { kind: 'external', external_id: 'W9' } } as Citation],
            }),
        ).toEqual([]);
    });
});

describe('toCsv', () => {
    it('writes headers, value text, empty cells and escapes fields', () => {
        const csv = toCsv(spec, sortRows(spec, { column_id: 'cites', direction: 'desc' }));
        expect(csv.split('\r\n')).toEqual([
            'Reference,Year,Citations,Type,Open access,Methods',
            'Smith 2020 — Alpha,2020,120,Article,true,"Survey, n = 1,200"',
            'Jones 2018,2018-05,7,Book,false,',
            'adams 2022,2022-01-15,,Article,,Interviews',
        ]);
    });
});

describe('TableView', () => {
    it('is recognised as a tool-result view', () => {
        const view = { view_type: 'table', tool_name: 'external_search', table: spec };
        expect(isToolResultView(view)).toBe(true);
        expect(isTableView(view as any)).toBe(true);
    });
});
