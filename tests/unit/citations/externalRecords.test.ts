import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
    combineSnapshotList,
    combineSnapshots,
    externalIdNamespace,
    ingestSnapshot,
    keepNewerLibraryState,
    replacesSnapshot,
    withSupplierSource,
} from '@beaver/agent-core/citations/externalRecords';
import type { ExternalReference } from '@beaver/agent-core/types/externalReferences';

const GOLDEN = join(__dirname, '../../fixtures/external_references/combine');
const T0 = '2026-11-02T12:00:00Z';

function snapshot(fields: Partial<ExternalReference> = {}): ExternalReference {
    return { source: 'openalex', source_id: 'W4390000001', library_items: [], ...fields };
}

/**
 * The comparable form of a record: unset values dropped, as the backend omits
 * them from the wire. The backend's model fills list and object defaults
 * (`[]`, `{}`, a candidate's `access_method`), which carry no information here.
 */
function normalize(value: unknown, key?: string): unknown {
    if (Array.isArray(value)) {
        const items = value.map((entry) => normalize(entry, key)).filter((entry) => entry !== undefined);
        return items.length ? items : undefined;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([name, entry]) => !(key === 'oa_candidates' && name === 'access_method' && entry === 'openalex'))
            .map(([name, entry]) => [name, normalize(entry, name)] as const)
            .filter(([, entry]) => entry !== undefined);
        return entries.length ? Object.fromEntries(entries) : undefined;
    }
    return value === null ? undefined : value;
}

function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items];
    return items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

describe('combineSnapshots golden files', () => {
    const files = readdirSync(GOLDEN).filter((name) => name.endsWith('.json')).sort();

    it('finds the shared golden files', () => {
        expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
        it(`matches ${file} in every snapshot order`, () => {
            const fixture = JSON.parse(readFileSync(join(GOLDEN, file), 'utf8'));
            for (const order of permutations(fixture.snapshots as ExternalReference[])) {
                expect(normalize(combineSnapshots(order))).toEqual(normalize(fixture.expected));
            }
        });
    }
});

describe('combineSnapshots', () => {
    it('returns a single snapshot as its own record', () => {
        const only = snapshot({ title: 'T' });
        expect(combineSnapshots([only])).toBe(only);
    });

    it('takes groups whole from one snapshot', () => {
        const pubmed = snapshot({ source: 'pubmed', authors: ['Lee, Min'], year: 2024 });
        const openalex = snapshot({
            creators: [{ creatorType: 'author', firstName: 'Ana', lastName: 'Garcia' }],
            authors: ['Ana Garcia'],
            publication_date: '2023-12-30',
            year: 2023,
        });
        const record = combineSnapshots([openalex, pubmed]);
        expect(record.authors).toEqual(['Lee, Min']);
        expect(record.creators).toBeUndefined();
        expect(record.year).toBe(2024);
        expect(record.publication_date).toBeUndefined();
    });

    it('keeps the DB id of the snapshot whose source it reports', () => {
        const record = combineSnapshots([snapshot({ id: 'oa' }), snapshot({ source: 'pubmed', id: 'pm' })]);
        expect(record.source).toBe('pubmed');
        expect(record.id).toBe('pm');
    });

    it('lets the newest library check win across sources', () => {
        const older = snapshot({ source: 'pubmed', library_checked_at: T0 });
        const newer = snapshot({
            library_checked_at: '2026-11-02T12:00:01Z',
            library_items: [{ library_id: 1, zotero_key: 'ABCD2345', item_id: '' }],
        });
        expect(combineSnapshots([older, newer]).library_items[0].zotero_key).toBe('ABCD2345');
    });
});

describe('snapshot ordering', () => {
    it('lets a timestamped snapshot beat an untimestamped one', () => {
        expect(replacesSnapshot(snapshot(), snapshot({ retrieved_at: T0 }))).toBe(true);
        expect(replacesSnapshot(snapshot({ retrieved_at: T0 }), snapshot())).toBe(false);
    });

    it('lets a strictly newer timestamp win, to the microsecond, and keeps the stored one on a tie', () => {
        const stored = snapshot({ retrieved_at: '2026-11-02T12:00:00.000001Z' });
        expect(replacesSnapshot(stored, snapshot({ retrieved_at: '2026-11-02T12:00:00.000002Z' }))).toBe(true);
        expect(replacesSnapshot(stored, snapshot({ retrieved_at: '2026-11-02T12:00:00.000001+00:00' }))).toBe(false);
        expect(replacesSnapshot(stored, snapshot({ retrieved_at: '2026-11-02T11:59:59Z' }))).toBe(false);
    });

    it('lets the later of two untimestamped snapshots win', () => {
        expect(replacesSnapshot(snapshot({ title: 'a' }), snapshot({ title: 'b' }))).toBe(true);
    });

    it('carries a newer library check over without mutating either snapshot', () => {
        const kept = snapshot({ retrieved_at: T0, title: 'kept' });
        const other = snapshot({
            retrieved_at: T0,
            library_checked_at: T0,
            library_items: [{ library_id: 1, zotero_key: 'ABCD2345', item_id: '' }],
        });
        const merged = keepNewerLibraryState(kept, other);
        expect(merged).not.toBe(kept);
        expect(merged.title).toBe('kept');
        expect(merged.library_items[0].zotero_key).toBe('ABCD2345');
        expect(kept.library_items).toEqual([]);
        expect(keepNewerLibraryState(other, kept)).toBe(other);
    });

    it('reports an ignored older snapshot as no change', () => {
        const stored = { openalex: snapshot({ retrieved_at: '2026-11-02T13:00:00Z', title: 'new' }) };
        expect(ingestSnapshot(stored, snapshot({ retrieved_at: T0, title: 'old' }))).toBeNull();
    });

    it('combines the same records whatever order distinct timestamps arrive in', () => {
        const snapshots = [
            snapshot({ source: 'pubmed', retrieved_at: '2026-11-02T14:00:00Z', citation_count: 1, title: 'PubMed old' }),
            snapshot({ source: 'pubmed', retrieved_at: '2026-11-02T15:00:00Z', title: 'PubMed new' }),
            snapshot({ retrieved_at: '2026-11-02T13:00:00Z', citation_count: 5 }),
            snapshot({ retrieved_at: '2026-11-02T16:00:00Z', citation_count: 9 }),
        ];
        const expected = combineSnapshotList(snapshots).get('W4390000001');
        expect(expected?.title).toBe('PubMed new');
        expect(expected?.citation_count).toBe(9);
        for (const order of permutations(snapshots)) {
            expect(combineSnapshotList(order).get('W4390000001')).toEqual(expected);
        }
    });

    it('relabels legacy untimestamped OpenAlex records of other suppliers', () => {
        expect(withSupplierSource(snapshot({ source_id: 'doi:10.1/x' })).source).toBe('crossref');
        expect(withSupplierSource(snapshot({ source_id: 'isbn:9780000000002' })).source).toBe('openlibrary');
        expect(withSupplierSource(snapshot({ source_id: 'doi:10.1/x', retrieved_at: T0 })).source).toBe('openalex');
    });
});

describe('externalIdNamespace', () => {
    it('recognizes every id namespace', () => {
        expect(externalIdNamespace('W123')).toBe('openalex');
        expect(externalIdNamespace('pmid:41234567')).toBe('pmid');
        expect(externalIdNamespace('NCT03548935')).toBe('nct');
        expect(externalIdNamespace('openlibrary:OL1M')).toBe('openlibrary');
        expect(externalIdNamespace('isbn:9780000000002')).toBe('isbn');
        expect(externalIdNamespace('doi:10.1/x')).toBe('doi');
        expect(externalIdNamespace('exa:abc')).toBeNull();
    });
});
