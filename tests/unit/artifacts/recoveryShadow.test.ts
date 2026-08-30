/**
 * The recovery shadow: what this device wrote, kept where a sync conflict
 * cannot reach it.
 *
 * The case under test is not a crash. Zotero resolves a file conflict on a
 * table's storage directory by keeping one whole copy, so the table that comes
 * back is *internally consistent* — document, log and version files all agree,
 * and every repair the store performs on open finds nothing to do. The only
 * evidence that anything was lost is outside that directory.
 *
 * So the fixture rolls the whole directory back together
 * ({@link resolveConflictTowardRemote}), exactly as the dev endpoint's
 * `sync_conflict` mode does, rather than damaging one file: a test that only
 * downgraded the document would be exercising crash recovery instead.
 *
 * The test that matters most is the one that asserts *silence*. A false
 * positive here would put "your work was replaced" on every table on every
 * open, which is worse than the loss it warns about.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    mkdtemp,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const checkLibraryExcluded = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded,
}));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => 0),
    setPref: vi.fn(),
    clearPref: vi.fn(),
}));

import type { TableSpec } from '@beaver/agent-core/layouts/table';
import { summarize } from '@beaver/agent-core/layouts/tableMutations';
import type { TableShadowRecord } from '../../../src/services/database';
import {
    buildTableDocument,
    parseTableDocument,
} from '../../../src/services/artifacts/tableDocument';
import { TABLE_TAG } from '../../../src/services/artifacts/tableItem';
import {
    detectTableSyncConflict,
    lastTableShadow,
    readTableShadow,
    TABLE_SHADOW_RETENTION,
} from '../../../src/services/artifacts/recoveryShadow';
import {
    createTable,
    deleteTable,
    openTable,
    restoreShadowVersion,
    writeTable,
    type TableHistory,
    type TableWriteResult,
} from '../../../src/services/artifacts/tableStore';
import { readTableSectionData } from '../../../src/ui/tableItemPane';

// ---------------------------------------------------------------------------
// A temp profile and a temp storage directory
// ---------------------------------------------------------------------------

const LIBRARY_ID = 1;
const KEY = 'TBL00002';
const ref = { libraryID: LIBRARY_ID, key: KEY };

let profileDir: string;
let storageDir: string;
let htmlPath: string;
let item: any;
let db: FakeShadowDB;
let savedIOUtils: any;
let savedPathUtils: any;
let savedZotero: any;

/** Real file I/O, so the payloads are genuinely written, moved and deleted. */
const realIOUtils = {
    exists: async (path: string) => existsSync(path),
    read: async (path: string) => new Uint8Array(await readFile(path)),
    readUTF8: async (path: string) => readFile(path, 'utf8'),
    write: async (path: string, bytes: Uint8Array) => {
        await writeFile(path, bytes);
        return bytes.byteLength;
    },
    writeUTF8: async (path: string, text: string) => {
        await writeFile(path, text, 'utf8');
        return text.length;
    },
    move: async (from: string, to: string) => rename(from, to),
    remove: async (path: string, options?: { ignoreAbsent?: boolean }) => {
        await rm(path, { force: !!options?.ignoreAbsent, recursive: true });
    },
    makeDirectory: async (path: string) => {
        await mkdir(path, { recursive: true });
    },
    getChildren: async (path: string) =>
        (await readdir(path)).map((name) => join(path, name)),
};

const realPathUtils = {
    join: (...parts: string[]) => join(...parts),
    filename: (path: string) => basename(path),
    parent: (path: string) => dirname(path),
};

/**
 * The four `BeaverDB` methods the shadow uses, in memory.
 *
 * A real `MockDBConnection` would be better, but its `better-sqlite3` binary is
 * built for a different Node than the one this suite runs under. The SQL itself
 * is exercised in `tests/unit/services/database.tableShadow.test.ts`; what is
 * modelled here is the contract those queries provide — the unique key on
 * (library, key, version), and "most recently written first".
 */
class FakeShadowDB {
    private rows: TableShadowRecord[] = [];

    async upsertTableShadow(input: TableShadowRecord): Promise<void> {
        const existing = this.rows.findIndex(
            (row) =>
                row.libraryId === input.libraryId &&
                row.zoteroKey === input.zoteroKey &&
                row.version === input.version
        );
        if (existing >= 0) this.rows[existing] = { ...input };
        else this.rows.push({ ...input });
    }

    async getTableShadows(libraryId: number, zoteroKey: string): Promise<TableShadowRecord[]> {
        return this.rows
            .filter((row) => row.libraryId === libraryId && row.zoteroKey === zoteroKey)
            .sort(
                (a, b) =>
                    b.writtenAt.localeCompare(a.writtenAt) || b.version - a.version
            )
            .map((row) => ({ ...row }));
    }

    async deleteTableShadowVersions(
        libraryId: number,
        zoteroKey: string,
        versions: number[]
    ): Promise<TableShadowRecord[]> {
        const doomed = this.rows.filter(
            (row) =>
                row.libraryId === libraryId &&
                row.zoteroKey === zoteroKey &&
                versions.includes(row.version)
        );
        this.rows = this.rows.filter((row) => !doomed.includes(row));
        return doomed.map((row) => ({ ...row }));
    }

    async deleteTableShadows(libraryId: number, zoteroKey: string): Promise<TableShadowRecord[]> {
        const doomed = await this.getTableShadows(libraryId, zoteroKey);
        this.rows = this.rows.filter(
            (row) => !(row.libraryId === libraryId && row.zoteroKey === zoteroKey)
        );
        return doomed;
    }
}

async function sha256(text: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(text)
    );
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function sidecar(...parts: string[]): string {
    return join(storageDir, 'beaver', ...parts);
}

async function readHistory(): Promise<TableHistory> {
    return JSON.parse(await readFile(sidecar('history.json'), 'utf8'));
}

function demoSpec(text = 'One'): TableSpec {
    return {
        id: 'demo',
        title: 'Demo table',
        columns: [{ id: 'note', header: 'Note', type: 'text' }],
        rows: [
            {
                id: 'r1',
                cells: {
                    note: {
                        value: { kind: 'text', text },
                        provenance: 'asserted',
                    },
                },
            },
        ],
    };
}

function expectOk(result: TableWriteResult) {
    if (!result.ok) {
        throw new Error(`expected a write, got a conflict at ${result.version}`);
    }
    return result;
}

/** The version the stored document claims. */
async function storedVersion(): Promise<number | undefined> {
    const parsed = parseTableDocument(await readFile(htmlPath, 'utf8'));
    return parsed.ok ? parsed.spec.version : undefined;
}

/** The text in the stored document's only cell. */
async function storedText(): Promise<string | undefined> {
    const parsed = parseTableDocument(await readFile(htmlPath, 'utf8'));
    if (!parsed.ok) return undefined;
    const value = parsed.spec.rows[0]?.cells.note?.value;
    return value && value.kind === 'text' ? value.text : undefined;
}

/**
 * Replaces the whole storage directory with `spec` at `version`, the way Zotero
 * does when the user keeps the remote copy: document, log and version files all
 * from the same source, agreeing with each other and mentioning nothing about
 * what this device had.
 */
async function resolveConflictTowardRemote(
    spec: TableSpec,
    version: number
): Promise<void> {
    const stored = { ...spec, key: KEY, version };
    const serialized = JSON.stringify(stored);

    await mkdir(sidecar(), { recursive: true });
    await writeFile(sidecar(`v${version}.json`), serialized, 'utf8');

    const history = await readHistory().catch(() => ({ tip: 0, versions: [] }));
    const versions = history.versions.filter((entry) => entry.version < version);
    versions.push({
        version,
        actor: 'system',
        at: new Date().toISOString(),
        sha256: await sha256(serialized),
        summary: summarize(stored),
        change: 'Synced from another device',
        sealed: true,
    });
    await writeFile(
        sidecar('history.json'),
        JSON.stringify({ tip: version, versions }),
        'utf8'
    );

    for (const name of await readdir(sidecar())) {
        const match = /^v(\d+)\.json$/.exec(name);
        if (match && Number(match[1]) > version) await rm(sidecar(name));
    }

    await writeFile(htmlPath, buildTableDocument(stored).html, 'utf8');
}

beforeAll(() => {
    savedIOUtils = (globalThis as any).IOUtils;
    savedPathUtils = (globalThis as any).PathUtils;
    savedZotero = (globalThis as any).Zotero;
});

afterAll(() => {
    (globalThis as any).IOUtils = savedIOUtils;
    (globalThis as any).PathUtils = savedPathUtils;
    (globalThis as any).Zotero = savedZotero;
});

beforeEach(async () => {
    vi.clearAllMocks();
    checkLibraryExcluded.mockReturnValue(null);

    profileDir = await mkdtemp(join(tmpdir(), 'beaver-profile-'));
    storageDir = await mkdtemp(join(tmpdir(), 'beaver-table-'));
    htmlPath = join(storageDir, 'demo-table.html');

    db = new FakeShadowDB();

    (globalThis as any).IOUtils = { ...realIOUtils };
    (globalThis as any).PathUtils = { ...realPathUtils };

    item = {
        id: 102,
        key: KEY,
        libraryID: LIBRARY_ID,
        deleted: false,
        attachmentSyncState: 1,
        attachmentLinkMode: savedZotero.Attachments.LINK_MODE_IMPORTED_URL,
        attachmentContentType: 'text/html',
        isAttachment: () => true,
        isFileAttachment: () => true,
        isTopLevelItem: () => true,
        hasTag: (name: string) => name === TABLE_TAG,
        getField: (field: string) =>
            field === 'url' ? 'beaver://table/demo-table' : '',
        getFilePathAsync: async () => htmlPath,
        addTag: vi.fn(),
        attachmentFilename: 'demo-table.html',
        saveTx: vi.fn(async () => undefined),
    };

    (globalThis as any).Zotero = {
        ...savedZotero,
        Beaver: { db },
        Profile: { dir: profileDir },
        Libraries: {
            ...savedZotero.Libraries,
            userLibraryID: LIBRARY_ID,
            get: vi.fn((id: number) =>
                id === LIBRARY_ID
                    ? { libraryID: LIBRARY_ID, libraryType: 'user', editable: true }
                    : false
            ),
        },
        Items: {
            getByLibraryAndKey: vi.fn((libraryID: number, key: string) =>
                libraryID === LIBRARY_ID && key === KEY ? item : false
            ),
            loadDataTypes: vi.fn(async () => undefined),
        },
        Attachments: {
            ...savedZotero.Attachments,
            getStorageDirectory: vi.fn(() => ({ path: storageDir })),
            importFromSnapshotContent: vi.fn(
                async ({ snapshotContent }: { snapshotContent: string }) => {
                    await writeFile(htmlPath, snapshotContent, 'utf8');
                    return item;
                }
            ),
        },
        File: {
            ...savedZotero.File,
            getContentsAsync: vi.fn(async (path: string) => readFile(path, 'utf8')),
            putContentsAsync: vi.fn(async (path: string, text: string) =>
                writeFile(path, text, 'utf8')
            ),
        },
        FullText: { queueItem: vi.fn(async () => undefined) },
        Sync: {
            ...savedZotero.Sync,
            Storage: { Local: { SYNC_STATE_TO_UPLOAD: 0 } },
        },
        getMainWindow: vi.fn(() => null),
    };
});

afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
    await rm(profileDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

describe('recording what this device wrote', () => {
    it('records the created version, so the first state is recoverable too', async () => {
        const created = await createTable({ spec: demoSpec('Created') });

        const shadow = await lastTableShadow(ref);
        expect(shadow).toMatchObject({
            libraryID: LIBRARY_ID,
            key: KEY,
            version: 1,
            sha256: created.entry.sha256,
        });
        expect(shadow!.payloadPath).toBeTruthy();
        expect(existsSync(shadow!.payloadPath!)).toBe(true);
    });

    it('records every successful write, with the digest of the bytes it stored', async () => {
        await createTable({ spec: demoSpec('One') });
        const second = expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));
        const third = expectOk(await writeTable(ref, demoSpec('Three'), { actor: 'user' }));

        const entries = await readTableShadow(ref);
        expect(entries.map((entry) => entry.version)).toEqual([3, 2, 1]);
        expect(entries[0].sha256).toBe(third.entry.sha256);
        expect(entries[1].sha256).toBe(second.entry.sha256);
    });

    it('updates the row in place when a run collapses onto its own version', async () => {
        await createTable({ spec: demoSpec('One') });
        await writeTable(ref, demoSpec('Two'), { actor: 'agent', run_id: 'run-1' });
        const collapsed = expectOk(
            await writeTable(ref, demoSpec('Three'), { actor: 'agent', run_id: 'run-1' })
        );

        expect(collapsed.collapsed).toBe(true);
        const entries = await readTableShadow(ref);
        // One row for version 2, holding the newest content, not two.
        expect(entries.map((entry) => entry.version)).toEqual([2, 1]);
        expect(entries[0].sha256).toBe(collapsed.entry.sha256);
    });

    it('leaves one payload per version when a run collapses onto its own', async () => {
        await createTable({ spec: demoSpec('v1') });
        // The case the collapse rule exists for: a run filling a column cell by
        // cell. Every write has different bytes and so a different
        // content-addressed name, while the row it replaces keeps one path.
        for (const text of ['a', 'b', 'c', 'd', 'e']) {
            expectOk(await writeTable(ref, demoSpec(text), { actor: 'agent', run_id: 'run-1' }));
        }

        const entries = await readTableShadow(ref);
        expect(entries.map((entry) => entry.version)).toEqual([2, 1]);

        // Rows are not enough: the budget is computed from rows, so a payload
        // no row names is invisible to it and nothing else under the profile
        // would ever collect it.
        const onDisk = await readdir(
            join(profileDir, 'beaver', 'table-shadow', String(LIBRARY_ID))
        );
        expect(onDisk).toHaveLength(entries.length);
        for (const entry of entries) {
            expect(existsSync(entry.payloadPath!)).toBe(true);
        }
    });

    it('keeps a payload a retained version still points at', async () => {
        // A collapsing write that produces the bytes the version already holds
        // reuses the file. The row's path does not change, so the deletion rule
        // must recognise it as still referenced rather than take it away.
        await createTable({ spec: demoSpec('One') });
        expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'agent', run_id: 'run-1' }));
        const before = await readTableShadow(ref);
        const payload = before.find((entry) => entry.version === 2)!.payloadPath!;

        expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'agent', run_id: 'run-1' }));

        const after = await readTableShadow(ref);
        expect(after.find((entry) => entry.version === 2)!.payloadPath).toBe(payload);
        expect(existsSync(payload)).toBe(true);
    });

    it('does not fail a write when the shadow cannot be recorded', async () => {
        await createTable({ spec: demoSpec('One') });
        // The database going away mid-session: the table is already committed
        // by the time the shadow is written, so the write must still succeed.
        (globalThis as any).Zotero.Beaver = undefined;

        const written = expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));

        expect(written.version).toBe(2);
        expect(await storedVersion()).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

describe('the storage budget', () => {
    it('keeps only the last few versions, and deletes the payloads it drops', async () => {
        await createTable({ spec: demoSpec('v1') });
        for (const text of ['v2', 'v3', 'v4', 'v5', 'v6']) {
            expectOk(await writeTable(ref, demoSpec(text), { actor: 'user' }));
        }

        const entries = await readTableShadow(ref);
        expect(entries).toHaveLength(TABLE_SHADOW_RETENTION);
        expect(entries.map((entry) => entry.version)).toEqual([6, 5, 4]);

        // The dropped versions' payloads are gone, not merely unreferenced: the
        // shadow lives under the profile, where nothing else would collect it.
        const kept = new Set(entries.map((entry) => entry.payloadPath));
        const onDisk = await readdir(
            join(profileDir, 'beaver', 'table-shadow', String(LIBRARY_ID))
        );
        expect(onDisk).toHaveLength(TABLE_SHADOW_RETENTION);
        for (const name of onDisk) {
            expect(
                kept.has(join(profileDir, 'beaver', 'table-shadow', String(LIBRARY_ID), name))
            ).toBe(true);
        }
    });

    it('forgets a table entirely when it is deleted', async () => {
        await createTable({ spec: demoSpec('One') });
        expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));
        const before = await readTableShadow(ref);
        expect(before.length).toBeGreaterThan(0);

        await deleteTable(ref);

        expect(await readTableShadow(ref)).toEqual([]);
        for (const entry of before) {
            expect(existsSync(entry.payloadPath!)).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('detecting a table that went backwards', () => {
    it('reports nothing on an ordinary open', async () => {
        // The one that matters. Every open of every table runs this comparison,
        // and the shadow's digest is over the bytes the store wrote while the
        // open's is over the spec parsed back out of the document — so this is
        // also the assertion that the document round-trips exactly.
        await createTable({ spec: demoSpec('One') });
        expect((await openTable(ref)).conflict).toBeNull();

        expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));
        const opened = await openTable(ref);

        expect(opened.conflict).toBeNull();
        expect(opened.recovered).toEqual([]);
        expect(opened.version).toBe(2);
    });

    it('reports nothing when the table is ahead of this device', async () => {
        await createTable({ spec: demoSpec('One') });
        expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));
        // Another device wrote after us and the sync brought it down cleanly.
        await resolveConflictTowardRemote(demoSpec('Theirs'), 5);

        expect((await openTable(ref)).conflict).toBeNull();
    });

    it('reports a conflict when the table is at a lower version than this device wrote', async () => {
        await createTable({ spec: demoSpec('One') });
        expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));
        expectOk(await writeTable(ref, demoSpec('Three'), { actor: 'user' }));

        await resolveConflictTowardRemote(demoSpec('Two'), 2);
        const opened = await openTable(ref);

        expect(opened.conflict).toMatchObject({
            kind: 'sync_conflict',
            reason: 'behind',
            documentVersion: 2,
            shadowVersion: 3,
            restorable: true,
        });
        // Not folded in with the repairs: nothing was repaired, and the store
        // is not going to decide this one.
        expect(opened.recovered).toEqual([]);
    });

    it('reports a conflict when the version is the same but the content is not', async () => {
        await createTable({ spec: demoSpec('One') });
        expectOk(await writeTable(ref, demoSpec('Mine'), { actor: 'user' }));

        // Both devices numbered their edit 2; the conflict kept the other one.
        await resolveConflictTowardRemote(demoSpec('Theirs'), 2);
        const opened = await openTable(ref);

        expect(opened.conflict).toMatchObject({
            kind: 'sync_conflict',
            reason: 'diverged',
            documentVersion: 2,
            shadowVersion: 2,
        });
        expect(opened.conflict!.documentSha256).not.toBe(opened.conflict!.shadowSha256);
    });

    it('says nothing about a table this device never wrote to', () => {
        expect(
            detectTableSyncConflict(null, { version: 1, sha256: 'anything' })
        ).toBeNull();
    });

    it('judges an observation with no digest on its version alone', () => {
        const shadow = {
            libraryID: LIBRARY_ID,
            key: KEY,
            version: 4,
            sha256: 'ours',
            writtenAt: '2026-08-30T12:00:00.000Z',
            payloadPath: '/tmp/whatever.json.gz',
            payloadBytes: 10,
        };

        // Same number, no digest to compare: silence, because guessing here
        // would put a warning on tables nothing happened to.
        expect(detectTableSyncConflict(shadow, { version: 4, sha256: null })).toBeNull();
        expect(detectTableSyncConflict(shadow, { version: 3, sha256: null })).toMatchObject(
            { reason: 'behind' }
        );
    });
});

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

describe('restoring this device\'s version', () => {
    it('writes it back as a new version and leaves the conflicting one in the log', async () => {
        await createTable({ spec: demoSpec('One') });
        expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));
        expectOk(await writeTable(ref, demoSpec('Mine'), { actor: 'user' }));

        await resolveConflictTowardRemote(demoSpec('Theirs'), 2);
        const result = await restoreShadowVersion(ref);

        expect(result).toMatchObject({ ok: true, restoredFrom: 3, version: 3 });
        expect(await storedText()).toBe('Mine');
        expect(await storedVersion()).toBe(3);

        // The state the conflict left behind keeps its number and stays
        // revertable — the restore adds, it does not erase.
        const history = await readHistory();
        expect(history.versions.map((entry) => entry.version)).toEqual([1, 2, 3]);
        const theirs = JSON.parse(await readFile(sidecar('v2.json'), 'utf8'));
        expect(theirs.rows[0].cells.note.value.text).toBe('Theirs');

        // And the table is no longer reported as conflicted.
        expect((await openTable(ref)).conflict).toBeNull();
    });

    it('refuses rather than half-succeeding when the retained spec is gone', async () => {
        await createTable({ spec: demoSpec('One') });
        expectOk(await writeTable(ref, demoSpec('Mine'), { actor: 'user' }));
        await resolveConflictTowardRemote(demoSpec('Theirs'), 2);

        const shadow = await lastTableShadow(ref);
        await rm(shadow!.payloadPath!);

        const result = await restoreShadowVersion(ref);

        expect(result).toMatchObject({ ok: false, code: 'no_payload', version: 2 });
        // Nothing was written: the table is still the other device's copy.
        expect(await storedText()).toBe('Theirs');
        expect(await storedVersion()).toBe(2);
    });

    it('says so when this device never wrote to the table', async () => {
        await createTable({ spec: demoSpec('One') });
        await db.deleteTableShadows(LIBRARY_ID, KEY);

        expect(await restoreShadowVersion(ref)).toMatchObject({
            ok: false,
            code: 'no_shadow',
        });
    });
});

// ---------------------------------------------------------------------------
// The item-pane section
// ---------------------------------------------------------------------------

/**
 * The section reaches the same verdict the store does, because it has to: it is
 * the surface that tells the user another device replaced their work, and it
 * runs on every table they select.
 */
describe('what the item-pane section reports', () => {
    /**
     * Commits a version and loses the log write, which is what an interrupted
     * write leaves behind: the document is the new version, the log is a
     * version behind it, and the next open repairs that silently.
     */
    async function commitWithoutTheLog(text: string): Promise<void> {
        const move = (globalThis as any).IOUtils.move;
        (globalThis as any).IOUtils.move = async (from: string, to: string) => {
            if (to === sidecar('history.json')) throw new Error('disk is full');
            return move(from, to);
        };
        try {
            expectOk(await writeTable(ref, demoSpec(text), { actor: 'user' }));
        } finally {
            (globalThis as any).IOUtils.move = move;
        }
    }

    it('says nothing when a write landed but its log entry did not', async () => {
        await createTable({ spec: demoSpec('One') });
        expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));
        await commitWithoutTheLog('Three');

        // The log's word for the tip is 2 and this device wrote 3 — which,
        // taken from the log, reads as a table that went backwards. It did not:
        // the document is at 3.
        expect((await readHistory()).tip).toBe(2);
        expect((await lastTableShadow(ref))!.version).toBe(3);
        expect(await storedVersion()).toBe(3);

        const data = await readTableSectionData(item);
        expect(data.fields.conflict).toBeNull();
    });

    it('reports a table a sync conflict really did take back', async () => {
        await createTable({ spec: demoSpec('One') });
        expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));
        expectOk(await writeTable(ref, demoSpec('Three'), { actor: 'user' }));

        await resolveConflictTowardRemote(demoSpec('Theirs'), 2);

        const data = await readTableSectionData(item);
        expect(data.fields.conflict).toMatchObject({
            reason: 'behind',
            documentVersion: 2,
            shadowVersion: 3,
            restorable: true,
        });
    });

    it('reports two devices that numbered the same edit in parallel', async () => {
        await createTable({ spec: demoSpec('One') });
        expectOk(await writeTable(ref, demoSpec('Mine'), { actor: 'user' }));

        await resolveConflictTowardRemote(demoSpec('Theirs'), 2);

        const data = await readTableSectionData(item);
        expect(data.fields.conflict).toMatchObject({
            reason: 'diverged',
            documentVersion: 2,
            shadowVersion: 2,
        });
    });

    it('says nothing on an ordinary table, without reading the document', async () => {
        await createTable({ spec: demoSpec('One') });
        expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));

        const reads: string[] = [];
        const getContentsAsync = (globalThis as any).Zotero.File.getContentsAsync;
        (globalThis as any).Zotero.File.getContentsAsync = async (path: string) => {
            reads.push(path);
            return getContentsAsync(path);
        };

        const data = await readTableSectionData(item);

        expect(data.fields.conflict).toBeNull();
        // The log answered it. Parsing the megabyte of JSON in the document on
        // every selection is the cost this screen exists to avoid.
        expect(reads).not.toContain(htmlPath);
    });
});
