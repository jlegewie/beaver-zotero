import { describe, expect, it } from 'vitest';

import {
    buildTableSectionFields,
    humanizeColumnId,
    parseTableTimestamp,
    tipVersionEntry,
    type TableSectionInput,
} from '../../../src/ui/tableItemPaneModel';
import type {
    TableSummary,
    TableSummaryColumn,
} from '@beaver/agent-core/layouts/tableMutations';
import type { TableVersionEntry } from '../../../src/services/artifacts/tableItemIdentity';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function column(overrides: Partial<TableSummaryColumn> = {}): TableSummaryColumn {
    return {
        type: 'text',
        filled: 0,
        unsure: 0,
        unsourced: 0,
        stale: 0,
        ...overrides,
    };
}

function summary(overrides: Partial<TableSummary> = {}): TableSummary {
    return {
        rows: 10,
        columns: 2,
        failed_rows: 0,
        user_edits: 0,
        columns_detail: {
            title: column({ filled: 10 }),
            note: column({ filled: 4, unsure: 3 }),
        },
        ...overrides,
    };
}

function entry(overrides: Partial<TableVersionEntry> = {}): TableVersionEntry {
    return {
        version: 1,
        actor: 'agent',
        at: '2026-08-30T12:00:00.000Z',
        sha256: 'abc',
        summary: summary(),
        ...overrides,
    };
}

function input(overrides: Partial<TableSectionInput> = {}): TableSectionInput {
    return {
        summary: summary(),
        source: 'history',
        version: 1,
        history: [entry()],
        ...overrides,
    };
}

// ---------------------------------------------------------------------------

describe('parseTableTimestamp', () => {
    it('reads Zotero SQL timestamps as UTC', () => {
        expect(parseTableTimestamp('2026-08-30 12:00:00')).toBe(
            Date.parse('2026-08-30T12:00:00Z')
        );
    });

    it('reads the version log ISO timestamps', () => {
        expect(parseTableTimestamp('2026-08-30T12:00:00.000Z')).toBe(
            Date.parse('2026-08-30T12:00:00.000Z')
        );
    });

    it('answers null for anything it cannot read', () => {
        expect(parseTableTimestamp('')).toBeNull();
        expect(parseTableTimestamp(null)).toBeNull();
        expect(parseTableTimestamp(undefined)).toBeNull();
        expect(parseTableTimestamp('whenever')).toBeNull();
    });
});

describe('humanizeColumnId', () => {
    it('turns a snake_case id into a readable label', () => {
        expect(humanizeColumnId('screening_decision')).toBe('Screening decision');
        expect(humanizeColumnId('year')).toBe('Year');
    });

    it('leaves an id it cannot improve alone', () => {
        expect(humanizeColumnId('')).toBe('');
        expect(humanizeColumnId('__')).toBe('__');
    });
});

describe('tipVersionEntry', () => {
    it('takes the newest entry', () => {
        const tip = tipVersionEntry([entry({ version: 1 }), entry({ version: 7 })]);
        expect(tip?.version).toBe(7);
    });

    it('skips an entry whose summary is missing or damaged', () => {
        const damaged = { ...entry({ version: 8 }), summary: undefined as any };
        const tip = tipVersionEntry([entry({ version: 7 }), damaged]);
        expect(tip?.version).toBe(7);
    });

    it('answers null for an empty log', () => {
        expect(tipVersionEntry([])).toBeNull();
    });
});

describe('buildTableSectionFields — dimensions and coverage', () => {
    it('counts rows, columns, cells and filled cells across every column', () => {
        const fields = buildTableSectionFields(input());
        expect(fields.rows).toBe(10);
        expect(fields.columns).toBe(2);
        expect(fields.cells).toBe(20);
        expect(fields.filled).toBe(14);
        expect(fields.dimensionsLine).toBe('10 rows × 2 columns');
        expect(fields.coverageLine).toBe('14 of 20 cells filled');
    });

    it('says a table has no rows rather than showing a zero grid', () => {
        const fields = buildTableSectionFields(
            input({ summary: summary({ rows: 0, columns: 3 }) })
        );
        expect(fields.cells).toBe(0);
        expect(fields.dimensionsLine).toBe('No rows yet · 3 columns');
        expect(fields.coverageLine).toBe('');
    });

    it('calls a table with neither rows nor columns empty', () => {
        const fields = buildTableSectionFields(
            input({
                summary: summary({ rows: 0, columns: 0, columns_detail: {} }),
            })
        );
        expect(fields.dimensionsLine).toBe('Empty table');
        expect(fields.headerSummary).toBe('0 rows · v1');
    });

    it('uses singulars for a one-row, one-column table', () => {
        const fields = buildTableSectionFields(
            input({
                summary: summary({
                    rows: 1,
                    columns: 1,
                    columns_detail: { title: column({ filled: 1 }) },
                }),
            })
        );
        expect(fields.dimensionsLine).toBe('1 row × 1 column');
        expect(fields.coverageLine).toBe('1 of 1 cell filled');
    });
});

describe('buildTableSectionFields — trust counts', () => {
    it('sums unsure, unsourced and stale and lists only what is non-zero', () => {
        const fields = buildTableSectionFields(
            input({
                summary: summary({
                    columns_detail: {
                        a: column({ filled: 5, unsure: 2, stale: 1 }),
                        b: column({ filled: 5, unsure: 1, unsourced: 4 }),
                    },
                }),
            })
        );
        expect(fields.unsure).toBe(3);
        expect(fields.unsourced).toBe(4);
        expect(fields.stale).toBe(1);
        expect(fields.flagsLine).toBe('3 unsure · 4 unsourced · 1 stale');
    });

    it('leaves the flags line empty when nothing is flagged', () => {
        const fields = buildTableSectionFields(
            input({
                summary: summary({
                    columns_detail: { a: column({ filled: 10 }) },
                }),
            })
        );
        expect(fields.flagsLine).toBe('');
    });
});

describe('buildTableSectionFields — version and retention', () => {
    it('reports the version and stays quiet about a complete history', () => {
        const fields = buildTableSectionFields(
            input({
                version: 3,
                history: [entry({ version: 1 }), entry({ version: 3 })],
            })
        );
        expect(fields.version).toBe(3);
        expect(fields.oldestVersion).toBe(1);
        expect(fields.historyTruncated).toBe(false);
        expect(fields.versionLine).toBe('Version 3');
    });

    it('says how far back a truncated history reaches', () => {
        const fields = buildTableSectionFields(
            input({
                version: 12,
                history: [entry({ version: 7 }), entry({ version: 12 })],
            })
        );
        expect(fields.historyTruncated).toBe(true);
        expect(fields.versionLine).toBe('Version 12 · history goes back to v7');
    });

    it('falls back to the log tip when no version was supplied', () => {
        const fields = buildTableSectionFields(
            input({ version: null, history: [entry({ version: 4 })] })
        );
        expect(fields.version).toBe(4);
    });

    it('renders no version line when nothing knows the version', () => {
        const fields = buildTableSectionFields(
            input({ version: null, history: [] })
        );
        expect(fields.version).toBeNull();
        expect(fields.versionLine).toBe('');
        expect(fields.headerSummary).toBe('10 rows');
    });
});

describe('buildTableSectionFields — no summary', () => {
    it('still reports the version it knows when the spec could not be read', () => {
        const fields = buildTableSectionFields(
            input({ summary: null, source: null, version: 5, history: [] })
        );
        expect(fields.source).toBeNull();
        expect(fields.rows).toBe(0);
        expect(fields.dimensionsLine).toBe('');
        expect(fields.coverageLine).toBe('');
        expect(fields.versionLine).toBe('Version 5');
        expect(fields.headerSummary).toBe('v5');
    });

    it('renders nothing at all when there is no summary and no version', () => {
        const fields = buildTableSectionFields({
            summary: null,
            source: null,
            version: null,
            history: [],
        });
        expect(fields.versionLine).toBe('');
        expect(fields.headerSummary).toBe('');
        expect(fields.warning).toBeNull();
    });

    it('treats a summary without counts as no summary', () => {
        const fields = buildTableSectionFields(
            input({ summary: { rows: 'many' } as unknown as TableSummary })
        );
        expect(fields.source).toBeNull();
        expect(fields.dimensionsLine).toBe('');
    });
});

describe('buildTableSectionFields — distributions', () => {
    const screening = column({
        type: 'select',
        role: 'screening_decision',
        filled: 9,
        distribution: { Include: 5, Exclude: 3, Maybe: 1 },
    });

    it('lists select labels most common first', () => {
        const fields = buildTableSectionFields(
            input({
                summary: summary({
                    columns_detail: { screening_decision: screening },
                }),
            })
        );
        expect(fields.distributions).toHaveLength(1);
        expect(fields.distributions[0].label).toBe('Screening decision');
        expect(fields.distributions[0].entries).toEqual([
            { label: 'Include', count: 5 },
            { label: 'Exclude', count: 3 },
            { label: 'Maybe', count: 1 },
        ]);
        expect(fields.distributions[0].truncated).toBe(0);
    });

    it('prefers the column header when the caller holds the spec', () => {
        const fields = buildTableSectionFields(
            input({
                source: 'spec',
                headers: { screening_decision: 'Include?' },
                summary: summary({
                    columns_detail: { screening_decision: screening },
                }),
            })
        );
        expect(fields.distributions[0].label).toBe('Include?');
    });

    it('caps the labels it shows and counts the rest', () => {
        const fields = buildTableSectionFields(
            input({
                summary: summary({
                    columns_detail: {
                        reason: column({
                            type: 'select',
                            filled: 15,
                            distribution: { a: 6, b: 4, c: 3, d: 2, e: 1, f: 1 },
                        }),
                    },
                }),
            })
        );
        expect(fields.distributions[0].entries).toHaveLength(4);
        expect(fields.distributions[0].truncated).toBe(2);
    });

    it('shows a role-bearing column ahead of the rest, and at most two', () => {
        const fields = buildTableSectionFields(
            input({
                summary: summary({
                    columns_detail: {
                        open_access: column({
                            type: 'boolean',
                            filled: 4,
                            distribution: { true: 3, false: 1 },
                        }),
                        peer_reviewed: column({
                            type: 'boolean',
                            filled: 2,
                            distribution: { true: 2 },
                        }),
                        screening_decision: screening,
                    },
                }),
            })
        );
        expect(fields.distributions.map((d) => d.columnId)).toEqual([
            'screening_decision',
            'open_access',
        ]);
    });

    it('skips system columns and columns nothing has been written to', () => {
        const fields = buildTableSectionFields(
            input({
                summary: summary({
                    columns_detail: {
                        year: column({
                            type: 'select',
                            system: true,
                            filled: 8,
                            distribution: { '2024': 8 },
                        }),
                        verdict: column({ type: 'select', distribution: {} }),
                        title: column({ filled: 4 }),
                    },
                }),
            })
        );
        expect(fields.distributions).toEqual([]);
    });
});

describe('buildTableSectionFields — the annotation warning', () => {
    const written = entry({ version: 4, at: '2026-08-30T12:00:00.000Z' });

    it('warns about annotations placed before the most recent write', () => {
        const fields = buildTableSectionFields(
            input({
                version: 4,
                history: [written],
                annotationDates: ['2026-08-29 10:00:00', '2026-08-30 18:00:00'],
            })
        );
        expect(fields.annotations).toBe(2);
        expect(fields.annotationsBeforeLastWrite).toBe(1);
        expect(fields.annotationWarning).toBe(true);
        expect(fields.warning).toContain('1 annotation was made before version 4');
    });

    it('pluralises the warning', () => {
        const fields = buildTableSectionFields(
            input({
                version: 4,
                history: [written],
                annotationDates: ['2026-08-29 10:00:00', '2026-08-29 11:00:00'],
            })
        );
        expect(fields.warning).toContain('2 annotations were made before version 4');
    });

    it('stays quiet when every annotation postdates the last write', () => {
        const fields = buildTableSectionFields(
            input({
                history: [written],
                annotationDates: ['2026-08-31 09:00:00'],
            })
        );
        expect(fields.annotations).toBe(1);
        expect(fields.annotationsBeforeLastWrite).toBe(0);
        expect(fields.warning).toBeNull();
    });

    it('stays quiet when there are no annotations at all', () => {
        const fields = buildTableSectionFields(input({ history: [written] }));
        expect(fields.annotations).toBe(0);
        expect(fields.warning).toBeNull();
    });

    it('stays quiet when no write time is known', () => {
        const fields = buildTableSectionFields(
            input({ history: [], annotationDates: ['2026-08-29 10:00:00'] })
        );
        expect(fields.lastWriteAt).toBeNull();
        expect(fields.annotationsBeforeLastWrite).toBe(0);
        expect(fields.warning).toBeNull();
    });

    it('does not warn on an annotation whose date it cannot read', () => {
        const fields = buildTableSectionFields(
            input({ history: [written], annotationDates: ['', 'whenever', null] })
        );
        expect(fields.annotations).toBe(3);
        expect(fields.annotationsBeforeLastWrite).toBe(0);
        expect(fields.warning).toBeNull();
    });
});
