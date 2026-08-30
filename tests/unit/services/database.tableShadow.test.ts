/**
 * The SQL behind the stored-table recovery shadow, against real SQLite.
 *
 * What only the real engine settles: that the unique key is
 * (library, key, version) — so a write that reuses its version number updates
 * the row instead of adding one — that "most recently written first" is the
 * order the retention rule prunes by, and that a delete hands back the rows it
 * removed so the caller can delete their payload files.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { BeaverDB, type TableShadowInput } from '../../../src/services/database';

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => '0.23.0'),
    setPref: vi.fn(),
    clearPref: vi.fn(),
}));

const LIBRARY_ID = 1;
const KEY = 'TBL00003';

let conn: MockDBConnection;
let db: BeaverDB;

function row(overrides: Partial<TableShadowInput> = {}): TableShadowInput {
    return {
        libraryId: LIBRARY_ID,
        zoteroKey: KEY,
        version: 1,
        sha256: 'a'.repeat(64),
        writtenAt: '2026-08-30T12:00:00.000Z',
        payloadPath: '/tmp/shadow/1.json.gz',
        payloadSizeBytes: 100,
        ...overrides,
    };
}

beforeEach(async () => {
    vi.clearAllMocks();
    conn = new MockDBConnection();
    db = new BeaverDB(conn);
    await db.initDatabase('0.23.0');
});

afterEach(async () => {
    await conn.closeDatabase();
});

describe('table_recovery_shadow', () => {
    it('returns the versions a table holds, most recently written first', async () => {
        await db.upsertTableShadow(row({ version: 1, writtenAt: '2026-08-30T12:00:00.000Z' }));
        await db.upsertTableShadow(row({ version: 2, writtenAt: '2026-08-30T12:00:02.000Z' }));
        await db.upsertTableShadow(row({ version: 3, writtenAt: '2026-08-30T12:00:01.000Z' }));

        const rows = await db.getTableShadows(LIBRARY_ID, KEY);

        expect(rows.map((entry) => entry.version)).toEqual([2, 3, 1]);
        expect(rows[0]).toMatchObject({ libraryId: LIBRARY_ID, zoteroKey: KEY });
    });

    it('replaces the row for a version rather than adding a second one', async () => {
        await db.upsertTableShadow(row({ version: 2, sha256: 'b'.repeat(64) }));
        await db.upsertTableShadow(
            row({
                version: 2,
                sha256: 'c'.repeat(64),
                writtenAt: '2026-08-30T13:00:00.000Z',
                payloadPath: '/tmp/shadow/2b.json.gz',
                payloadSizeBytes: 200,
            })
        );

        const rows = await db.getTableShadows(LIBRARY_ID, KEY);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            version: 2,
            sha256: 'c'.repeat(64),
            payloadPath: '/tmp/shadow/2b.json.gz',
            payloadSizeBytes: 200,
        });
    });

    it('keeps each table\'s versions to itself', async () => {
        await db.upsertTableShadow(row({ version: 1 }));
        await db.upsertTableShadow(row({ zoteroKey: 'OTHER001', version: 1 }));
        await db.upsertTableShadow(row({ libraryId: 2, version: 1 }));

        expect(await db.getTableShadows(LIBRARY_ID, KEY)).toHaveLength(1);
        expect(await db.getTableShadows(LIBRARY_ID, 'OTHER001')).toHaveLength(1);
        expect(await db.getTableShadows(2, KEY)).toHaveLength(1);
    });

    it('hands back the rows a version delete removed, so their files can go too', async () => {
        await db.upsertTableShadow(row({ version: 1, payloadPath: '/tmp/shadow/1.gz' }));
        await db.upsertTableShadow(row({ version: 2, payloadPath: '/tmp/shadow/2.gz' }));
        await db.upsertTableShadow(row({ version: 3, payloadPath: '/tmp/shadow/3.gz' }));

        const removed = await db.deleteTableShadowVersions(LIBRARY_ID, KEY, [1, 2]);

        expect(removed.map((entry) => entry.payloadPath).sort()).toEqual([
            '/tmp/shadow/1.gz',
            '/tmp/shadow/2.gz',
        ]);
        expect((await db.getTableShadows(LIBRARY_ID, KEY)).map((e) => e.version)).toEqual([3]);
    });

    it('deletes nothing and reports nothing for an empty version list', async () => {
        await db.upsertTableShadow(row({ version: 1 }));

        expect(await db.deleteTableShadowVersions(LIBRARY_ID, KEY, [])).toEqual([]);
        expect(await db.getTableShadows(LIBRARY_ID, KEY)).toHaveLength(1);
    });

    it('drops one table without touching another', async () => {
        await db.upsertTableShadow(row({ version: 1 }));
        await db.upsertTableShadow(row({ version: 2 }));
        await db.upsertTableShadow(row({ zoteroKey: 'OTHER001', version: 1 }));

        const removed = await db.deleteTableShadows(LIBRARY_ID, KEY);

        expect(removed.map((entry) => entry.version).sort()).toEqual([1, 2]);
        expect(await db.getTableShadows(LIBRARY_ID, KEY)).toEqual([]);
        expect(await db.getTableShadows(LIBRARY_ID, 'OTHER001')).toHaveLength(1);
    });

    it('records a version whose spec was too large to retain', async () => {
        await db.upsertTableShadow(
            row({ version: 4, payloadPath: null, payloadSizeBytes: 0 })
        );

        const rows = await db.getTableShadows(LIBRARY_ID, KEY);

        // Detection still works off the digest; only the restore is unavailable.
        expect(rows[0]).toMatchObject({ payloadPath: null, payloadSizeBytes: 0 });
        expect(rows[0].sha256).toHaveLength(64);
    });
});
