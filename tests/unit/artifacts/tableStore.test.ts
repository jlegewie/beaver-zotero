import { handleArtifactRequest } from '../../../src/services/artifacts/artifactProvider';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
import {
    buildTableDocument,
    parseTableDocument,
} from '../../../src/services/artifacts/tableDocument';
import { TABLE_TAG } from '../../../src/services/artifacts/tableItem';
import {
    createTable,
    editTable,
    listVersions,
    openTable,
    readTable,
    revertTable,
    writeTable,
    trimTable,
    TABLE_VERSION_RETENTION,
    type TableHistory,
    type TableWriteResult,
} from '../../../src/services/artifacts/tableStore';
import { tableWriteLocks } from '../../../src/services/artifacts/tablesApi';
import * as recoveryShadow from '../../../src/services/artifacts/recoveryShadow';

// ---------------------------------------------------------------------------
// A temp directory standing in for the attachment's storage directory
// ---------------------------------------------------------------------------

const LIBRARY_ID = 1;
const KEY = 'TBLABCDE';

let storageDir: string;
let htmlPath: string;
let item: any;
let savedIOUtils: any;
let savedPathUtils: any;
let savedZotero: any;

/** Real file I/O, so the temp-file-and-rename protocol is actually exercised. */
const realIOUtils = {
    exists: async (path: string) => existsSync(path),
    readUTF8: async (path: string) => readFile(path, 'utf8'),
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

/** The digest the store records, computed the same way. */
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

/**
 * Seeds the storage directory with the document and no sidecar at all — the
 * state a table synced from a device whose log did not travel arrives in, and
 * what the write path has to reconcile rather than write over.
 */
async function seedTable(version = 1): Promise<void> {
    const document = buildTableDocument({ ...demoSpec(), key: KEY, version });
    await writeFile(htmlPath, document.html, 'utf8');
}

/** The version the stored document claims. */
async function storedVersion(): Promise<number | undefined> {
    const parsed = parseTableDocument(await readFile(htmlPath, 'utf8'));
    return parsed.ok ? parsed.spec.version : undefined;
}

/** Commits a version straight to the HTML, as an interrupted write would. */
async function bumpStoredDocument(): Promise<void> {
    const parsed = parseTableDocument(await readFile(htmlPath, 'utf8'));
    if (!parsed.ok) throw new Error('stored document is unreadable');
    const next = { ...parsed.spec, version: (parsed.spec.version ?? 0) + 1 };
    await writeFile(htmlPath, buildTableDocument(next).html, 'utf8');
}

const ref = { libraryID: LIBRARY_ID, key: KEY };

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

    storageDir = await mkdtemp(join(tmpdir(), 'beaver-table-'));
    htmlPath = join(storageDir, 'demo-table.html');

    (globalThis as any).IOUtils = { ...realIOUtils };
    (globalThis as any).PathUtils = { ...realPathUtils };

    item = {
        id: 101,
        key: KEY,
        libraryID: LIBRARY_ID,
        deleted: false,
        attachmentSyncState: 1,
        attachmentLinkMode: savedZotero.Attachments.LINK_MODE_IMPORTED_URL,
        attachmentContentType: 'text/html',
        isAttachment: () => true,
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
            getByLibraryAndKey: vi.fn(
                (libraryID: number, key: string) =>
                    libraryID === LIBRARY_ID && key === KEY ? item : false
            ),
            loadDataTypes: vi.fn(async () => undefined),
        },
        Attachments: {
            ...savedZotero.Attachments,
            getStorageDirectory: vi.fn(() => ({ path: storageDir })),
            // Stands in for the real import: writes the first render and hands
            // back the attachment Zotero would have created.
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
        // No runtime on the test global: the store must degrade silently when
        // it has no one to publish table-updated notifications to.
        getMainWindow: vi.fn(() => null),
        Beaver: undefined,
    };

    await seedTable();
});

afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
});

function expectOk(result: TableWriteResult) {
    if (!result.ok) throw new Error(`expected a write, got a conflict at ${result.version}`);
    return result;
}

// ---------------------------------------------------------------------------

describe('createTable', () => {
    it('starts the version log at 1, with a version file beside it', async () => {
        const created = await createTable({ spec: demoSpec('Created') });

        expect(created.version).toBe(1);
        expect(created.entry).toMatchObject({
            version: 1,
            actor: 'agent',
            change: 'Created the table',
        });
        expect(created.entry.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(created.entry.summary.rows).toBe(1);

        const history = await readHistory();
        expect(history.tip).toBe(1);
        expect(history.versions.map((v) => v.version)).toEqual([1]);

        const seeded = JSON.parse(await readFile(sidecar('v1.json'), 'utf8'));
        expect(seeded).toEqual(created.spec);
    });

    it('seals version 1 so the creating run cannot collapse onto it', async () => {
        // The shape a real agent creation has: the run that creates the table
        // is the run that immediately fills it, and without sealing its first
        // write would overwrite `v1.json` in place.
        const created = await createTable({
            spec: demoSpec('Created'),
            actor: 'agent',
            run_id: 'run-1',
        });
        expect(created.entry).toMatchObject({ run_id: 'run-1', sealed: true });

        const edited = await editTable(
            ref,
            [{ op: 'set_meta', title: 'Filled in' }],
            { actor: 'agent', run_id: 'run-1' }
        );

        expect(edited.ok).toBe(true);
        if (!edited.ok) return;
        expect(edited.version).toBe(2);
        expect(edited.collapsed).toBe(false);
        expect((await listVersions(ref)).map((v) => v.version)).toEqual([1, 2]);

        const reverted = expectOk(await revertTable(ref, 1, { actor: 'user' }));

        expect(reverted.version).toBe(3);
        const { spec } = await readTable(ref);
        expect(spec.title).toBe(created.spec.title);
        expect(spec.rows[0].cells.note?.value).toMatchObject({ text: 'Created' });
    });
});

describe('the single-flight write lock', () => {
    it('serialises two writes made through separate module instances', async () => {
        // The lock registry lives on the shared global rather than in the
        // store's module scope, so it is one lock per *process* however the
        // module is bundled. A second instance stands in for the second bundle:
        // with a module-local map each edit would read version 1, both would
        // write version 2, and one caller's mutation would be gone from the
        // file while both were told they succeeded.
        vi.resetModules();
        const second = await import('../../../src/services/artifacts/tableStore');
        expect(second.editTable).not.toBe(editTable);

        await createTable({ spec: demoSpec('Created') });

        const [first, other] = await Promise.all([
            editTable(ref, [{ op: 'set_meta', title: 'From instance A' }], {
                actor: 'user',
            }),
            second.editTable(
                ref,
                [{ op: 'set_meta', caption: 'From instance B' }],
                { actor: 'user' }
            ),
        ]);

        expect(first.ok && other.ok).toBe(true);
        if (!first.ok || !other.ok) return;
        // Two versions, not one number issued twice.
        expect([first.version, other.version].sort()).toEqual([2, 3]);

        // Neither edit was derived from a stale read, so both survive.
        const { spec } = await readTable(ref);
        expect(spec.title).toBe('From instance A');
        expect(spec.caption).toBe('From instance B');
        expect((await listVersions(ref)).map((v) => v.version)).toEqual([1, 2, 3]);
    });

    it('shares one registry across module instances', async () => {
        vi.resetModules();
        const api = await import('../../../src/services/artifacts/tablesApi');
        expect(api.tableWriteLocks()).toBe(tableWriteLocks());
    });
});

describe('writeTable', () => {
    it('stamps the item key and the new version into the stored spec', async () => {
        const written = expectOk(
            await writeTable(ref, { ...demoSpec(), key: 'LIES', version: 99 }, {
                actor: 'agent',
            })
        );

        expect(written.version).toBe(2);
        expect(written.spec.key).toBe(KEY);
        expect(written.spec.version).toBe(2);
        expect(await storedVersion()).toBe(2);
    });

    it('marks the attachment for upload and saves it, so the change syncs', async () => {
        const written = expectOk(await writeTable(ref, demoSpec(), { actor: 'agent' }));

        expect(item.attachmentSyncState).toBe(0);
        expect(item.saveTx).toHaveBeenCalledTimes(1);
        expect(written.saved).toBe(true);
    });

    it('reports a post-commit save failure without failing the write', async () => {
        item.saveTx = vi.fn(async () => {
            throw new Error('database is locked');
        });

        const written = expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));

        // The table is on disk, so the caller must not retry: doing so would
        // apply the same mutations twice.
        expect(written.saved).toBe(false);
        expect(written.version).toBe(2);
        expect(await storedVersion()).toBe(2);
        expect((await readHistory()).tip).toBe(2);
    });

    it('reports a version log that could not be written without failing the write', async () => {
        // A full or read-only disk, hit only by the log. The document has
        // already landed at that point, so rejecting would tell the caller its
        // mutations did not apply when they did — and a retrying agent would
        // apply them to a table that already has them.
        expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));

        const move = (globalThis as any).IOUtils.move;
        (globalThis as any).IOUtils.move = async (from: string, to: string) => {
            if (to === sidecar('history.json')) throw new Error('disk is full');
            return move(from, to);
        };

        const written = expectOk(await writeTable(ref, demoSpec('Three'), { actor: 'user' }));

        expect(written.saved).toBe(false);
        expect(written.version).toBe(3);
        expect(await storedVersion()).toBe(3);
        // The log is behind the document, which is the state openTable repairs.
        expect((await readHistory()).tip).toBe(2);
    });

    it('reports a collapsing write whose version file could not be rewritten', async () => {
        await writeTable(ref, demoSpec('Two'), { actor: 'agent', run_id: 'run-1' });

        // A collapsing write writes its version file *after* the document, so
        // this failure is past the commit point too.
        const move = (globalThis as any).IOUtils.move;
        (globalThis as any).IOUtils.move = async (from: string, to: string) => {
            if (to === sidecar('v2.json')) throw new Error('disk is full');
            return move(from, to);
        };

        const written = expectOk(
            await writeTable(ref, demoSpec('Three'), { actor: 'agent', run_id: 'run-1' })
        );

        expect(written.saved).toBe(false);
        expect(written.collapsed).toBe(true);
        expect(await storedVersion()).toBe(2);
    });

    it('records a summary and a digest of the spec it wrote', async () => {
        const written = expectOk(
            await writeTable(ref, demoSpec(), { actor: 'user', change: 'Renamed' })
        );

        expect(written.entry).toMatchObject({
            version: 2,
            actor: 'user',
            change: 'Renamed',
        });
        expect(written.entry.summary.rows).toBe(1);
        expect(written.entry.sha256).toMatch(/^[0-9a-f]{64}$/);
        const stored = JSON.parse(await readFile(sidecar('v2.json'), 'utf8'));
        expect(stored.version).toBe(2);
    });

    it('collapses a second write from the same run onto the version it owns', async () => {
        const first = expectOk(
            await writeTable(ref, demoSpec('One'), { actor: 'agent', run_id: 'run-1' })
        );
        const second = expectOk(
            await writeTable(ref, demoSpec('Two'), { actor: 'agent', run_id: 'run-1' })
        );

        expect(first.version).toBe(2);
        expect(first.collapsed).toBe(false);
        expect(second.version).toBe(2);
        expect(second.collapsed).toBe(true);

        const history = await readHistory();
        expect(history.tip).toBe(2);
        // 1 is the fixture's un-logged starting version, reconstructed by the
        // first write; the two run writes share 2.
        expect(history.versions.map((v) => v.version)).toEqual([1, 2]);
        expect(await storedVersion()).toBe(2);
    });

    it('appends once another writer has taken a version above the run', async () => {
        await writeTable(ref, demoSpec('One'), { actor: 'agent', run_id: 'run-1' });
        await writeTable(ref, demoSpec('Two'), { actor: 'agent', run_id: 'run-2' });

        const back = expectOk(
            await writeTable(ref, demoSpec('Three'), { actor: 'agent', run_id: 'run-1' })
        );

        // The run no longer owns the tip, so its number cannot be reused.
        expect(back.version).toBe(4);
        expect(back.collapsed).toBe(false);
    });

    it('gives every user edit its own version, even inside a run', async () => {
        await writeTable(ref, demoSpec('One'), { actor: 'agent', run_id: 'run-1' });
        const edit = expectOk(
            await writeTable(ref, demoSpec('Two'), { actor: 'user', run_id: 'run-1' })
        );
        const another = expectOk(
            await writeTable(ref, demoSpec('Three'), { actor: 'user', run_id: 'run-1' })
        );

        expect(edit.version).toBe(3);
        expect(another.version).toBe(4);
        expect([edit.collapsed, another.collapsed]).toEqual([false, false]);
    });

    it('refuses a write guarded by a stale version and hands back the current table', async () => {
        await writeTable(ref, demoSpec('One'), { actor: 'agent' });

        const result = await writeTable(ref, demoSpec('Two'), { actor: 'agent' }, 1);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.conflict).toBe(true);
        expect(result.version).toBe(2);
        expect(result.spec?.rows[0].cells.note?.value).toMatchObject({ text: 'One' });
        // Nothing moved.
        expect(await storedVersion()).toBe(2);
    });

    it('trims the oldest entries past the retention cap and deletes their files', async () => {
        const total = TABLE_VERSION_RETENTION + 5;
        let last = 0;
        let pruned: number[] = [];
        for (let i = 0; i < total; i++) {
            const written = expectOk(
                await writeTable(ref, demoSpec(`v${i}`), { actor: 'user' })
            );
            last = written.version;
            pruned = written.pruned;
        }

        const history = await readHistory();
        expect(history.tip).toBe(last);
        expect(history.versions).toHaveLength(TABLE_VERSION_RETENTION);
        expect(history.versions[0].version).toBe(last - TABLE_VERSION_RETENTION + 1);
        // Oldest first: the final write dropped exactly one, the one that fell out.
        expect(pruned).toEqual([last - TABLE_VERSION_RETENTION]);

        const files = await readdir(sidecar());
        expect(files).toContain(`v${history.versions[0].version}.json`);
        expect(files).not.toContain(`v${history.versions[0].version - 1}.json`);
        expect(files.filter((name) => name.startsWith('v'))).toHaveLength(
            TABLE_VERSION_RETENTION
        );
    });

    it('serialises two writes started at the same moment', async () => {
        // Both are in flight before either is awaited: without the lock they
        // would read the same tip and both claim version 2.
        const first = writeTable(ref, demoSpec('One'), { actor: 'user' });
        const second = writeTable(ref, demoSpec('Two'), { actor: 'user' });
        const [a, b] = await Promise.all([first, second]);

        expect([expectOk(a).version, expectOk(b).version].sort()).toEqual([2, 3]);
        expect(await storedVersion()).toBe(3);
        const history = await readHistory();
        expect(history.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    });

    it('reconstructs the entry for a version the log is missing before appending', async () => {
        // The fixture's version 1 has no log entry and no `v1.json`.
        const written = expectOk(
            await writeTable(ref, demoSpec('Two'), { actor: 'user' })
        );

        expect(written.version).toBe(2);
        const history = await readHistory();
        expect(history.versions.map((v) => v.version)).toEqual([1, 2]);
        expect(history.versions[0]).toMatchObject({
            version: 1,
            actor: 'system',
            change: 'Recovered from an interrupted write',
        });
        // Reconstructed, so version 1 is revertable rather than lost.
        expect(existsSync(sidecar('v1.json'))).toBe(true);
        expect(expectOk(await revertTable(ref, 1, { actor: 'user' })).version).toBe(3);
    });

    it('refuses to write a table in an excluded library', async () => {
        checkLibraryExcluded.mockReturnValue({ message: 'That library is excluded.' });

        await expect(writeTable(ref, demoSpec(), { actor: 'agent' })).rejects.toMatchObject(
            { code: 'library_excluded' }
        );
    });
});

describe('editTable', () => {
    it('applies mutations to the stored spec and re-renders the document', async () => {
        const result = await editTable(
            ref,
            [{ op: 'set_meta', title: 'Renamed' }],
            { actor: 'user' }
        );

        expect(result.ok).toBe(true);
        const { spec, version } = await readTable(ref);
        expect(spec.title).toBe('Renamed');
        expect(version).toBe(2);
    });

    it('returns the apply error unchanged when the mutation itself is invalid', async () => {
        const result = await editTable(
            ref,
            [{ op: 'remove_columns', columns: ['nope'] }],
            { actor: 'user' }
        );

        expect(result).toEqual({
            ok: false,
            error: {
                code: 'unknown_column',
                message: 'remove_columns: column "nope" does not exist',
            },
        });
        // Nothing was written.
        expect(await storedVersion()).toBe(1);
    });

    it('keeps both mutations when two edits of the same run start together', async () => {
        // The case a read outside the lock loses: both edits read the same
        // spec, both pass the version they saw, and both collapse onto it — so
        // whichever writes second silently erases the other's column.
        await writeTable(ref, demoSpec('One'), { actor: 'agent', run_id: 'run-1' });

        const first = editTable(
            ref,
            [{ op: 'add_columns', columns: [{ id: 'a', header: 'A', type: 'text' }] }],
            { actor: 'agent', run_id: 'run-1' }
        );
        const second = editTable(
            ref,
            [{ op: 'add_columns', columns: [{ id: 'b', header: 'B', type: 'text' }] }],
            { actor: 'agent', run_id: 'run-1' }
        );
        const [a, b] = await Promise.all([first, second]);

        expect([a.ok, b.ok]).toEqual([true, true]);
        const { spec } = await readTable(ref);
        expect(spec.columns.map((c) => c.id)).toEqual(['note', 'a', 'b']);
        // Both collapsed onto the run's working version, and the log agrees
        // with the file it points at.
        expect((await readHistory()).versions.map((v) => v.version)).toEqual([1, 2]);
        const stored = JSON.parse(await readFile(sidecar('v2.json'), 'utf8'));
        expect(stored.columns.map((c: { id: string }) => c.id)).toEqual([
            'note',
            'a',
            'b',
        ]);
    });
});

describe('revertTable', () => {
    it('stores an earlier version again as a new one rather than rewinding', async () => {
        await writeTable(ref, demoSpec('One'), { actor: 'user' });
        await writeTable(ref, demoSpec('Two'), { actor: 'user' });

        const reverted = expectOk(await revertTable(ref, 2, { actor: 'user' }));

        expect(reverted.version).toBe(4);
        expect(reverted.entry.change).toBe('Reverted to version 2');
        const { spec } = await readTable(ref);
        expect(spec.rows[0].cells.note?.value).toMatchObject({ text: 'One' });
        expect((await listVersions(ref)).map((v) => v.version)).toEqual([1, 2, 3, 4]);
    });

    it('refuses a version whose file no longer matches what the log recorded', async () => {
        await writeTable(ref, demoSpec('One'), { actor: 'user' });
        await writeTable(ref, demoSpec('Two'), { actor: 'user' });
        // Not the tip, so `openTable`'s repair does not cover it: a revert is
        // the only thing that would have read it, and it must not.
        await writeFile(
            sidecar('v2.json'),
            JSON.stringify({ ...demoSpec('Tampered'), key: KEY, version: 2 }),
            'utf8'
        );

        await expect(revertTable(ref, 2, { actor: 'user' })).rejects.toMatchObject({
            code: 'version_corrupt',
        });
        // Nothing was restored.
        expect((await readTable(ref)).spec.rows[0].cells.note?.value).toMatchObject({
            text: 'Two',
        });
    });

    it('refuses a version it has no file for', async () => {
        await expect(revertTable(ref, 7, { actor: 'user' })).rejects.toMatchObject({
            code: 'not_found',
        });
    });
});

describe('openTable recovery', () => {
    it('appends the missing entry when the document is ahead of the log', async () => {
        await writeTable(ref, demoSpec('One'), { actor: 'user' });
        // A write that committed the HTML and stopped before the log rewrite.
        await bumpStoredDocument();

        const opened = await openTable(ref);

        expect(opened.version).toBe(3);
        expect(opened.recovered).toContainEqual({
            kind: 'history_appended',
            version: 3,
        });
        expect(opened.history.map((v) => v.version)).toEqual([1, 2, 3]);
        // The version file the interrupted write never got to keep.
        expect(existsSync(sidecar('v3.json'))).toBe(true);
    });

    it('deletes only the version files above the commit point', async () => {
        await writeTable(ref, demoSpec('One'), { actor: 'user' });
        // Above the tip: it can only come from a write that never committed.
        await writeFile(sidecar('v9.json'), JSON.stringify(demoSpec()), 'utf8');

        const opened = await openTable(ref);

        expect(opened.recovered).toContainEqual({
            kind: 'orphan_removed',
            versions: [9],
        });
        expect(existsSync(sidecar('v9.json'))).toBe(false);
        expect(opened.version).toBe(2);
    });

    it('adopts a version file below the tip that the log has lost', async () => {
        await writeTable(ref, demoSpec('One'), { actor: 'user' });
        // The log forgets version 1 while its file stays: a state the user can
        // still get back, so it must be rebuilt into the log, not deleted.
        const history = await readHistory();
        await writeFile(
            sidecar('history.json'),
            JSON.stringify({
                tip: 2,
                versions: history.versions.filter((v) => v.version === 2),
            }),
            'utf8'
        );

        const opened = await openTable(ref);

        expect(opened.recovered).toContainEqual({
            kind: 'history_adopted',
            versions: [1],
        });
        expect(existsSync(sidecar('v1.json'))).toBe(true);
        expect(opened.history.map((v) => v.version)).toEqual([1, 2]);
        // Adopted entries are sealed: nobody can say who wrote them.
        expect(opened.history[0]).toMatchObject({ actor: 'system', sealed: true });
        expect(expectOk(await revertTable(ref, 1, { actor: 'user' })).version).toBe(3);
    });

    it('rebuilds the log from the document and its files when history.json is gone', async () => {
        await writeTable(ref, demoSpec('One'), { actor: 'user' });
        await rm(sidecar('history.json'));

        const opened = await openTable(ref);

        expect(opened.version).toBe(2);
        // Version 2 from the document, version 1 adopted from its own file —
        // losing the log must not lose a state that is still on disk.
        expect(opened.history.map((v) => v.version)).toEqual([1, 2]);
        expect(opened.recovered).toContainEqual({
            kind: 'history_appended',
            version: 2,
        });
        expect(opened.recovered).toContainEqual({
            kind: 'history_adopted',
            versions: [1],
        });
        expect(existsSync(sidecar('v1.json'))).toBe(true);
    });

    it('repairs the tip version file when it disagrees with its entry', async () => {
        await writeTable(ref, demoSpec('One'), { actor: 'user' });
        // What a collapsing write interrupted between its two renames leaves.
        await writeFile(
            sidecar('v2.json'),
            JSON.stringify({ ...demoSpec('Tampered'), key: KEY, version: 2 }),
            'utf8'
        );

        const opened = await openTable(ref);

        expect(opened.recovered).toContainEqual({
            kind: 'version_file_repaired',
            version: 2,
        });
        // The document is authoritative, so the file is made to match it.
        const repaired = JSON.parse(await readFile(sidecar('v2.json'), 'utf8'));
        expect(repaired.rows[0].cells.note.value.text).toBe('One');
        expect(await sha256(JSON.stringify(repaired))).toBe(
            opened.history[opened.history.length - 1].sha256
        );
    });

    it('reports nothing to recover on a table that was written cleanly', async () => {
        await writeTable(ref, demoSpec('One'), { actor: 'user' });

        const opened = await openTable(ref);

        expect(opened.recovered).toEqual([]);
        expect(opened.version).toBe(2);
    });
});

describe('addressing', () => {
    it('refuses a key that is not in the library', async () => {
        await expect(
            readTable({ libraryID: LIBRARY_ID, key: 'MISSING1' })
        ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('refuses an item that is not one of ours', async () => {
        item.getField = () => 'https://example.org';

        await expect(readTable(ref)).rejects.toMatchObject({ code: 'not_a_table' });
    });
});

describe('remote writes', () => {
    const meta = { actor: 'agent' as const, run_id: 'run', thread_id: 'thread' };

    it('refuses two same-run precomputed writes from the same collapsed base', async () => {
        await writeTable(ref, demoSpec('base'), meta);
        const base = await openTable(ref);
        const results = await Promise.all(
            ['first', 'second'].map((id) =>
                writeTable(ref, demoSpec(id), meta, base.version, {
                    operation_id: id,
                    expected_sha256: base.sha256,
                })
            )
        );
        expect(results[0]).toMatchObject({ ok: true, collapsed: true, version: base.version });
        expect(results[1]).toMatchObject({ ok: false, conflict: true, version: base.version });
        expect((await openTable(ref)).spec.rows[0].cells.note.value).toMatchObject({
            text: 'first',
        });
    });

    it('replays the original acknowledgement after intervening writes and module state loss', async () => {
        const base = await openTable(ref);
        const remote = { operation_id: 'first', expected_sha256: base.sha256 };
        const first = await writeTable(ref, demoSpec('first'), meta, base.version, remote);
        await writeTable(ref, demoSpec('user'), { actor: 'user' });
        tableWriteLocks().clear();
        const replay = await writeTable(ref, demoSpec('first'), meta, base.version, remote);
        expect(replay).toMatchObject({ ok: true, replayed: true, version: 3 });
        if (!first.ok || !replay.ok) throw new Error('write failed');
        expect(replay.operation).toEqual(first.operation);
        expect(replay.spec.rows[0].cells.note.value).toMatchObject({ text: 'user' });
        expect(await listVersions(ref)).toHaveLength(3);
    });

    it('reads replay receipts and the spec from one snapshot when sync replaces the file', async () => {
        const base = await openTable(ref);
        const beforeWrite = await readFile(htmlPath, 'utf8');
        const remote = { operation_id: 'snapshot-replay', expected_sha256: base.sha256 };
        const first = expectOk(await writeTable(ref, demoSpec('committed'), meta, base.version, remote));
        vi.mocked(Zotero.File.getContentsAsync).mockImplementationOnce(async (path: any) => {
            const snapshot = await readFile(path, 'utf8');
            // A sync replacement after the read must not replace just the ledger
            // in the CurrentState assembled from that snapshot.
            await writeFile(htmlPath, beforeWrite);
            return snapshot;
        });
        const replay = expectOk(await writeTable(ref, demoSpec('committed'), meta, base.version, remote));
        expect(replay).toMatchObject({ replayed: true, version: first.version, operation: first.operation });
        expect(replay.spec).toEqual(first.spec);
        expect(await readFile(htmlPath, 'utf8')).toBe(beforeWrite);
    });

    it('refuses reuse of an operation identity with different content', async () => {
        const base = await openTable(ref);
        const remote = { operation_id: 'first', expected_sha256: base.sha256 };
        await writeTable(ref, demoSpec('first'), meta, base.version, remote);
        await expect(
            writeTable(ref, demoSpec('different'), meta, base.version, remote)
        ).rejects.toMatchObject({ code: 'operation_mismatch' });
    });

    it('ignores caller stamps and JSON object key order in retry identity', async () => {
        const base = await openTable(ref);
        const remote = { operation_id: 'first', expected_sha256: base.sha256 };
        await writeTable(ref, demoSpec(), meta, base.version, remote);
        const spec = demoSpec();
        const reordered = {
            rows: spec.rows,
            columns: spec.columns,
            title: spec.title,
            id: spec.id,
            key: 'OTHER',
            version: 999,
        };
        expect(await writeTable(ref, reordered, meta, base.version, remote)).toMatchObject({
            ok: true,
            replayed: true,
        });
    });

    it.each([false, true])('reports retention pruning during replay even if a later save fails: %s', async (failSave) => {
        await createTable({ spec: demoSpec(), actor: 'user' });
        for (let version = 2; version <= TABLE_VERSION_RETENTION; version++) {
            await writeTable(ref, demoSpec(String(version)), { actor: 'user' });
        }
        const base = await openTable(ref);
        const remote = { operation_id: 'retention-replay', expected_sha256: base.sha256 };
        (globalThis as any).IOUtils = {
            ...realIOUtils,
            move: async (from: string, to: string) => {
                if (to.endsWith('history.json')) throw new Error('disk full');
                await realIOUtils.move(from, to);
            },
        };
        expect(await writeTable(ref, demoSpec('new'), meta, base.version, remote))
            .toMatchObject({ ok: true, saved: false, pruned: [] });
        (globalThis as any).IOUtils = realIOUtils;
        if (failSave) item.saveTx.mockRejectedValueOnce(new Error('item save failed'));
        expect(await writeTable(ref, demoSpec('new'), meta, base.version, remote))
            .toMatchObject({ ok: true, replayed: true, saved: !failSave, pruned: [1] });
        expect(existsSync(sidecar('v1.json'))).toBe(false);
        expect((await listVersions(ref)).map((entry) => entry.version))
            .toEqual(Array.from({ length: TABLE_VERSION_RETENTION }, (_, i) => i + 2));
        expect(await writeTable(ref, demoSpec('new'), meta, base.version, remote))
            .toMatchObject({ ok: true, replayed: true, saved: true, pruned: [] });
    });

    it('acknowledges a retry even when the history write failed after commit', async () => {
        const base = await openTable(ref);
        const remote = { operation_id: 'first', expected_sha256: base.sha256 };
        (globalThis as any).IOUtils = {
            ...realIOUtils,
            move: async (from: string, to: string) => {
                if (to.endsWith('history.json')) throw new Error('disk full');
                await realIOUtils.move(from, to);
            },
        };
        expect(await writeTable(ref, demoSpec('first'), meta, base.version, remote)).toMatchObject({
            ok: true,
            saved: false,
        });
        (globalThis as any).IOUtils = realIOUtils;
        expect(await writeTable(ref, demoSpec('first'), meta, base.version, remote)).toMatchObject({
            ok: true,
            replayed: true,
        });
    });
});

describe('conversation rewind', () => {
    const owner = { actor: 'agent' as const, run_id: 'discard', thread_id: 'thread' };
    const request = { thread_id: 'thread', run_ids: ['discard'] };

    it('trashes a discarded creation despite its collapse seal, and retries harmlessly', async () => {
        await createTable({ spec: demoSpec(), ...owner });
        await writeTable(ref, demoSpec('filled'), owner);
        expect(await trimTable(ref, request)).toMatchObject({
            outcome: 'trashed',
            trimmed_versions: [1, 2],
            trimmed_to: null,
        });
        expect(item.deleted).toBe(true);
        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'unchanged' });
    });

    it.each([
        { actor: 'user' as const, run_id: 'discard', thread_id: 'thread' },
        { actor: 'system' as const, run_id: 'discard', thread_id: 'thread' },
        { actor: 'agent' as const, run_id: 'discard', thread_id: 'other' },
        { actor: 'agent' as const, run_id: 'keep', thread_id: 'thread' },
    ])('stops at a protected boundary: %j', async (boundary) => {
        await createTable({ spec: demoSpec(), ...owner });
        await writeTable(ref, demoSpec('boundary'), boundary);
        await writeTable(ref, demoSpec('discarded'), owner);
        expect(await trimTable(ref, request)).toMatchObject({
            outcome: 'trimmed',
            trimmed_to: 2,
            trimmed_versions: [3],
        });
        expect((await openTable(ref)).spec.rows[0].cells.note.value).toMatchObject({
            text: 'boundary',
        });
        expect(existsSync(sidecar('v3.json'))).toBe(false);
        expect(item.deleted).toBe(false);
        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'unchanged' });
    });

    it('preserves a reconstructed history boundary', async () => {
        await openTable(ref);
        await writeTable(ref, demoSpec('discarded'), owner);
        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'trimmed', trimmed_to: 1 });
        expect(item.deleted).toBe(false);
    });

    it.each(['user', 'system'] as const)('recovers a missing %s boundary before trimming', async (actor) => {
        await createTable({ spec: demoSpec(), ...owner });
        await writeTable(ref, demoSpec('protected'), { actor });
        await writeTable(ref, demoSpec('discarded'), owner);
        const history = await readHistory();
        history.versions = history.versions.filter((entry) => entry.version !== 2);
        await writeFile(sidecar('history.json'), JSON.stringify(history));

        expect(await trimTable(ref, request)).toMatchObject({
            outcome: 'trimmed', trimmed_to: 2, trimmed_versions: [3], saved: true,
        });
        expect(item.deleted).toBe(false);
        expect((await openTable(ref)).spec.rows[0].cells.note.value).toMatchObject({ text: 'protected' });
        expect((await listVersions(ref)).find((entry) => entry.version === 2))
            .toMatchObject({ actor: 'system', sealed: true });
        expect(existsSync(sidecar('v2.json'))).toBe(true);
        expect(existsSync(sidecar('v3.json'))).toBe(false);
    });

    it.each([2, 3])('persists history repaired by an unchanged trim when v%i is missing from the log', async (missingVersion) => {
        await createTable({ spec: demoSpec(), actor: 'user' });
        await writeTable(ref, demoSpec('Two'), { actor: 'user' });
        await writeTable(ref, demoSpec('Three'), { actor: 'user' });
        const document = await readFile(htmlPath, 'utf8');
        const history = await readHistory();
        history.versions = history.versions.filter((entry) => entry.version !== missingVersion);
        history.tip = history.versions[history.versions.length - 1].version;
        await writeFile(sidecar('history.json'), JSON.stringify(history));

        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'unchanged', saved: true, trimmed_to: 3 });
        const repaired = await listVersions(ref);
        expect(repaired.map((entry) => entry.version)).toEqual([1, 2, 3]);
        expect(repaired.find((entry) => entry.version === missingVersion))
            .toMatchObject({ actor: 'system', sealed: true });
        expect((await readHistory()).tip).toBe(3);
        expect(await readFile(htmlPath, 'utf8')).toBe(document);
        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'unchanged', saved: true });
        expect(await listVersions(ref)).toEqual(repaired);
        expect((await openTable(ref)).recovered).toEqual([]);
    });

    it('does not report an unchanged trim as saved when the repaired history cannot be committed', async () => {
        await createTable({ spec: demoSpec(), actor: 'user' });
        await writeTable(ref, demoSpec('Two'), { actor: 'user' });
        const history = await readHistory();
        history.versions.pop();
        history.tip = 1;
        await writeFile(sidecar('history.json'), JSON.stringify(history));
        const document = await readFile(htmlPath, 'utf8');
        (globalThis as any).IOUtils = {
            ...realIOUtils,
            move: async (from: string, to: string) => {
                if (to.endsWith('history.json')) throw new Error('disk full');
                await realIOUtils.move(from, to);
            },
        };
        await expect(trimTable(ref, request)).rejects.toThrow('disk full');
        expect(await readFile(htmlPath, 'utf8')).toBe(document);
        expect((await listVersions(ref)).map((entry) => entry.version)).toEqual([1]);
        (globalThis as any).IOUtils = realIOUtils;
        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'unchanged', saved: true });
        expect((await listVersions(ref)).map((entry) => entry.version)).toEqual([1, 2]);
    });

    it('keeps the oldest retained state when the creation is no longer available', async () => {
        await createTable({ spec: demoSpec(), ...owner });
        const runs: string[] = ['discard'];
        for (let i = 0; i < TABLE_VERSION_RETENTION + 2; i++) {
            runs.push(`run-${i}`);
            await writeTable(ref, demoSpec(String(i)), { ...owner, run_id: `run-${i}` });
        }
        const oldest = (await listVersions(ref))[0].version;
        expect(await trimTable(ref, { thread_id: 'thread', run_ids: runs })).toMatchObject({
            outcome: 'trimmed',
            trimmed_to: oldest,
            retention_exhausted: true,
        });
        expect(item.deleted).toBe(false);
        expect(await trimTable(ref, { thread_id: 'thread', run_ids: runs })).toMatchObject({
            outcome: 'unchanged',
            trimmed_to: oldest,
            retention_exhausted: true,
        });
    });

    it('refuses corrupt surviving history without modifying the document', async () => {
        await createTable({ spec: demoSpec(), actor: 'user' });
        await writeTable(ref, demoSpec('discarded'), owner);
        const before = await readFile(htmlPath, 'utf8');
        await writeFile(sidecar('v1.json'), JSON.stringify(demoSpec('corrupt')));
        await expect(trimTable(ref, request)).rejects.toMatchObject({ code: 'version_corrupt' });
        expect(await readFile(htmlPath, 'utf8')).toBe(before);
    });

    it.each(['history', 'cleanup', 'index', 'save'])(
        'retries item bookkeeping after a post-commit %s failure', async (stage) => {
            await createTable({ spec: demoSpec(), actor: 'user' });
            await writeTable(ref, demoSpec('discarded'), owner);
            (globalThis as any).IOUtils = {
                ...realIOUtils,
                move: async (from: string, to: string) => {
                    if (stage === 'history' && to.endsWith('history.json')) throw new Error('disk full');
                    await realIOUtils.move(from, to);
                },
                remove: async (path: string, options: any) => {
                    if (stage === 'cleanup' && path.endsWith('v2.json')) throw new Error('cleanup failed');
                    await realIOUtils.remove(path, options);
                },
            };
            if (stage === 'index') vi.mocked(Zotero.FullText.queueItem).mockRejectedValueOnce(new Error('index failed'));
            if (stage === 'save') item.saveTx.mockRejectedValueOnce(new Error('save failed'));
            expect(await trimTable(ref, request)).toMatchObject({ outcome: 'trimmed', saved: false });
            const document = await readFile(htmlPath, 'utf8');

            // Simulate reloading the item from its last successfully saved state.
            (globalThis as any).IOUtils = realIOUtils;
            item.attachmentSyncState = 1;
            item.saveTx.mockClear();
            vi.mocked(Zotero.FullText.queueItem).mockClear();
            expect(await trimTable(ref, request)).toMatchObject({ outcome: 'unchanged', saved: true });
            expect(Zotero.FullText.queueItem).toHaveBeenCalledWith(item);
            expect(item.saveTx).toHaveBeenCalledOnce();
            expect(item.attachmentSyncState).toBe(0);
            expect(await readFile(htmlPath, 'utf8')).toBe(document);
            expect((await listVersions(ref)).map((entry) => entry.version)).toEqual([1]);
            expect(existsSync(sidecar('v2.json'))).toBe(false);
        }
    );

    it('still indexes and saves a committed trim when shadow recording rejects', async () => {
        await createTable({ spec: demoSpec(), actor: 'user' });
        await writeTable(ref, demoSpec('discarded'), owner);
        item.attachmentSyncState = 1;
        item.saveTx.mockClear();
        vi.mocked(Zotero.FullText.queueItem).mockClear();
        const shadow = vi.spyOn(recoveryShadow, 'recordTableShadow').mockRejectedValueOnce(new Error('shadow unavailable'));
        try {
            expect(await trimTable(ref, request)).toMatchObject({ outcome: 'trimmed', saved: true, trimmed_to: 1 });
            expect(shadow).toHaveBeenCalledOnce();
            expect(Zotero.FullText.queueItem).toHaveBeenCalledWith(item);
            expect(item.saveTx).toHaveBeenCalledOnce();
            expect(item.attachmentSyncState).toBe(0);
            expect(await storedVersion()).toBe(1);
            expect((await listVersions(ref)).map((entry) => entry.version)).toEqual([1]);
        } finally {
            shadow.mockRestore();
        }
    });

    it('does not acknowledge a trim retry while sidecar deletion still fails', async () => {
        await createTable({ spec: demoSpec(), actor: 'user' });
        await writeTable(ref, demoSpec('discarded'), owner);
        (globalThis as any).IOUtils = {
            ...realIOUtils,
            remove: async (path: string, options: any) => {
                if (path.endsWith('v2.json')) throw new Error('cleanup failed');
                await realIOUtils.remove(path, options);
            },
        };
        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'trimmed', saved: false });
        const document = await readFile(htmlPath, 'utf8');
        for (let attempt = 0; attempt < 2; attempt++) {
            await expect(trimTable(ref, request)).rejects.toThrow('cleanup failed');
            expect(existsSync(sidecar('v2.json'))).toBe(true);
            expect(await readFile(htmlPath, 'utf8')).toBe(document);
        }
        (globalThis as any).IOUtils = realIOUtils;
        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'unchanged', saved: true });
        expect(existsSync(sidecar('v2.json'))).toBe(false);
    });

    it.each(['index', 'save'])('does not acknowledge an unchanged retry when %s fails again', async (stage) => {
        await createTable({ spec: demoSpec(), actor: 'user' });
        await writeTable(ref, demoSpec('discarded'), owner);
        item.saveTx.mockRejectedValueOnce(new Error('save failed'));
        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'trimmed', saved: false });
        if (stage === 'index') vi.mocked(Zotero.FullText.queueItem).mockRejectedValueOnce(new Error('index failed'));
        else item.saveTx.mockRejectedValueOnce(new Error('save failed'));
        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'unchanged', saved: false });
        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'unchanged', saved: true });
    });

    it('repairs a trim interrupted after the document commit', async () => {
        await createTable({ spec: demoSpec(), actor: 'user' });
        await writeTable(ref, demoSpec('discarded'), owner);
        (globalThis as any).IOUtils = {
            ...realIOUtils,
            move: async (from: string, to: string) => {
                if (to.endsWith('history.json')) throw new Error('disk full');
                await realIOUtils.move(from, to);
            },
        };
        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'trimmed', saved: false });
        (globalThis as any).IOUtils = realIOUtils;
        const opened = await openTable(ref);
        expect(opened.version).toBe(1);
        expect(opened.history.map((e) => e.version)).toEqual([1]);
        expect(existsSync(sidecar('v2.json'))).toBe(false);
    });

    it('does not read or modify an excluded library', async () => {
        checkLibraryExcluded.mockReturnValue({ message: 'Excluded' });
        await expect(trimTable(ref, request)).rejects.toMatchObject({ code: 'library_excluded' });
        expect(Zotero.Items.getByLibraryAndKey).not.toHaveBeenCalled();
    });
});

describe('retriable creation', () => {
    beforeEach(() => {
        let imported = false;
        (Zotero as any).DB = {
            queryAsync: vi.fn(async (_sql: string, _params: unknown, options: any) => {
                if (imported) options.onRow({ getResultByIndex: () => item.id });
            }),
        };
        (Zotero as any).ItemFields = { getID: () => 13 };
        (Zotero.Items as any).getAsync = vi.fn(async () => item);
        (Zotero.Attachments.importFromSnapshotContent as any).mockImplementation(
            async ({ snapshotContent }: any) => {
                imported = true;
                await writeFile(htmlPath, snapshotContent, 'utf8');
                return item;
            }
        );
    });

    const options = {
        spec: demoSpec(),
        operation_id: 'create-one',
        actor: 'agent' as const,
        run_id: 'run',
        thread_id: 'thread',
    };

    it('serializes concurrent creates and replays one item across process-state loss', async () => {
        const [a, b] = await Promise.all([createTable(options), createTable(options)]);
        expect(a.key).toBe(b.key);
        expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
        expect(b.operation).toEqual(a.operation);
        tableWriteLocks().clear();
        const replay = await createTable(options);
        expect(replay.replayed).toBe(true);
        expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledTimes(1);
    });

    it('keeps the title slug in operation URLs and describes replay from a single read', async () => {
        const created = await createTable({ ...options, title: 'Readable Table Name' });
        const imported = vi.mocked(Zotero.Attachments.importFromSnapshotContent).mock.calls[0][0];
        expect(imported.url).toMatch(/^beaver:\/\/table\/operation-[a-f0-9]{64}\/readable-table-name$/);
        let documentReads = 0;
        (globalThis as any).IOUtils = { ...realIOUtils, readUTF8: async (path: string) => {
            if (path === htmlPath) documentReads++;
            return realIOUtils.readUTF8(path);
        } };
        vi.mocked(Zotero.File.getContentsAsync).mockClear();
        const replay = await createTable({ ...options, title: 'Readable Table Name' });
        expect(documentReads).toBe(1);
        expect(Zotero.File.getContentsAsync).not.toHaveBeenCalled();
        expect(replay).toMatchObject({
            filename: created.filename, title: created.title, cssRuleCount: created.cssRuleCount,
            byteLength: created.byteLength, selectUri: created.selectUri, openUri: created.openUri,
        });
        await expect(createTable({ ...options, title: 'Changed title' })).rejects.toMatchObject({ code: 'operation_mismatch' });
        expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledTimes(1);
    });

    it.each(['lastTableShadow', 'recordTableShadow'] as const)(
        'acknowledges creation replay when %s rejects', async (helper) => {
            const created = await createTable(options);
            item.attachmentSyncState = 1;
            item.saveTx.mockClear();
            vi.mocked(Zotero.FullText.queueItem).mockClear();
            const shadow = vi.spyOn(recoveryShadow, helper).mockRejectedValueOnce(new Error('shadow unavailable'));
            try {
                expect(await createTable(options)).toMatchObject({
                    key: created.key, replayed: true, operation: created.operation,
                });
                expect(shadow).toHaveBeenCalledOnce();
                expect(Zotero.FullText.queueItem).toHaveBeenCalledWith(item);
                expect(item.saveTx).toHaveBeenCalledOnce();
                expect(item.attachmentSyncState).toBe(0);
                expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledTimes(1);
            } finally {
                shadow.mockRestore();
            }
        }
    );

    it('refuses reusing a create identity with different content', async () => {
        await createTable(options);
        await expect(
            createTable({ ...options, spec: demoSpec('different') })
        ).rejects.toMatchObject({ code: 'operation_mismatch' });
        expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledTimes(1);
    });

    it.each(['v1.json', 'history.json'])('retries a failed %s seed without acknowledging incomplete creation', async (failedFile) => {
        const publish = vi.fn();
        (Zotero as any).Beaver = { runtime: { publish } };
        (globalThis as any).IOUtils = {
            ...realIOUtils,
            move: async (from: string, to: string) => {
                if (to.endsWith(failedFile)) throw new Error('disk full');
                await realIOUtils.move(from, to);
            },
        };
        await expect(createTable(options)).rejects.toThrow('disk full');
        expect(item.deleted).toBe(false);
        expect(publish).not.toHaveBeenCalled();
        (globalThis as any).IOUtils = realIOUtils;
        const replay = await createTable(options);
        expect(replay).toMatchObject({ key: KEY, replayed: true });
        expect(existsSync(sidecar('v1.json'))).toBe(true);
        expect((await listVersions(ref))).toMatchObject([{ version: 1, creation: true, actor: 'agent', run_id: 'run' }]);
        expect(publish).toHaveBeenCalledTimes(1);
        expect(await trimTable(ref, { thread_id: 'thread', run_ids: ['run'] })).toMatchObject({ outcome: 'trashed' });
        expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledTimes(1);
    });

    it.each(['tag', 'index', 'save'])('finishes item bookkeeping after a failed %s step', async (step) => {
        if (step === 'tag') item.addTag.mockImplementationOnce(() => { throw new Error('interrupted'); });
        if (step === 'index') (Zotero.FullText.queueItem as any).mockRejectedValueOnce(new Error('interrupted'));
        if (step === 'save') item.saveTx.mockRejectedValueOnce(new Error('interrupted'));
        await expect(createTable(options)).rejects.toThrow('interrupted');
        // Unsaved tags disappear on restart; the document must still identify the import.
        const tags = new Set<string>();
        item.hasTag = (tag: string) => tags.has(tag);
        item.addTag.mockImplementation((tag: string) => tags.add(tag));
        item.attachmentSyncState = 1;
        expect(await createTable(options)).toMatchObject({ key: KEY, replayed: true });
        expect(tags).toEqual(new Set(['beaver-table', '📊']));
        expect(Zotero.FullText.queueItem).toHaveBeenCalled();
        expect(item.attachmentSyncState).toBe(0);
        expect(item.saveTx).toHaveBeenCalled();
        expect(await listVersions(ref)).toMatchObject([{ version: 1, creation: true }]);
        expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledTimes(1);
    });

    it.each(['index', 'save'])('keeps a replayed creation retriable when %s fails again', async (step) => {
        item.saveTx.mockRejectedValueOnce(new Error('initial save failed'));
        await expect(createTable(options)).rejects.toThrow('initial save failed');
        const fail = step === 'index' ? Zotero.FullText.queueItem : item.saveTx;
        (fail as any).mockRejectedValueOnce(new Error('retry failed'));
        await expect(createTable(options)).rejects.toThrow('retry failed');
        expect(await createTable(options)).toMatchObject({ key: KEY, replayed: true });
        expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledTimes(1);
    });

    it('refuses an unfinished import instead of creating a duplicate', async () => {
        (Zotero.File.putContentsAsync as any).mockRejectedValueOnce(new Error('disk full'));
        await expect(createTable(options)).rejects.toThrow('disk full');
        await expect(createTable(options)).rejects.toMatchObject({ code: 'operation_pending' });
        expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledTimes(1);
    });

    it('does not resurrect a discarded creation on retry', async () => {
        await createTable(options);
        await trimTable(ref, { thread_id: 'thread', run_ids: ['run'] });
        await expect(createTable(options)).rejects.toMatchObject({ code: 'operation_pending' });
        expect(item.deleted).toBe(true);
    });
});

it('repairs a collapsed commit even when both its old sidecars still agree', async () => {
    const meta = { actor: 'agent' as const, run_id: 'run', thread_id: 'thread' };
    await writeTable(ref, demoSpec('old'), meta);
    const base = await openTable(ref);
    (globalThis as any).IOUtils = {
        ...realIOUtils,
        move: async (from: string, to: string) => {
            if (to.endsWith('.json')) throw new Error('disk full');
            await realIOUtils.move(from, to);
        },
    };
    expect(
        await writeTable(ref, demoSpec('new'), meta, base.version, {
            operation_id: 'collapse',
            expected_sha256: base.sha256,
        })
    ).toMatchObject({ ok: true, saved: false });
    (globalThis as any).IOUtils = realIOUtils;
    const opened = await openTable(ref);
    expect(opened.history.at(-1)?.sha256).toBe(opened.sha256);
    expect(
        JSON.parse(await readFile(sidecar(`v${base.version}.json`), 'utf8')).rows[0].cells.note
            .value.text
    ).toBe('new');
});

describe('artifact provider through the real file store', () => {
    const remoteKey = `u-${KEY}`;
    const request = (op: string, fields: Record<string, unknown> = {}) => handleArtifactRequest({ event: 'artifact_request', request_id: `request-${op}`, op, key: remoteKey, ...fields });
    it('reads, writes, replays original receipts with current state, conflicts, and restores history', async () => {
        const read = await request('read');
        expect(read).toMatchObject({ ok: true, type: 'artifact_response', request_id: 'request-read', op: 'read', version: 1 });
        const fields = { spec: demoSpec('remote'), meta: { actor: 'agent', run_id: 'run', thread_id: 'thread' }, operation_id: 'remote', expected_version: read.version, expected_sha256: read.sha256 };
        const written = await request('write', fields);
        expect(written).toMatchObject({ ok: true, saved: true, operation: { operation_id: 'remote' } });
        await editTable(ref, [{ op: 'set_meta', title: 'Local correction' }], { actor: 'user' });
        const replay = await request('write', fields);
        expect(replay).toMatchObject({ ok: true, replayed: true, operation: written.operation, spec: { title: 'Local correction' } });
        expect(replay.version).toBeGreaterThan(written.version);
        expect(await request('write', { ...fields, operation_id: 'different' })).toMatchObject({ ok: false, conflict: true, error_code: 'conflict', spec: { title: 'Local correction' } });
        const restored = await request('revert', { to_version: 1, meta: { actor: 'user' } });
        expect(restored).toMatchObject({ ok: true, spec: { title: 'Demo table' } });
        expect(restored.version).toBeGreaterThan(replay.version);
    });
    it.each(['read', 'list', 'write'].flatMap(op => ['missing', 'digest', 'log-digest'].map(damage => [op, damage])))('repairs interrupted tip bookkeeping before provider %s (%s)', async (op, damage) => {
        const before = await openTable(ref);
        if (damage === 'missing') await rm(sidecar(`v${before.version}.json`));
        else if (damage === 'digest') await writeFile(sidecar(`v${before.version}.json`), JSON.stringify({ ...before.spec, title: 'Interrupted sidecar' }));
        else {
            const history = await readHistory();
            history.versions[history.versions.length - 1].sha256 = '0'.repeat(64);
            await writeFile(sidecar('history.json'), JSON.stringify(history));
        }
        const response = await request(op, op === 'list'
            ? { key: null, keys: [remoteKey] }
            : op === 'write' ? { spec: demoSpec('new'), meta: { actor: 'user' }, operation_id: `repair-${damage}`, expected_version: before.version, expected_sha256: before.sha256 } : {});
        if (op === 'list') expect(response.items[0]).toMatchObject({ unavailable: false });
        else expect(response.ok).toBe(true);
        expect(JSON.parse(await readFile(sidecar(`v${before.version}.json`), 'utf8'))).toEqual(before.spec);
    });
    it('does not expose missing older history or repair around excluded retained content', async () => {
        const old = await openTable(ref);
        await writeTable(ref, demoSpec('current'), { actor: 'user' });
        const current = await openTable(ref);
        await rm(sidecar(`v${old.version}.json`));
        expect(await request('read')).toMatchObject({ ok: false });
        const excluded = { ...old.spec, rows: [{ ...old.spec.rows[0], ref: { kind: 'item', library_id: 7, zotero_key: 'SOURCEAB' } }] };
        await writeFile(sidecar(`v${old.version}.json`), JSON.stringify(excluded));
        await rm(sidecar(`v${current.version}.json`));
        checkLibraryExcluded.mockImplementation((id) => id === 7 ? { message: 'excluded' } : null);
        expect(await request('read')).toMatchObject({ ok: false, error_code: 'library_excluded' });
        expect(existsSync(sidecar(`v${current.version}.json`))).toBe(false);
    });
    it('serves valid documents after tag removal but rejects an arbitrary HTML document', async () => {
        item.hasTag = () => false;
        expect(await request('read')).toMatchObject({ ok: true });
        await writeFile(htmlPath, '<html>Ordinary HTML</html>');
        expect(await request('read')).toMatchObject({ ok: false, error_code: 'no_spec' });
        expect(await request('delete')).toMatchObject({ ok: false, error_code: 'no_spec' });
        expect(item.deleted).toBe(false);
    });
    it('returns one bounded status per explicit key and no metadata for unavailable items', async () => {
        const response = await request('list', { key: null, keys: [remoteKey, 'u-MISSNGAB'], thread_id: 'new-thread' });
        expect(response.items).toHaveLength(2);
        expect(response.items[0]).toMatchObject({ key: remoteKey, unavailable: false, version: 1 });
        expect(response.items[1]).toEqual({ key: 'u-MISSNGAB', kind: 'table', unavailable: true, error_code: 'not_found', unseen: [] });
    });
    it('checks target exclusions before item lookup', async () => {
        checkLibraryExcluded.mockReturnValue({ message: 'excluded secret library' });
        expect(await request('read')).toEqual(expect.objectContaining({ ok: false, error_code: 'library_excluded' }));
        expect(Zotero.Items.getByLibraryAndKey).not.toHaveBeenCalled();
    });
    it('withholds excluded rows in retained history even after their removal from current content', async () => {
        const withSource = demoSpec();
        withSource.rows[0].ref = { kind: 'item', library_id: 7, zotero_key: 'SOURCE01' };
        await writeTable(ref, withSource, { actor: 'user' });
        await writeTable(ref, demoSpec('current'), { actor: 'user' });
        checkLibraryExcluded.mockImplementation((id) => id === 7 ? { message: 'excluded' } : null);
        for (const op of ['read', 'versions', 'delete']) {
            const response = await request(op);
            expect(response).toMatchObject({ ok: false, error_code: 'library_excluded' });
            for (const field of ['spec', 'summary', 'versions', 'version', 'sha256']) expect(response).not.toHaveProperty(field);
        }
    });
    it('rejects excluded incoming content before replay lookup and preserves current bytes', async () => {
        const before = await readFile(htmlPath, 'utf8');
        checkLibraryExcluded.mockImplementation((id) => id === 7 ? { message: 'excluded' } : null);
        const spec = demoSpec();
        spec.citations = [{ citation_id: 'private', resolved_ref: { kind: 'zotero', library_id: 7, zotero_key: 'SOURCE01' } } as any];
        expect(await request('write', { spec, meta: { actor: 'user' }, operation_id: 'private', expected_version: 1, expected_sha256: 'a'.repeat(64) })).toMatchObject({ error_code: 'library_excluded' });
        expect(await readFile(htmlPath, 'utf8')).toBe(before);
    });
    it('maps absent local files distinctly from missing items and rejects mismatched document identity', async () => {
        await rm(htmlPath);
        expect(await request('read')).toMatchObject({ error_code: 'item_missing' });
        await writeFile(htmlPath, buildTableDocument({ ...demoSpec(), key: 'OTHER001', version: 1 }).html);
        expect(await request('read')).toMatchObject({ ok: false });
    });
    it('guards local drafts inside the store lock and retains intentional blank ownership', async () => {
        const read = await openTable(ref);
        const guard = { version: read.version, sha256: read.sha256 };
        await editTable(ref, [{ op: 'set_cells', cells: [{ row: 'r1', column: 'note', cell: { provenance: 'user' } }] }], { actor: 'user' }, guard);
        expect((await openTable(ref)).spec.rows[0].cells.note).toEqual({ provenance: 'user' });
        const stale = await editTable(ref, [{ op: 'remove_rows', rows: ['r1'] }], { actor: 'user' }, guard);
        expect(stale).toMatchObject({ ok: false, conflict: true });
        expect((await openTable(ref)).spec.rows).toHaveLength(1);
    });
    it('reads read-only tables but refuses writes before changing bytes', async () => {
        (Zotero.Libraries.get as any).mockReturnValue({ editable: false, filesEditable: false });
        expect(await request('read')).toMatchObject({ ok: true });
        const before = await readFile(htmlPath, 'utf8');
        expect(await request('revert', { to_version: 1, meta: { actor: 'user' } })).toMatchObject({ error_code: 'invalid_target' });
        expect(await readFile(htmlPath, 'utf8')).toBe(before);
    });
});


it('rechecks source exclusions at the document commit point', async () => {
    const opened = await openTable(ref);
    const original = await readFile(htmlPath, 'utf8');
    const spec = demoSpec('new answer');
    spec.citations = [{ citation_id: 'retained-source', resolved_ref: { kind: 'zotero', library_id: 7, zotero_key: 'SOURCEAB' } } as any];
    const ioWrite = IOUtils.writeUTF8;
    (IOUtils as any).writeUTF8 = async (...args: any[]) => {
        const result = await (ioWrite as any)(...args);
        checkLibraryExcluded.mockImplementation((id) => id === 7 ? { message: 'excluded' } : null);
        return result;
    };
    const response = await handleArtifactRequest({ event: 'artifact_request', request_id: 'mid-write', op: 'write', key: `u-${KEY}`, spec, meta: { actor: 'user' }, operation_id: 'mid-write', expected_version: opened.version, expected_sha256: opened.sha256 });
    expect(response).toMatchObject({ ok: false, error_code: 'library_excluded' });
    expect(await readFile(htmlPath, 'utf8')).toBe(original);
});
