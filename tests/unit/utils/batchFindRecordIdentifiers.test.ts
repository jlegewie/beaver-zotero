import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { MockDBConnection } from '../../mocks/mockDBConnection';
import { createSeedContext, createZoteroSchema, installZoteroDB, seedZoteroItem } from '../../helpers/zoteroSchemaSeed';
import {
    batchFindByRecordIdentifiers,
    batchFindExistingReferences,
    trialIdOf,
} from '../../../src/utils/batchFindExistingReferences';

const EXTRA_FIELD_ID = 501;
const URL_FIELD_ID = 502;
const REPORT_NUMBER_FIELD_ID = 503;
const INSTITUTION_FIELD_ID = 504;
const PMID_FIELD_ID = 505;
const EXTRA_FIELDS: Record<string, number> = {
    PMID: PMID_FIELD_ID,
    extra: EXTRA_FIELD_ID,
    url: URL_FIELD_ID,
    reportNumber: REPORT_NUMBER_FIELD_ID,
    institution: INSTITUTION_FIELD_ID,
};

let conn: MockDBConnection;
let ctx: ReturnType<typeof createSeedContext>;
let nextValueID = 5000;

async function seedWithFields(fields: Record<string, string>, options: { deleted?: boolean; title?: string } = {}): Promise<string> {
    const itemID = await seedZoteroItem(conn, ctx, { title: options.title ?? 'Some title', deleted: options.deleted });
    for (const [name, value] of Object.entries(fields)) {
        await conn.queryAsync('INSERT OR IGNORE INTO itemDataValues (valueID, value) VALUES (?, ?)', [nextValueID++, value]);
        await conn.queryAsync(
            'INSERT INTO itemData (itemID, fieldID, valueID) SELECT ?, ?, valueID FROM itemDataValues WHERE value = ?',
            [itemID, EXTRA_FIELDS[name], value],
        );
    }
    return `K${String(itemID).padStart(7, '0')}`;
}

beforeEach(async () => {
    conn = new MockDBConnection();
    await createZoteroSchema(conn);
    installZoteroDB(conn);
    ctx = createSeedContext();
    vi.mocked(Zotero.ItemFields.getID).mockImplementation((name: string) =>
        EXTRA_FIELDS[name] ?? ((globalThis as any).__TEST_FIELD_IDS[name] ?? 0));
});

afterEach(async () => {
    await conn.closeDatabase();
    vi.mocked(Zotero.ItemFields.getID).mockImplementation((name: string) =>
        (globalThis as any).__TEST_FIELD_IDS[name] ?? 0);
});

describe('trialIdOf', () => {
    it('reads the NCT id from the report number or the registry URL', () => {
        expect(trialIdOf({ reportNumber: 'nct03548935' })).toBe('NCT03548935');
        expect(trialIdOf({ url: 'https://clinicaltrials.gov/study/NCT03548935' })).toBe('NCT03548935');
        expect(trialIdOf({ url: 'https://www.clinicaltrials.gov/ct2/show/NCT03548935?term=x' })).toBe('NCT03548935');
        expect(trialIdOf({ url: 'https://pubmed.ncbi.nlm.nih.gov/1/' })).toBeNull();
    });
});

describe('batchFindByRecordIdentifiers', () => {
    it('matches a PubMed id on its own line in Extra, not inside another id', async () => {
        const key = await seedWithFields({ extra: 'tex.foo: bar\nPMID: 41234567\nPMCID: PMC1' });
        await seedWithFields({ extra: 'PMID: 141234567' });
        const matches = await batchFindByRecordIdentifiers([
            { id: 'a', data: { PMID: '41234567' } },
            { id: 'b', data: { PMID: '1234567' } },
        ], [1]);
        expect(matches.get('a')?.zotero_key).toBe(key);
        expect(matches.has('b')).toBe(false);
    });

    it('matches a trial by its registry URL, in any stored variant', async () => {
        const key = await seedWithFields({ url: 'https://www.clinicaltrials.gov/study/NCT03548935/' });
        const matches = await batchFindByRecordIdentifiers([
            { id: 'trial', data: { url: 'https://clinicaltrials.gov/study/NCT03548935' } },
        ], [1]);
        expect(matches.get('trial')?.zotero_key).toBe(key);
    });

    it('matches a trial by report number only when the registry is the institution', async () => {
        await seedWithFields({ reportNumber: 'NCT03548935', institution: 'Some university' });
        const key = await seedWithFields({ reportNumber: 'NCT03548935', institution: 'clinicaltrials.gov' });
        const matches = await batchFindByRecordIdentifiers([
            { id: 'trial', data: { reportNumber: 'NCT03548935' } },
        ], [1]);
        expect(matches.get('trial')?.zotero_key).toBe(key);
    });

    it('matches the PMID field Zotero 11 moves the id into', async () => {
        const key = await seedWithFields({ PMID: '33567185' });
        const matches = await batchFindByRecordIdentifiers([{ id: 'a', data: { PMID: '33567185' } }], [1]);
        expect(matches.get('a')?.zotero_key).toBe(key);
    });

    it('skips trashed items', async () => {
        await seedWithFields({ extra: 'PMID: 7' }, { deleted: true });
        const matches = await batchFindByRecordIdentifiers([{ id: 'a', data: { PMID: '7' } }], [1]);
        expect(matches.size).toBe(0);
    });
});

describe('batchFindExistingReferences with record identifiers', () => {
    it('finds a trial whose title and update year changed since it was imported', async () => {
        const key = await seedWithFields(
            { url: 'https://clinicaltrials.gov/study/NCT03548935', reportNumber: 'NCT03548935', institution: 'clinicaltrials.gov' },
            { title: 'Old official title' },
        );
        const { results } = await batchFindExistingReferences([{
            id: 'NCT03548935',
            data: { title: 'New official title', date: '2026', reportNumber: 'NCT03548935', url: 'https://clinicaltrials.gov/study/NCT03548935' },
        }], [1]);
        expect(results[0].item?.zotero_key).toBe(key);
    });

    it('finds a work imported from its PubMed id when it is later found by its OpenAlex id', async () => {
        const key = await seedWithFields({ extra: 'PMID: 41234567' }, { title: 'PubMed title' });
        const { results } = await batchFindExistingReferences([{
            id: 'W4390000001',
            data: { title: 'A different OpenAlex title', PMID: '41234567' },
        }], [1]);
        expect(results[0].item?.zotero_key).toBe(key);
    });
});
