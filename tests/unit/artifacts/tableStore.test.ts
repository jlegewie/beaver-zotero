import { handleArtifactRequest } from '../../../src/services/artifacts/artifactProvider';
import { installMutationInstance } from '../../helpers/mutationInstance';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat as statFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const checkLibraryExcluded = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded,
}));

const resolvedSources = vi.hoisted(() => ({ resolveSources: vi.fn(), resolveSource: vi.fn() }));
vi.mock('../../../src/services/artifacts/tableSources', () => resolvedSources);
vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => 0),
    setPref: vi.fn(),
    clearPref: vi.fn(),
}));

import { TABLE_SPEC_VERSION, type TableSpec } from '@beaver/agent-core/layouts/table';
import { buildTableDocument } from '../../../src/services/artifacts/tableDocument';
import { TABLE_EMOJI_TAG, TABLE_TAG, TableItemError } from '../../../src/services/artifacts/tableItem';
import {
    registerTableLocalCommands,
    registerTableShadowRestore,
    createTable,
    editTable,
    editTableSessionUncoordinated,
    listVersions,
    openTable,
    readTable,
    revertTable,
    writeTable,
    trimTable,
    applyTableEdit,
    undoTableEdit,
    TABLE_UNDO_CHANGED,
    createTableFromRequest,
    TABLE_VERSION_RETENTION,
    type TableHistory,
    type TableWriteResult,
} from '../../../src/services/artifacts/tableStore';
import { getTableLocalCommands, getTableShadowRestore, tableLocalCommands, tableWriteLocks } from '../../../src/services/artifacts/tablesApi';
import * as recoveryShadow from '../../../src/services/artifacts/recoveryShadow';
import { applyUserTableEditUncoordinated as applyUserEdit } from '../../../src/services/artifacts/tableUserEdits';

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
    stat: async (path: string) => ({ size: (await statFile(path)).size }),
    read: async (path: string, options?: { maxBytes?: number }) => {
        const bytes = new Uint8Array(await readFile(path));
        return options?.maxBytes ? bytes.slice(0, options.maxBytes) : bytes;
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
        spec_version: TABLE_SPEC_VERSION,
        title: 'Demo table',
        columns: [{ id: 'note', header: 'Note', type: 'text' }],
        rows: [
            {
                id: 'r1',
                cells: {
                    note: {
                        outcome: 'answered',
                        value: { kind: 'text', text },
                        provenance: 'model',
                    },
                },
            },
        ],
    };
}

/** `table.json`, the table itself. */
function tablePath(): string {
    return join(storageDir, 'table.json');
}

async function readTableFile(): Promise<{ spec: TableSpec; receipts?: unknown[]; creation?: unknown }> {
    return JSON.parse(await readFile(tablePath(), 'utf8'));
}

/**
 * Seeds the storage directory with the table, its snapshot and no sidecar at
 * all — the state a table synced from a device whose log did not travel arrives
 * in, and what the write path has to reconcile rather than write over.
 */
async function seedTable(version = 1): Promise<void> {
    const spec = { ...demoSpec(), key: KEY, version };
    await writeFile(tablePath(), JSON.stringify({ spec }), 'utf8');
    await writeFile(htmlPath, buildTableDocument(spec).html, 'utf8');
}

/** What a freshly imported attachment's storage directory holds: nothing yet. */
async function emptyStorageDirectory(): Promise<void> {
    for (const name of await readdir(storageDir)) {
        await rm(join(storageDir, name), { recursive: true, force: true });
    }
}

/** The version the stored table claims. */
async function storedVersion(): Promise<number | undefined> {
    try {
        return (await readTableFile()).spec.version;
    } catch {
        return undefined;
    }
}

/** Commits a version straight to `table.json`, as an interrupted write would. */
async function bumpStoredDocument(): Promise<void> {
    const file = await readTableFile();
    const next = { ...file.spec, version: (file.spec.version ?? 0) + 1 };
    await writeFile(tablePath(), JSON.stringify({ ...file, spec: next }), 'utf8');
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
        hasTag: (name: string) => name === TABLE_TAG || name === TABLE_EMOJI_TAG,
        title: 'Demo table',
        getField(field: string) {
            return field === 'url' ? 'beaver://table/demo-table' : field === 'title' ? this.title : '';
        },
        setField: vi.fn(function (this: { title: string }, field: string, value: string) {
            if (field === 'title') this.title = value;
        }),
        // As in Zotero: the async form answers false for a missing file.
        getFilePathAsync: async () => ((await realIOUtils.exists(htmlPath)) ? htmlPath : false),
        getFilePath: () => htmlPath,
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
            getByLibraryAndKeyAsync: vi.fn(
                async (libraryID: number, key: string) =>
                    libraryID === LIBRARY_ID && key === KEY ? item : false
            ),
            loadDataTypes: vi.fn(async () => undefined),
        },
        Attachments: {
            ...savedZotero.Attachments,
            getStorageDirectory: vi.fn(() => ({ path: storageDir })),
            // Stands in for the real import: a new attachment's storage
            // directory holds only the first render.
            importFromSnapshotContent: vi.fn(
                async ({ snapshotContent }: { snapshotContent: string }) => {
                    await emptyStorageDirectory();
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

    installMutationInstance();
});

afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
});

/** Refuses a spec with a row from an excluded library, as the provider's guard does. */
function sourceGuard(spec: TableSpec): void {
    for (const row of spec.rows) {
        if (row.ref?.kind === 'item' && checkLibraryExcluded(row.ref.library_id))
            throw new TableItemError('Excluded source.', 'library_excluded');
    }
}

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
                [{ op: 'set_meta', description: 'From instance B' }],
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
        expect(spec.description).toBe('From instance B');
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

    it('renders the snapshot inside the write, then marks it for upload and saves it, so the change syncs', async () => {
        const written = expectOk(await writeTable(ref, demoSpec(), { actor: 'agent' }));

        expect(item.attachmentSyncState).toBe(0);
        expect(item.saveTx).toHaveBeenCalledTimes(1);
        expect(Zotero.FullText.queueItem).toHaveBeenCalledWith(item);
        expect(written.saved).toBe(true);
        const html = await readFile(htmlPath, 'utf8');
        expect(html).toContain(`data-beaver-spec-sha256="${written.sha256}"`);
        expect(JSON.parse(await readFile(sidecar('bookkeeping.json'), 'utf8'))).toEqual({
            sha256: written.sha256,
            file_sha256: await sha256(await readFile(tablePath(), 'utf8')),
        });
    });

    it('never fails a committed write for a failed render, and opening re-renders', async () => {
        item.saveTx = vi.fn(async () => {
            throw new Error('database is locked');
        });

        const written = expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));

        // The table is committed, so the caller must not retry: doing so would
        // apply the same mutations twice. The failed render is bookkeeping.
        expect(written.saved).toBe(false);
        expect(written.version).toBe(2);
        expect(await storedVersion()).toBe(2);
        expect((await readHistory()).tip).toBe(2);
        expect(existsSync(sidecar('bookkeeping.json'))).toBe(false);

        item.saveTx = vi.fn(async () => undefined);
        expect((await openTable(ref)).recovered).toContainEqual({ kind: 'rerendered' });
        expect(item.saveTx).toHaveBeenCalledTimes(1);
        expect((await openTable(ref)).recovered).toEqual([]);
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

    it('collapses writes under one collapse key until someone else writes', async () => {
        const meta = { actor: 'agent' as const, collapse_key: 'job-1', change: 'Filled' };
        const first = expectOk(await writeTable(ref, demoSpec('One'), meta));
        const second = expectOk(await writeTable(ref, demoSpec('Two'), meta));
        expect([first.version, second.version]).toEqual([2, 2]);
        expect(second.collapsed).toBe(true);
        expect(second.entry.collapse_key).toBe('job-1');

        // A tab edit in between: the job's next commit starts a new version,
        // so history is never rewritten across someone else's change.
        expectOk(await writeTable(ref, demoSpec('Edit'), { actor: 'user' }));
        const after = expectOk(await writeTable(ref, demoSpec('Three'), meta));
        expect(after.version).toBe(4);
        expect(after.collapsed).toBe(false);
        const again = expectOk(await writeTable(ref, demoSpec('Four'), meta));
        expect([again.version, again.collapsed]).toEqual([4, true]);
    });

    it('advances a column revision when a whole-spec write changes its question', async () => {
        const asked = (description: string): TableSpec => ({
            ...demoSpec('One'),
            columns: [{ id: 'note', header: 'Note', type: 'text', description }],
        });
        const first = expectOk(await writeTable(ref, asked('First?'), { actor: 'agent' }));
        const changed = expectOk(await writeTable(ref, asked('Second?'), { actor: 'agent' }));
        expect(changed.spec.columns[0].revision).toBe((first.spec.columns[0].revision ?? 0) + 1);
        const kept = expectOk(await writeTable(ref, { ...asked('Second?'), title: 'Renamed' }, { actor: 'agent' }));
        expect(kept.spec.columns[0].revision).toBe(changed.spec.columns[0].revision);
    });

    it('does not advance a revision when a fill\'s own answers grow an open select', async () => {
        expectOk(await editTable(ref, [{ op: 'add_columns', columns: [{ id: 'kind', header: 'Kind', type: 'select' }] }], { actor: 'user' }));
        const write = (label: string) =>
            editTable(
                ref,
                [{ op: 'set_cells', cells: [{ row: 'r1', column: 'kind', revision: 0, cell: { outcome: 'answered', provenance: 'model', value: { kind: 'select', label } } }] }],
                { actor: 'agent', collapse_key: 'job-1' },
            );
        const first = expectOk(await write('Survey'));
        expect(first.spec.columns.find((c) => c.id === 'kind')?.revision).toBeUndefined();
        const second = expectOk(await write('Panel'));
        expect(second.skipped).toEqual([]);
        expect(second.spec.rows[0].cells.kind?.value).toEqual({ kind: 'select', label: 'Panel' });
    });

    it('does not collapse a job onto a run that shares nothing but its run id', async () => {
        await writeTable(ref, demoSpec('One'), { actor: 'agent', run_id: 'run-1' });
        const fill = expectOk(
            await writeTable(ref, demoSpec('Two'), { actor: 'agent', run_id: 'run-1', collapse_key: 'job-1' })
        );
        expect(fill.collapsed).toBe(false);
        const run = expectOk(await writeTable(ref, demoSpec('Three'), { actor: 'agent', run_id: 'run-1' }));
        expect(run.collapsed).toBe(false);
        expect(run.version).toBe(4);
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

    it('records the size of a repaired tip version, for retention', async () => {
        const written = expectOk(await writeTable(ref, demoSpec('One'), { actor: 'user' }));
        // A collapsing write that grew the table and committed, then failed to
        // update its log entry.
        const grown = { ...written.spec, title: 'x'.repeat(4096) };
        await writeFile(tablePath(), JSON.stringify({ ...(await readTableFile()), spec: grown }), 'utf8');

        const opened = await openTable(ref);

        expect(opened.recovered).toContainEqual({ kind: 'version_file_repaired', version: written.version });
        const tip = (await readHistory()).versions.at(-1)!;
        expect(tip.bytes).toBe(Buffer.byteLength(await readFile(sidecar(`v${written.version}.json`), 'utf8')));
        expect(tip.bytes).toBeGreaterThan(4096);
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

describe('collapse keys and sealing', () => {
    const rename = (title: string) => [{ op: 'set_meta' as const, title }];

    it('collapses user edits that share a tab session key', async () => {
        const meta = { actor: 'user' as const, collapse_key: 'tab-1' };
        const first = expectOk((await editTable(ref, rename('A'), meta)) as TableWriteResult);
        const second = expectOk((await editTable(ref, rename('B'), meta)) as TableWriteResult);
        expect([first.version, second.version]).toEqual([2, 2]);
        expect(second.collapsed).toBe(true);
        expect(second.entry).toMatchObject({ actor: 'user', collapse_key: 'tab-1' });
        expect((await readTable(ref)).spec.title).toBe('B');
    });

    it('starts a new version after a write by someone else', async () => {
        const meta = { actor: 'user' as const, collapse_key: 'tab-1' };
        await editTable(ref, rename('A'), meta);
        await editTable(ref, rename('Agent'), { actor: 'agent', run_id: 'run-1' });
        const after = expectOk((await editTable(ref, rename('B'), meta)) as TableWriteResult);
        expect([after.version, after.collapsed]).toEqual([4, false]);
        // Another session's key is someone else, too.
        const other = expectOk((await editTable(ref, rename('C'), { actor: 'user', collapse_key: 'tab-2' })) as TableWriteResult);
        expect([other.version, other.collapsed]).toEqual([5, false]);
    });

    it('never collapses into a sealed version, and a sealed write never collapses', async () => {
        const meta = { actor: 'user' as const, collapse_key: 'tab-1' };
        await editTable(ref, rename('A'), meta);
        const sealed = expectOk((await editTable(ref, rename('Destructive'), { ...meta, seal: true })) as TableWriteResult);
        expect([sealed.version, sealed.collapsed, sealed.entry.sealed]).toEqual([3, false, true]);
        const after = expectOk((await editTable(ref, rename('B'), meta)) as TableWriteResult);
        expect([after.version, after.collapsed]).toEqual([4, false]);
    });

    it('still collapses an agent write without a key by its run', async () => {
        const meta = { actor: 'agent' as const, run_id: 'run-1', thread_id: 't' };
        await editTable(ref, rename('A'), meta);
        const second = expectOk((await editTable(ref, rename('B'), meta)) as TableWriteResult);
        expect([second.version, second.collapsed]).toEqual([2, true]);
        // The same run with a user key is not the same writer.
        const user = expectOk((await editTable(ref, rename('C'), { actor: 'user', run_id: 'run-1' })) as TableWriteResult);
        expect([user.version, user.collapsed]).toEqual([3, false]);
    });
});

describe('applyTableEdit', () => {
    const meta = { actor: 'agent' as const, run_id: 'run', thread_id: 'thread' };
    const operation = { operation_id: 'edit-1', request_sha256: 'a'.repeat(64) };
    const retitle = (title: string, changes: unknown[] = [{ kind: 'renamed', title }]) =>
        vi.fn((spec: TableSpec) => ({ ok: true as const, spec: { ...spec, title }, changes }));

    it('applies a repeat with the same id once and answers it with the original changes', async () => {
        const build = retitle('Edited');
        const first = await applyTableEdit(ref, build, meta, operation);
        expect(first).toMatchObject({ ok: true, replayed: false, version: 2, changes: [{ kind: 'renamed', title: 'Edited' }] });
        await editTable(ref, [{ op: 'set_meta', title: 'User' }], { actor: 'user' });
        tableWriteLocks().clear();
        const again = retitle('Edited', [{ kind: 'other' }]);
        const replay = await applyTableEdit(ref, again, meta, operation);
        expect(again).not.toHaveBeenCalled();
        // The current state, with the changes the first call answered.
        expect(replay).toMatchObject({ ok: true, replayed: true, version: 3, changes: [{ kind: 'renamed', title: 'Edited' }] });
        if (!replay.ok) throw new Error('replay failed');
        expect(replay.spec.title).toBe('User');
        expect(await listVersions(ref)).toHaveLength(3);
    });

    it('refuses the same id with a different request', async () => {
        await applyTableEdit(ref, retitle('Edited'), meta, operation);
        const build = retitle('Other');
        await expect(
            applyTableEdit(ref, build, meta, { ...operation, request_sha256: 'b'.repeat(64) })
        ).rejects.toMatchObject({ code: 'operation_mismatch' });
        expect(build).not.toHaveBeenCalled();
        expect((await readTable(ref)).spec.title).toBe('Edited');
    });

    it('writes nothing when the build fails or changes nothing', async () => {
        const before = await readFile(tablePath(), 'utf8');
        expect(await applyTableEdit(ref, () => ({ ok: false, code: 'unknown_row', message: 'No row r9.' }), meta, operation))
            .toEqual({ ok: false, code: 'unknown_row', message: 'No row r9.' });
        const unchanged = await applyTableEdit(ref, (spec) => ({ ok: true, spec: { ...spec }, changes: [] }), meta, { ...operation, operation_id: 'noop' });
        expect(unchanged).toMatchObject({ ok: true, replayed: false, version: 1, changes: [] });
        expect(await readFile(tablePath(), 'utf8')).toBe(before);
        expect(existsSync(sidecar('history.json'))).toBe(false);
        // Neither left a record, so the id is still free.
        expect(await applyTableEdit(ref, retitle('Edited'), meta, operation)).toMatchObject({ ok: true, replayed: false, version: 2 });
    });

    it('seals its version, so a later write of the same run or key starts a new one', async () => {
        await applyTableEdit(ref, retitle('Edited'), meta, operation);
        const entry = (await listVersions(ref)).at(-1)!;
        expect(entry).toMatchObject({ version: 2, sealed: true, operation_id: 'edit-1', request_sha256: operation.request_sha256 });
        const sameRun = expectOk((await editTable(ref, [{ op: 'set_meta', title: 'Run' }], meta)) as TableWriteResult);
        expect([sameRun.version, sameRun.collapsed]).toEqual([3, false]);
        await applyTableEdit(ref, retitle('Again'), { ...meta, collapse_key: 'job' }, { ...operation, operation_id: 'edit-2' });
        const sameKey = expectOk((await editTable(ref, [{ op: 'set_meta', title: 'Job' }], { ...meta, collapse_key: 'job' })) as TableWriteResult);
        expect([sameKey.version, sameKey.collapsed]).toEqual([5, false]);
    });

    it('collapses a tab edit into its session and seals a destructive one, with no replay record', async () => {
        const user = { actor: 'user' as const };
        const first = await applyTableEdit(ref, retitle('One'), { ...user, collapse_key: 'tab:s1' });
        expect(first).toMatchObject({ ok: true, committed: true, version: 2 });
        const second = await applyTableEdit(ref, retitle('Two'), { ...user, collapse_key: 'tab:s1' });
        expect(second).toMatchObject({ ok: true, committed: true, version: 2 });
        const sealed = await applyTableEdit(ref, retitle('Three'), { ...user, seal: true });
        expect(sealed).toMatchObject({ ok: true, committed: true, version: 3 });
        const entries = await listVersions(ref);
        expect(entries.at(-1)).toMatchObject({ version: 3, sealed: true });
        expect(entries.at(-1)).not.toHaveProperty('operation_id');
        // Nothing collapses onto the sealed version, not even the same session.
        expect(await applyTableEdit(ref, retitle('Four'), { ...user, collapse_key: 'tab:s1' })).toMatchObject({ version: 4 });
        // A build that changes nothing writes nothing and says so.
        expect(await applyTableEdit(ref, (spec) => ({ ok: true, spec: { ...spec }, changes: [] }), user)).toMatchObject({ committed: false, version: 4 });
    });

    it('keeps the edit record through an open that repairs the version entry', async () => {
        await applyTableEdit(ref, retitle('Edited'), meta, operation);
        await writeFile(sidecar('v2.json'), '{"damaged":true}', 'utf8');
        expect((await openTable(ref)).recovered).toContainEqual({ kind: 'version_file_repaired', version: 2 });
        expect((await listVersions(ref)).at(-1)).toMatchObject({ operation_id: 'edit-1', changes: [{ kind: 'renamed', title: 'Edited' }] });
        expect(await applyTableEdit(ref, retitle('Edited'), meta, operation)).toMatchObject({ ok: true, replayed: true });
    });

    const failHistoryWrites = (): (() => void) => {
        const move = (globalThis as any).IOUtils.move;
        (globalThis as any).IOUtils.move = async (from: string, to: string) => {
            if (to === sidecar('history.json')) throw new Error('disk is full');
            return move(from, to);
        };
        return () => {
            (globalThis as any).IOUtils.move = move;
        };
    };

    it('replays a committed edit whose version log was never written', async () => {
        const restore = failHistoryWrites();
        const first = await applyTableEdit(ref, retitle('Edited'), meta, operation);
        restore();
        expect(first).toMatchObject({ ok: true, committed: true, saved: false, version: 2 });
        expect(existsSync(sidecar('history.json'))).toBe(false);
        // The edit's identity committed with the table itself.
        expect(JSON.parse(await readFile(tablePath(), 'utf8')).edit).toMatchObject({ operation_id: 'edit-1', version: 2 });

        const again = retitle('Edited');
        const replay = await applyTableEdit(ref, again, meta, operation);
        expect(again).not.toHaveBeenCalled();
        expect(replay).toMatchObject({
            ok: true,
            replayed: true,
            version: 2,
            edit: { version: 2 },
            changes: [{ kind: 'renamed', title: 'Edited' }],
        });
        expect(await storedVersion()).toBe(2);
        // The replay repaired the log, with the edit's run, so an Undo finds it.
        expect((await listVersions(ref)).at(-1)).toMatchObject({ version: 2, run_id: 'run', operation_id: 'edit-1', sealed: true });
    });

    it('rebuilds a lost log entry of a model edit with its identity on open', async () => {
        const restore = failHistoryWrites();
        await applyTableEdit(ref, retitle('Edited'), meta, operation);
        restore();
        expect((await openTable(ref)).recovered).toContainEqual({ kind: 'history_appended', version: 2 });
        expect((await listVersions(ref)).at(-1)).toMatchObject({
            version: 2,
            actor: 'agent',
            run_id: 'run',
            operation_id: 'edit-1',
            request_sha256: operation.request_sha256,
            changes: [{ kind: 'renamed', title: 'Edited' }],
        });
    });

    it('answers a replay after a later write with the edit identity it committed', async () => {
        const first = await applyTableEdit(ref, retitle('A'), meta, operation);
        const later = await applyTableEdit(ref, retitle('B'), meta, { operation_id: 'edit-2', request_sha256: 'b'.repeat(64) });
        if (!first.ok || !later.ok) throw new Error('edit failed');
        const replay = await applyTableEdit(ref, retitle('A'), meta, operation);
        if (!replay.ok) throw new Error('replay failed');
        // The current state is the later edit's; the edit identity is the first's.
        expect([replay.version, replay.sha256]).toEqual([later.version, later.sha256]);
        expect(replay.edit).toEqual({ version: first.version, sha256: first.sha256 });
        // An Undo naming the replayed edit refuses rather than reverting the later one.
        expect(await undoTableEdit(ref, { version: replay.edit!.version, run_id: 'run' }, { actor: 'user' }))
            .toMatchObject({ ok: false, code: 'changed' });
        expect((await readTable(ref)).spec.title).toBe('B');
    });

    it('applies the access guard to the current and the resulting table', async () => {
        const guard = vi.fn((spec: TableSpec) => {
            if (spec.title === 'Forbidden') throw new Error('excluded source');
        });
        await expect(applyTableEdit(ref, retitle('Forbidden'), meta, operation, guard)).rejects.toThrow('excluded source');
        expect(await storedVersion()).toBe(1);
    });

    it('publishes the update event for a commit and not for a replay', async () => {
        const publish = vi.fn();
        (Zotero as any).Beaver = { ...(Zotero as any).Beaver, runtime: { publish } };
        await applyTableEdit(ref, retitle('Edited'), meta, operation);
        await applyTableEdit(ref, retitle('Edited'), meta, operation);
        expect(publish).toHaveBeenCalledTimes(1);
    });
});


describe("the tab's structural edits", () => {
    it('collapse into the session, seal a removal, and resolve added papers before the write', async () => {
        const first = await applyUserEdit(ref, { title: 'Renamed' }, { seal: false, session: 's1' });
        expect(first).toMatchObject({ ok: true, committed: true, version: 2, changes: [{ op: 'title', title: 'Renamed' }] });
        expect(await applyUserEdit(ref, { description: 'About it' }, { seal: false, session: 's1' })).toMatchObject({ version: 2 });
        expect((await listVersions(ref)).at(-1)).toMatchObject({ version: 2, actor: 'user', collapse_key: 'tab:s1' });

        resolvedSources.resolveSource.mockResolvedValueOnce({
            entry: { id: 'new', type: 'items', ids: ['u-AAAAAAAA'] },
            papers: [{ row: { id: 'r2', ref: { kind: 'item', library_ref: 'u', zotero_key: 'AAAAAAAA' }, cells: {} }, mode: 'title_abstract' }],
            total: 1,
            truncated: false,
            rejected: [],
        });
        const added = await applyUserEdit(ref, { add_sources: [{ type: 'items', ids: ['u-AAAAAAAA'] }] }, { seal: false, session: 's1' });
        expect(resolvedSources.resolveSource).toHaveBeenCalledWith({ type: 'items', ids: ['u-AAAAAAAA'], id: 'new' });
        expect(added).toMatchObject({ ok: true, version: 2, changes: [{ op: 'add_source', rows_added: 1 }] });

        const removed = await applyUserEdit(ref, { remove_columns: ['note'] }, { seal: true, change: 'Removed column “Note”' });
        expect(removed).toMatchObject({ ok: true, committed: true, version: 3, changes: [{ op: 'remove_column', cleared: 1 }] });
        expect((await listVersions(ref)).at(-1)).toMatchObject({ version: 3, sealed: true, change: 'Removed column “Note”' });
    });

    it('refuse an id the table does not have, writing nothing', async () => {
        const before = await readFile(tablePath(), 'utf8');
        expect(await applyUserEdit(ref, { remove_rows: ['r9'] }, { seal: true })).toMatchObject({ ok: false, code: 'unknown_row' });
        expect(await readFile(tablePath(), 'utf8')).toBe(before);
    });
});

describe('undoTableEdit', () => {
    const user = { actor: 'user' as const };
    const retitle = (title: string) =>
        vi.fn((spec: TableSpec) => ({ ok: true as const, spec: { ...spec, title }, changes: [{ op: 'title', title }] }));

    it('restores the version before a sealed edit as a new sealed version', async () => {
        const before = (await readTable(ref)).spec;
        const edit = await applyTableEdit(ref, retitle('Removed'), { ...user, seal: true });
        if (!edit.ok) throw new Error('edit failed');
        const undone = await undoTableEdit(ref, { version: edit.version, sha256: edit.sha256 }, user);
        expect(undone).toMatchObject({ ok: true, version: 3 });
        expect((await readTable(ref)).spec.title).toBe(before.title);
        expect((await listVersions(ref)).at(-1)).toMatchObject({ version: 3, sealed: true, change: 'Undid an edit' });
    });

    it('refuses once anything was written after the edit', async () => {
        const edit = await applyTableEdit(ref, retitle('Removed'), { ...user, seal: true });
        if (!edit.ok) throw new Error('edit failed');
        await editTable(ref, [{ op: 'set_meta', title: 'Later' }], { actor: 'agent', run_id: 'fill', thread_id: 't' });
        expect(await undoTableEdit(ref, { version: edit.version, sha256: edit.sha256 }, user)).toEqual({
            ok: false,
            code: 'changed',
            message: TABLE_UNDO_CHANGED,
        });
        expect((await readTable(ref)).spec.title).toBe('Later');
    });

    it('refuses when the table no longer has the hash the edit produced', async () => {
        const edit = await applyTableEdit(ref, retitle('Removed'), { ...user, seal: true });
        if (!edit.ok) throw new Error('edit failed');
        expect(await undoTableEdit(ref, { version: edit.version, sha256: 'f'.repeat(64) }, user)).toMatchObject({ ok: false, code: 'changed' });
    });

    it('undoes a model edit only for the run that made it', async () => {
        const meta = { actor: 'agent' as const, run_id: 'run-1', thread_id: 'thread' };
        const edit = await applyTableEdit(ref, retitle('Model'), meta, { operation_id: 'op-1', request_sha256: 'a'.repeat(64) });
        if (!edit.ok) throw new Error('edit failed');
        expect(await undoTableEdit(ref, { version: edit.version, run_id: 'run-2' }, user)).toMatchObject({ ok: false, code: 'changed' });
        expect(await undoTableEdit(ref, { version: edit.version, run_id: 'run-1' }, user)).toMatchObject({ ok: true });
    });

    it('reports no changes for a model edit that changes nothing, so it offers no Undo of an earlier one', async () => {
        const meta = { actor: 'agent' as const, run_id: 'run-1', thread_id: 'thread' };
        await applyTableEdit(ref, retitle('Model'), meta, { operation_id: 'op-1', request_sha256: 'a'.repeat(64) });
        const same = await applyTableEdit(ref, retitle('Model'), meta, { operation_id: 'op-2', request_sha256: 'b'.repeat(64) });
        expect(same).toMatchObject({ ok: true, committed: false, version: 2, changes: [] });
    });

    it('refuses a version that was not a model edit when asked for a run', async () => {
        const edit = await applyTableEdit(ref, retitle('Tab'), { ...user, seal: true });
        if (!edit.ok) throw new Error('edit failed');
        expect(await undoTableEdit(ref, { version: edit.version, run_id: 'run-1' }, user)).toMatchObject({ ok: false, code: 'changed' });
    });

    it('refuses the creation version, which has nothing before it', async () => {
        await expect(undoTableEdit(ref, { version: 1 }, user)).rejects.toMatchObject({ code: 'invalid_request' });
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
            // Every stage is bookkeeping after the commit: the trim stands, unsaved.
            const sidecarFailure = stage === 'history' || stage === 'cleanup';
            expect(await trimTable(ref, request)).toMatchObject({ outcome: 'trimmed', saved: false });
            const table = await readFile(tablePath(), 'utf8');

            // Simulate reloading the item from its last successfully saved state.
            (globalThis as any).IOUtils = realIOUtils;
            item.attachmentSyncState = 1;
            item.saveTx.mockClear();
            vi.mocked(Zotero.FullText.queueItem).mockClear();
            expect(await trimTable(ref, request)).toMatchObject({ outcome: 'unchanged', saved: true });
            if (sidecarFailure) {
                expect(item.saveTx).not.toHaveBeenCalled();
            } else {
                expect(Zotero.FullText.queueItem).toHaveBeenCalledWith(item);
                expect(item.saveTx).toHaveBeenCalledOnce();
                expect(item.attachmentSyncState).toBe(0);
            }
            expect(await readFile(tablePath(), 'utf8')).toBe(table);
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

    it.each(['index', 'save'])('renders an unchanged retry again while %s keeps failing', async (stage) => {
        await createTable({ spec: demoSpec(), actor: 'user' });
        await writeTable(ref, demoSpec('discarded'), owner);
        item.saveTx.mockRejectedValueOnce(new Error('save failed'));
        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'trimmed', saved: false });
        expect(existsSync(sidecar('bookkeeping.json'))).toBe(true);
        const trimmedHash = JSON.parse(await readFile(sidecar('bookkeeping.json'), 'utf8')).sha256;
        // Read without opening: an open would repair the render itself.
        expect(trimmedHash).not.toBe(await sha256(JSON.stringify((await readTableFile()).spec)));
        if (stage === 'index') vi.mocked(Zotero.FullText.queueItem).mockRejectedValueOnce(new Error('index failed'));
        else item.saveTx.mockRejectedValueOnce(new Error('save failed'));
        item.saveTx.mockClear();
        // The retry that still cannot render says so; the next one completes.
        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'unchanged', saved: false });
        expect(await trimTable(ref, request)).toMatchObject({ outcome: 'unchanged', saved: true });
        expect(JSON.parse(await readFile(sidecar('bookkeeping.json'), 'utf8')).sha256)
            .toBe((await openTable(ref)).sha256);
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
        expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
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
                await emptyStorageDirectory();
                await writeFile(htmlPath, snapshotContent, 'utf8');
                return item;
            }
        );

    installMutationInstance();
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
        expect(b.sha256).toBe(a.sha256);
        tableWriteLocks().clear();
        const replay = await createTable(options);
        expect(replay.replayed).toBe(true);
        expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledTimes(1);
    });

    it('files into a collection by key and replays the creation after that collection is gone', async () => {
        const collection = { id: 12, key: 'CASHTRN2', libraryID: 1, deleted: false };
        (Zotero as any).Collections = {
            get: vi.fn(() => collection),
            getByLibraryAndKey: vi.fn(() => collection),
        };
        const withCollection = { ...options, collectionKey: 'CASHTRN2' };
        const created = await createTable(withCollection);
        expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledWith(
            expect.objectContaining({ collections: [12] }),
        );
        (Zotero.Collections.getByLibraryAndKey as any).mockReturnValue(false);
        tableWriteLocks().clear();
        expect(await createTable(withCollection)).toMatchObject({ replayed: true, key: created.key });
        expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledTimes(1);
    });

    it('refuses a new creation into a collection that is gone', async () => {
        (Zotero as any).Collections = { get: vi.fn(), getByLibraryAndKey: vi.fn(() => false) };
        await expect(createTable({ ...options, collectionKey: 'CASHTRN2' })).rejects.toMatchObject({
            code: 'invalid_target',
        });
        expect(Zotero.Attachments.importFromSnapshotContent).not.toHaveBeenCalled();
    });

    it('refuses a retry as corrupt when table.json is gone beside its history, until a restore repairs it', async () => {
        const created = await createTable(options);
        await rm(tablePath());
        tableWriteLocks().clear();
        await expect(createTable(options)).rejects.toMatchObject({ code: 'corrupt' });
        await expect(createTable({ ...options, spec: demoSpec('different') })).rejects.toMatchObject({ code: 'corrupt' });
        expect(existsSync(tablePath())).toBe(false);
        expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledTimes(1);
        expect(await revertTable(ref, 1, { actor: 'user' })).toMatchObject({ ok: true, version: 2 });
        const restored = await readTable(ref);
        expect([restored.version, restored.spec.key]).toEqual([2, created.key]);
        expect((await openTable(ref)).recovered).toEqual([]);
    });

    describe('from a request', () => {
        const request = {
            libraryID: LIBRARY_ID,
            title: 'Demo table',
            operation_id: 'create-request',
            request: { title: 'Demo table', sources: [{ kind: 'collection', key: 'C1' }], columns: [] },
            actor: 'agent' as const,
            run_id: 'run',
            thread_id: 'thread',
        };
        const changes = [{ kind: 'rows_added', count: 1 }];
        const build = () => vi.fn(async () => ({ ok: true as const, spec: demoSpec(), changes }));

        it('replays a committed creation with its changes without building again', async () => {
            const first = build();
            const created = await createTableFromRequest({ ...request, build: first });
            expect(created).toMatchObject({ key: KEY, replayed: false, version: 1, changes });
            expect((await readTableFile()).creation).toMatchObject({ operation_id: 'create-request', complete: true, changes });
            tableWriteLocks().clear();
            const second = build();
            const replay = await createTableFromRequest({ ...request, build: second });
            expect(second).not.toHaveBeenCalled();
            expect(replay).toMatchObject({ key: created.key, replayed: true, changes, sha256: (created as any).sha256 });
            expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledTimes(1);
            expect(await listVersions(ref)).toMatchObject([{ version: 1, creation: true, run_id: 'run' }]);
        });

        it('refuses the same id with a different request without building', async () => {
            await createTableFromRequest({ ...request, build: build() });
            const second = build();
            await expect(createTableFromRequest({ ...request, request: { ...request.request, title: 'Other' }, build: second }))
                .rejects.toMatchObject({ code: 'operation_mismatch' });
            expect(second).not.toHaveBeenCalled();
        });

        it('returns a failed build unchanged and imports nothing', async () => {
            const failed = vi.fn(async () => ({ ok: false as const, code: 'no_papers', message: 'No papers.' }));
            expect(await createTableFromRequest({ ...request, build: failed }))
                .toEqual({ ok: false, code: 'no_papers', message: 'No papers.' });
            expect(Zotero.Attachments.importFromSnapshotContent).not.toHaveBeenCalled();
            // Nothing was imported, so the id is still free.
            expect(await createTableFromRequest({ ...request, build: build() })).toMatchObject({ replayed: false });
        });

        it('refuses a collection that is gone before building', async () => {
            (Zotero as any).Collections = { get: vi.fn(), getByLibraryAndKey: vi.fn(() => false) };
            const first = build();
            await expect(createTableFromRequest({ ...request, collectionKey: 'GONE', build: first }))
                .rejects.toMatchObject({ code: 'invalid_target' });
            expect(first).not.toHaveBeenCalled();
        });
    });

    it('confirms a committed creation even when its snapshot cannot be read back', async () => {
        const readUTF8 = (globalThis as any).IOUtils.readUTF8;
        (globalThis as any).IOUtils.readUTF8 = async (path: string) => {
            if (path === htmlPath) throw new Error('snapshot replaced by sync');
            return readUTF8(path);
        };
        try {
            expect(await createTable(options)).toMatchObject({ key: KEY, saved: true });
            expect(await createTable(options)).toMatchObject({ key: KEY, replayed: true });
        } finally {
            (globalThis as any).IOUtils.readUTF8 = readUTF8;
        }
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
                    key: created.key, replayed: true, sha256: created.sha256,
                });
                expect(shadow).toHaveBeenCalledOnce();
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

    it.each(['v1.json', 'history.json'])('reports committed creation after a failed %s seed and repairs locally', async (failedFile) => {
        const publish = vi.fn();
        (Zotero as any).Beaver = { ...(Zotero as any).Beaver, runtime: { publish } };
        (globalThis as any).IOUtils = {
            ...realIOUtils,
            move: async (from: string, to: string) => {
                if (to.endsWith(failedFile)) throw new Error('disk full');
                await realIOUtils.move(from, to);
            },
        };
        expect(await createTable(options)).toMatchObject({ saved: false });
        expect(item.deleted).toBe(false);
        expect(publish).toHaveBeenCalledTimes(1);
        (globalThis as any).IOUtils = realIOUtils;
        await openTable(ref);
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
        // Every step is bookkeeping after the commit: the creation stands, unsaved.
        const tags = new Set<string>();
        item.addTag.mockImplementation((tag: string) => tags.add(tag));
        expect(await createTable(options)).toMatchObject({ saved: step === 'index' ? false : true, key: KEY });
        if (step === 'index') {
            // The failed render is repaired by the next open.
            item.attachmentSyncState = 1;
            expect((await openTable(ref)).recovered).toContainEqual({ kind: 'rerendered' });
        }
        // The render inside the creation restores what the import step lost.
        expect(tags).toEqual(new Set(['beaver-table', '📊']));
        expect(Zotero.FullText.queueItem).toHaveBeenCalled();
        expect(item.attachmentSyncState).toBe(0);
        expect(item.saveTx).toHaveBeenCalled();
        expect((await openTable(ref)).recovered).not.toContainEqual({ kind: 'bookkeeping_pending' });
        expect(await listVersions(ref)).toMatchObject([{ version: 1, creation: true }]);
        expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledTimes(1);
    });

    it.each(['index', 'save'])('keeps a replayed creation retriable when its render %s fails again', async (step) => {
        const fail = (step === 'index' ? Zotero.FullText.queueItem : item.saveTx) as any;
        // The import's own save, when that is the failing step, then the render's.
        if (step === 'save') fail.mockRejectedValueOnce(new Error('initial save failed'));
        fail.mockRejectedValueOnce(new Error('render failed'));
        expect(await createTable(options)).toMatchObject({ saved: false });
        fail.mockRejectedValueOnce(new Error('retry failed'));
        // A replay renders what the creation could not, and says when it still cannot.
        expect(await createTable(options)).toMatchObject({ saved: false, replayed: true });
        expect(await createTable(options)).toMatchObject({ key: KEY, saved: true, replayed: true });
        expect(Zotero.Attachments.importFromSnapshotContent).toHaveBeenCalledTimes(1);
    });

    it('refuses an unfinished import instead of creating a duplicate', async () => {
        vi.spyOn(IOUtils, 'move').mockRejectedValueOnce(new Error('disk full'));
        await expect(createTable(options)).rejects.toMatchObject({ code: 'operation_pending' });
        await expect(createTable(options)).rejects.toMatchObject({ code: 'operation_pending' });
        // The import left a snapshot and no table.
        await expect(openTable(ref)).rejects.toMatchObject({ code: 'no_spec' });
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
    // Everything after the commit point fails: the version file and the log.
    (globalThis as any).IOUtils = {
        ...realIOUtils,
        move: async (from: string, to: string) => {
            if (to.endsWith('.json') && !to.endsWith('table.json')) throw new Error('disk full');
            await realIOUtils.move(from, to);
        },
    };
    expect(
        await writeTable(ref, demoSpec('new'), meta, base.version)
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
    it('reads and restores history', async () => {
        const read = await request('read');
        expect(read).toMatchObject({ ok: true, type: 'artifact_response', request_id: 'request-read', op: 'read', version: 1 });
        await editTable(ref, [{ op: 'set_meta', title: 'Local correction' }], { actor: 'user' });
        const restored = await request('revert', { to_version: 1, meta: { actor: 'user' } });
        expect(restored).toMatchObject({ ok: true, spec: { title: 'Demo table' } });
        expect(restored.version).toBe(3);
    });
    it.each(['read', 'list'].flatMap(op => ['missing', 'digest', 'log-digest'].map(damage => [op, damage])))('repairs interrupted tip bookkeeping before provider %s (%s)', async (op, damage) => {
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
            : {});
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
    it('serves valid tables after tag removal but rejects a snapshot that carries no table', async () => {
        item.hasTag = () => false;
        expect(await request('read')).toMatchObject({ ok: true });
        await rm(tablePath());
        await rm(sidecar(), { recursive: true, force: true });
        await writeFile(htmlPath, '<html>Ordinary HTML</html>');
        expect(await request('read')).toMatchObject({ ok: false, error_code: 'no_spec' });
        expect(await request('delete')).toMatchObject({ ok: true });
        expect(item.deleted).toBe(true);
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
        expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });
    it('withholds excluded rows in retained history even after their removal from current content', async () => {
        const withSource = demoSpec();
        withSource.rows[0].ref = { kind: 'item', library_id: 7, zotero_key: 'SOURCE01' };
        await writeTable(ref, withSource, { actor: 'user' });
        await writeTable(ref, demoSpec('current'), { actor: 'user' });
        checkLibraryExcluded.mockImplementation((id) => id === 7 ? { message: 'excluded' } : null);
        for (const op of ['read', 'versions']) {
            const response = await request(op);
            expect(response).toMatchObject({ ok: false, error_code: 'library_excluded' });
            for (const field of ['spec', 'summary', 'versions', 'version', 'sha256']) expect(response).not.toHaveProperty(field);
        }
    });
    it.each(['corrupt', 'missing', 'mismatched'])('trashes a %s table without reading or returning its content', async (damage) => {
        if (damage === 'missing') await rm(htmlPath);
        else if (damage === 'corrupt') await writeFile(htmlPath, '<html>Broken table</html>');
        else await writeFile(htmlPath, buildTableDocument({ ...demoSpec(), key: 'OTHERABC', version: 1 }).html);
        vi.mocked(Zotero.File.getContentsAsync).mockClear();
        const response = await request('delete');
        expect(response).toMatchObject({ ok: true });
        expect(item.deleted).toBe(true);
        expect(Zotero.File.getContentsAsync).not.toHaveBeenCalled();
        for (const field of ['spec', 'summary', 'versions', 'version', 'sha256']) expect(response).not.toHaveProperty(field);
    });
    it('still refuses deletion in excluded and read-only libraries', async () => {
        checkLibraryExcluded.mockReturnValue({ message: 'excluded' });
        expect(await request('delete')).toMatchObject({ error_code: 'library_excluded' });
        expect(item.deleted).toBe(false);
        checkLibraryExcluded.mockReturnValue(null);
        vi.mocked(Zotero.Libraries.get).mockReturnValue({ editable: false } as any);
        expect(await request('delete')).toMatchObject({ ok: false });
        expect(item.deleted).toBe(false);
    });
    it('maps absent local files distinctly from missing items and rejects mismatched table identity', async () => {
        // A table whose files have not arrived on this device yet.
        await emptyStorageDirectory();
        expect(await request('read')).toMatchObject({ error_code: 'item_missing' });
        await writeFile(tablePath(), JSON.stringify({ spec: { ...demoSpec(), key: 'OTHER001', version: 1 } }));
        expect(await request('read')).toMatchObject({ ok: false });
    });

    it('reports a table.json missing beside its history as corrupt', async () => {
        await writeTable(ref, demoSpec('Two'), { actor: 'user' });
        await rm(tablePath());
        expect(await request('read')).toMatchObject({ ok: false, error_code: 'corrupt' });
        expect(existsSync(tablePath())).toBe(false);
    });
    it('guards local drafts inside the store lock and retains intentional blank ownership', async () => {
        const read = await openTable(ref);
        const guard = { version: read.version, sha256: read.sha256 };
        await editTable(ref, [{ op: 'set_cells', cells: [{ row: 'r1', column: 'note', cell: { outcome: 'cleared', provenance: 'user' } }] }], { actor: 'user' }, guard);
        expect((await openTable(ref)).spec.rows[0].cells.note).toMatchObject({ outcome: 'cleared', provenance: 'user' });
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


it('rechecks source exclusions at the table commit point', async () => {
    const original = await readFile(tablePath(), 'utf8');
    const ioWrite = IOUtils.writeUTF8;
    (IOUtils as any).writeUTF8 = async (...args: any[]) => {
        const result = await (ioWrite as any)(...args);
        checkLibraryExcluded.mockImplementation((id) => id === 7 ? { message: 'excluded' } : null);
        return result;
    };
    const response = applyTableEdit(
        ref,
        (spec) => ({ ok: true, spec: { ...spec, rows: [{ ...spec.rows[0], ref: { kind: 'item', library_id: 7, zotero_key: 'SOURCEAB' } }] }, changes: [] }),
        { actor: 'agent', run_id: 'run' },
        { operation_id: 'mid-write', request_sha256: 'a'.repeat(64) },
        sourceGuard,
    );
    await expect(response).rejects.toMatchObject({ code: 'library_excluded' });
    expect(await readFile(tablePath(), 'utf8')).toBe(original);
});

it('releases renderer-owned commands without withdrawing plugin-owned recovery', async () => {
    registerTableShadowRestore();
    const restore = getTableShadowRestore();
    const first = { closed: false } as Window;
    const second = { closed: false } as Window;
    const releaseFirst = registerTableLocalCommands(first);
    const releaseSecond = registerTableLocalCommands(second);
    expect((await getTableLocalCommands(first).read({ libraryID: LIBRARY_ID, key: KEY })).spec).toBeDefined();
    expect(tableLocalCommands().size).toBe(2);
    releaseFirst();
    expect(tableLocalCommands().has(first)).toBe(false);
    expect(getTableLocalCommands(second).restoreShadow).toBeTypeOf('function');
    expect(getTableShadowRestore()).toBe(restore);
    releaseSecond();
    expect(tableLocalCommands().size).toBe(0);
    expect(getTableShadowRestore()).toBe(restore);
    await expect(restore!(ref)).resolves.toMatchObject({ ok: false, code: 'no_shadow' });
    expect(() => getTableLocalCommands(second)).toThrow('unavailable');
});

it('cancels queued artifact and local table writes when their owner closes', async () => {
    const mutations = Zotero.Beaver.mutations;
    let release!: () => void;
    const blocker = mutations.run(() => new Promise<void>(resolve => { release = resolve; }));
    const win = { closed: false } as Window;
    const detach = registerTableLocalCommands(win, 'closing-table-owner');
    const local = getTableLocalCommands(win).revert(ref, 1);
    const localResult = expect(local).rejects.toMatchObject({ code: 'operation_cancelled' });
    const remote = handleArtifactRequest({ event: 'artifact_request', request_id: 'queued-delete', op: 'delete', key: `u-${KEY}` }, { owner: 'closing-table-owner' });
    expect(mutations.getSnapshot().pending).toBe(2);
    mutations.cancelOwner('closing-table-owner');
    detach();
    release();
    await blocker;
    await localResult;
    await expect(remote).resolves.toMatchObject({ ok: false, error_code: 'operation_cancelled' });
    expect(item.deleted).not.toBe(true);
    expect((await readTable(ref)).version).toBe(1);
});

it('holds the instance queue through an active table write after its owner closes', async () => {
    let entered!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const originalMove = IOUtils.move;
    (IOUtils as any).move = async (...args: any[]) => {
        if (args[1] === tablePath()) {
            entered();
            await blocked;
        }
        return (originalMove as any)(...args);
    };
    const write = Zotero.Beaver.libraryOperations.run('table_applyTableEdit', [
        ref,
        (spec: TableSpec) => ({ ok: true as const, spec: { ...spec, title: 'survives close' }, changes: [] }),
        { actor: 'agent' as const, run_id: 'run' },
        { operation_id: 'active-write', request_sha256: 'a'.repeat(64) },
    ], { owner: 'active-table-owner' });
    await writing;
    Zotero.Beaver.mutations.cancelOwner('active-table-owner');
    const read = openTable(ref);
    expect(Zotero.Beaver.mutations.getSnapshot().pending).toBe(1);
    expect(Zotero.Beaver.mutations.getSnapshot().active).not.toBeNull();
    release();
    await expect(write).resolves.toMatchObject({ ok: true, version: 2 });
    await expect(read).resolves.toMatchObject({ version: 2 });
});


it.each(['index', 'save'])('repairs a failed %s render locally and leaves healthy opens clean', async (stage) => {
    const ref = { libraryID: LIBRARY_ID, key: KEY };
    await createTable({ spec: demoSpec(), libraryID: LIBRARY_ID });
    const current = await openTable(ref);
    const candidate = { ...current.spec, title: 'Committed change' };
    const fail = new Error('bookkeeping unavailable');
    if (stage === 'index') vi.mocked(Zotero.FullText.queueItem).mockRejectedValueOnce(fail);
    if (stage === 'save') item.saveTx.mockRejectedValueOnce(fail);
    const written = await writeTable(ref, candidate, { actor: 'agent', run_id: 'repair-run' }, current.version);
    expect(written).toMatchObject({ ok: true, saved: false });
    item.attachmentSyncState = 1;
    const repaired = await openTable(ref);
    expect(repaired.spec.title).toBe('Committed change');
    expect(repaired.recovered).toContainEqual({ kind: 'rerendered' });
    expect(item.attachmentSyncState).toBe(0);
    item.saveTx.mockClear();
    vi.mocked(Zotero.FullText.queueItem).mockClear();
    expect((await openTable(ref)).recovered).toEqual([]);
    expect(item.saveTx).not.toHaveBeenCalled();
    expect(Zotero.FullText.queueItem).not.toHaveBeenCalled();
});

it('repairs a committed history failure locally and leaves healthy opens clean', async () => {
    const ref = { libraryID: LIBRARY_ID, key: KEY };
    await createTable({ spec: demoSpec(), libraryID: LIBRARY_ID });
    const current = await openTable(ref);
    const candidate = { ...current.spec, title: 'Committed change' };
    const originalMove = IOUtils.move;
    vi.spyOn(IOUtils, 'move').mockImplementation(async (from, to) => {
        if (String(to).endsWith('history.json')) throw new Error('bookkeeping unavailable');
        return originalMove(from, to);
    });
    const written = await writeTable(ref, candidate, { actor: 'agent', run_id: 'repair-run' }, current.version);
    vi.mocked(IOUtils.move).mockRestore?.();
    expect(written).toMatchObject({ ok: true, saved: false });
    const repaired = await openTable(ref);
    expect(repaired.spec.title).toBe('Committed change');
    expect(repaired.recovered).toContainEqual({ kind: 'history_appended', version: written.ok ? written.version : 0 });
    expect(repaired.history.map((entry) => entry.version)).toEqual([1, 2]);
    expect((await openTable(ref)).recovered).toEqual([]);
});

it('keeps re-rendering across repeated failures, preserves newer content, and respects exclusions', async () => {
    const ref = { libraryID: LIBRARY_ID, key: KEY };
    await createTable({ spec: demoSpec(), libraryID: LIBRARY_ID });
    item.saveTx.mockRejectedValue(new Error('item save unavailable'));
    expect(await writeTable(ref, demoSpec('First'), { actor: 'user' })).toMatchObject({ saved: false });
    // The open's render fails the same way, and says so.
    expect((await openTable(ref)).recovered).toContainEqual({ kind: 'bookkeeping_pending' });
    expect(await writeTable(ref, demoSpec('Newer'), { actor: 'user' })).toMatchObject({ saved: false });
    const latest = await readFile(tablePath(), 'utf8');
    item.saveTx.mockResolvedValue(item.id);
    const saves = item.saveTx.mock.calls.length;
    await expect(openTable(ref, () => { throw new Error('access refused'); })).rejects.toThrow('access refused');
    expect(item.saveTx.mock.calls.length).toBe(saves);
    expect((await openTable(ref)).recovered).toContainEqual({ kind: 'rerendered' });
    expect((await openTable(ref)).recovered).toEqual([]);
    expect(await readFile(tablePath(), 'utf8')).toBe(latest);
    expect(await readFile(htmlPath, 'utf8')).toContain('Newer');
});

describe('group tables through the store and provider', () => {
    const groupLibraryID = 7;
    const groupID = 6073928;
    const groupRef = { libraryID: groupLibraryID, key: KEY };
    const remoteKey = `g${groupID}-${KEY}`;
    let library: {
        libraryID: number;
        libraryType: string;
        editable: boolean;
        filesEditable: boolean;
    };
    let temporaryDirectories: string[];
    const request = (op: string, fields: Record<string, unknown> = {}) =>
        handleArtifactRequest({
            event: 'artifact_request',
            request_id: `group-${op}`,
            op,
            key: remoteKey,
            ...fields,
        });
    /** A retriable creation in the group, its refusal as `{ ok: false, error_code }`. */
    const create = async (spec = demoSpec(), operation_id = 'group-create', accessGuard?: (spec: TableSpec) => void) => {
        try {
            const created = await createTable({
                libraryID: groupLibraryID, title: 'Group table', spec, operation_id, actor: 'user', accessGuard,
            });
            return { ok: true as const, ...created };
        } catch (error: any) {
            return { ok: false as const, error_code: error.code as string };
        }
    };

    beforeEach(() => {
        temporaryDirectories = [];
        library = {
            libraryID: groupLibraryID,
            libraryType: 'group',
            editable: true,
            filesEditable: true,
        };
        item.libraryID = groupLibraryID;
        vi.mocked(Zotero.Libraries.get).mockImplementation(
            (id: number) =>
                (id === groupLibraryID
                    ? library
                    : id === 1
                      ? { libraryID: 1, libraryType: 'user', editable: true }
                      : false) as any,
        );
        (Zotero as any).Groups = {
            getLibraryIDFromGroupID: (id: number) => (id === groupID ? groupLibraryID : false),
            getGroupIDFromLibraryID: (id: number) => (id === groupLibraryID ? groupID : false),
        };
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockImplementation(async (id, key) =>
            id === groupLibraryID && key === KEY ? item : false,
        );
        let imported = false;
        (Zotero as any).DB = {
            queryAsync: vi.fn(async (_sql: string, params: unknown[], options: any) => {
                if (imported && params[0] === groupLibraryID)
                    options.onRow({ getResultByIndex: () => item.id });
            }),
        };
        (Zotero as any).ItemFields = { getID: () => 13 };
        (Zotero.Items as any).getAsync = vi.fn(async () => item);
        (Zotero.Attachments as any).createTemporaryStorageDirectory = vi.fn(async () => {
            const path = await mkdtemp(join(tmpdir(), 'beaver-group-import-'));
            temporaryDirectories.push(path);
            return { path };
        });
        (Zotero.Attachments as any).createURLAttachmentFromTemporaryStorageDirectory = vi.fn(
            async (options) => {
                expect(options.libraryID).toBe(groupLibraryID);
                expect(options.contentType).toBe('text/html');
                expect(options).not.toHaveProperty('parentItemID');
                await emptyStorageDirectory();
                await writeFile(
                    htmlPath,
                    await readFile(join(options.directory, options.filename), 'utf8'),
                );
                item.getField = (field: string) => (field === 'url' ? options.url : options.title);
                imported = true;
                return item;
            },
        );
    });
    afterEach(async () => {
        for (const path of temporaryDirectories) {
            expect(existsSync(path)).toBe(false);
            await rm(path, { recursive: true, force: true });
        }
    });

    it('creates in the requested group, seeds history, queues upload and replays without another import', async () => {
        const created = await create();
        expect(created).toMatchObject({ ok: true, saved: true, version: 1, libraryID: groupLibraryID, key: KEY });
        if (!created.ok) throw new Error('create failed');
        expect(created.spec.key).toBe(KEY);
        expect((await readHistory()).tip).toBe(1);
        expect(item.attachmentSyncState).toBe(0);
        expect(Zotero.FullText.queueItem).toHaveBeenCalledWith(item);
        expect(Zotero.Attachments.importFromSnapshotContent).not.toHaveBeenCalled();
        const replay = await create();
        expect(replay).toMatchObject({ ok: true, replayed: true, sha256: created.sha256 });
        expect(
            Zotero.Attachments.createURLAttachmentFromTemporaryStorageDirectory,
        ).toHaveBeenCalledTimes(1);
        expect(await request('list', { key: undefined, keys: [remoteKey] })).toMatchObject({
            ok: true,
            items: [{ key: remoteKey, unavailable: false, title: 'Group table' }],
        });
    });

    it('files into a collection in the selected group and rejects cross-library collections', async () => {
        (Zotero as any).Collections = { get: vi.fn(() => ({ libraryID: groupLibraryID })) };
        await createTable({ libraryID: groupLibraryID, collectionID: 12, spec: demoSpec() });
        expect(
            Zotero.Attachments.createURLAttachmentFromTemporaryStorageDirectory,
        ).toHaveBeenCalledWith(
            expect.objectContaining({ libraryID: groupLibraryID, collections: [12] }),
        );
        (Zotero.Collections.get as any).mockReturnValue({ libraryID: 1 });
        await expect(
            createTable({ libraryID: groupLibraryID, collectionID: 12, spec: demoSpec() }),
        ).rejects.toMatchObject({ code: 'invalid_target' });
        expect(
            Zotero.Attachments.createURLAttachmentFromTemporaryStorageDirectory,
        ).toHaveBeenCalledTimes(1);
    });

    it.each(['editable', 'filesEditable'] as const)(
        'refuses creation and mutation without %s but preserves reads',
        async (permission) => {
            library[permission] = false;
            const before = await readFile(htmlPath, 'utf8');
            expect(await create()).toMatchObject({ ok: false, error_code: 'no_writable_library' });
            expect(await request('read')).toMatchObject({ ok: true });
            expect(
                await request('revert', { to_version: 1, meta: { actor: 'user' } }),
            ).toMatchObject({ ok: false, error_code: 'invalid_target' });
            expect(await request('delete')).toMatchObject({
                ok: false,
                error_code: 'invalid_target',
            });
            expect(await readFile(htmlPath, 'utf8')).toBe(before);
            expect(Zotero.Attachments.createTemporaryStorageDirectory).not.toHaveBeenCalled();
        },
    );

    it.each(['permission', 'exclusion'])(
        'rechecks %s after staging the snapshot before importing',
        async (change) => {
            const write = IOUtils.writeUTF8;
            (IOUtils as any).writeUTF8 = async (path: string, html: string) => {
                const result = await write(path, html);
                if (change === 'permission') library.filesEditable = false;
                else checkLibraryExcluded.mockReturnValue({ message: 'Excluded' });
                return result;
            };
            expect(await create()).toMatchObject({
                ok: false,
                error_code: change === 'permission' ? 'no_writable_library' : 'library_excluded',
            });
            expect(
                Zotero.Attachments.createURLAttachmentFromTemporaryStorageDirectory,
            ).not.toHaveBeenCalled();
        },
    );

    it('rechecks source exclusions after staging and before import', async () => {
        const write = IOUtils.writeUTF8;
        (IOUtils as any).writeUTF8 = async (path: string, html: string) => {
            const result = await write(path, html);
            checkLibraryExcluded.mockImplementation((id) =>
                id === 1 ? { message: 'Excluded source' } : null,
            );
            return result;
        };
        const spec = demoSpec();
        spec.rows[0].ref = { kind: 'item', library_id: 1, zotero_key: 'SOURCEAB' };
        spec.rows[0].cells = {};
        const result = await create(spec, 'group-source', sourceGuard);
        expect(result).toMatchObject({ ok: false, error_code: 'library_excluded' });
        expect(
            Zotero.Attachments.createURLAttachmentFromTemporaryStorageDirectory,
        ).not.toHaveBeenCalled();
    });

    it('does not complete or duplicate an import when file permission is revoked before stamping', async () => {
        const write = IOUtils.writeUTF8;
        (IOUtils as any).writeUTF8 = async (path: string, html: string) => {
            const result = await write(path, html);
            if (path.endsWith('.beaver-tmp')) library.filesEditable = false;
            return result;
        };
        expect(await create()).toMatchObject({ ok: false, error_code: 'operation_pending' });
        library.filesEditable = true;
        expect(await create()).toMatchObject({ ok: false, error_code: 'operation_pending' });
        expect(
            Zotero.Attachments.createURLAttachmentFromTemporaryStorageDirectory,
        ).toHaveBeenCalledTimes(1);
    });

    it('preserves an ambiguous imported document and refuses duplicate creation after a late import error', async () => {
        const importer = vi.mocked(
            Zotero.Attachments.createURLAttachmentFromTemporaryStorageDirectory,
        );
        const original = importer.getMockImplementation()!;
        importer.mockImplementationOnce(async (options) => {
            await original(options);
            throw new Error('indexing failed after import');
        });
        expect(await create()).toMatchObject({ ok: false, error_code: 'operation_pending' });
        expect(existsSync(htmlPath)).toBe(true);
        expect(await create()).toMatchObject({ ok: false, error_code: 'operation_pending' });
        expect(importer).toHaveBeenCalledTimes(1);
    });

    it('withholds excluded group metadata before lookup and keeps the local document readable', async () => {
        checkLibraryExcluded.mockImplementation((id) =>
            id === groupLibraryID ? { message: 'Private group' } : null,
        );
        expect(await create()).toMatchObject({ ok: false, error_code: 'library_excluded' });
        expect(await request('read')).toMatchObject({ ok: false, error_code: 'library_excluded' });
        const listed = await request('list', { key: undefined, keys: [remoteKey] });
        expect(listed.items).toEqual([
            {
                key: remoteKey,
                kind: 'table',
                unavailable: true,
                error_code: 'library_excluded',
                unseen: [],
            },
        ]);
        expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
        expect(await readTable(groupRef)).toMatchObject({ spec: { title: 'Demo table' } });
    });

    it('withholds the whole group table when a source library is excluded, including conflict payloads', async () => {
        const sourced = demoSpec();
        sourced.rows[0].ref = { kind: 'item', library_id: 1, zotero_key: 'SOURCEAB' };
        await writeTable(groupRef, sourced, { actor: 'user' });
        checkLibraryExcluded.mockImplementation((id) =>
            id === 1 ? { message: 'Excluded source' } : null,
        );
        const result = await request('read');
        expect(result).toMatchObject({ ok: false, error_code: 'library_excluded' });
        expect(result).not.toHaveProperty('spec');
        expect(result).not.toHaveProperty('summary');
    });

    it('commits a model edit in the group and queues it for upload', async () => {
        item.attachmentSyncState = 1;
        expect(await applyTableEdit(
            groupRef,
            (spec) => ({ ok: true, spec: { ...spec, title: 'Edited in group' }, changes: [] }),
            { actor: 'agent', run_id: 'run' },
            { operation_id: 'group-edit', request_sha256: 'a'.repeat(64) },
        )).toMatchObject({ ok: true, saved: true, version: 2 });
        expect(item.attachmentSyncState).toBe(0);
        expect((await openTable(groupRef)).spec.title).toBe('Edited in group');
    });
});

describe('table.json storage', () => {
    const moves = () => {
        const order: string[] = [];
        const move = (globalThis as any).IOUtils.move;
        (globalThis as any).IOUtils.move = async (from: string, to: string) => {
            order.push(basename(to));
            return move(from, to);
        };
        return order;
    };

    it('reads the table from table.json, never from the snapshot', async () => {
        await writeFile(htmlPath, '<html>stale rendering</html>');
        const { spec } = await readTable(ref);
        expect(spec.rows[0].cells.note?.value).toEqual({ kind: 'text', text: 'One' });
        expect((await openTable(ref)).spec).toEqual(spec);
    });

    it('commits in order: version file, table.json, history; then renders', async () => {
        // Reconcile the seeded table's missing log first, so only the write moves.
        await openTable(ref);
        const order = moves();
        expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));
        expect(order.slice(0, 3)).toEqual(['v2.json', 'table.json', 'history.json']);
        expect(order.slice(3)).toEqual([basename(htmlPath), 'bookkeeping.json']);
    });

    it('writes a collapsing write’s version file after the commit', async () => {
        const meta = { actor: 'agent' as const, run_id: 'run', thread_id: 'thread' };
        expectOk(await writeTable(ref, demoSpec('first'), meta));
        const order = moves();
        expectOk(await writeTable(ref, demoSpec('second'), meta));
        expect(order).toEqual(['table.json', 'v2.json', 'history.json', basename(htmlPath), 'bookkeeping.json']);
    });

    it('renders the snapshot after every kind of write, with the spec hash on its root', async () => {
        const hashOnDisk = async () =>
            /data-beaver-spec-sha256="([a-f0-9]{64})"/.exec(await readFile(htmlPath, 'utf8'))?.[1];
        const created = await createTable({ spec: demoSpec('Created'), actor: 'user' });
        expect(await hashOnDisk()).toBe(created.sha256 ?? created.entry.sha256);

        const written = expectOk(await writeTable(ref, demoSpec('Written'), { actor: 'user' }));
        expect(await hashOnDisk()).toBe(written.sha256);

        const edited = await editTable(ref, [{ op: 'set_meta', title: 'Edited' }], { actor: 'user' });
        expect(edited.ok && (await hashOnDisk()) === edited.sha256).toBe(true);

        const reverted = expectOk(await revertTable(ref, 1, { actor: 'user' }));
        expect(await hashOnDisk()).toBe(reverted.sha256);

        // The provider's sha256 for the same state is the root attribute.
        const read = await handleArtifactRequest({ event: 'artifact_request', request_id: 'hash', op: 'read', key: `u-${KEY}` });
        expect(read.sha256).toBe(await hashOnDisk());
        expect(await readFile(htmlPath, 'utf8')).toContain('Created');
    });

    it('renders after a trim and after an interrupted fill', async () => {
        const meta = { actor: 'agent' as const, run_id: 'fill-run', thread_id: 'thread' };
        await createTable({ spec: demoSpec('Created'), actor: 'user' });
        // A fill commits cell by cell; the run is cancelled after two commits.
        for (const text of ['row one filled', 'row one refilled']) {
            const edited = await editTable(ref, [{ op: 'set_cells', cells: [{ row: 'r1', column: 'note', cell: { outcome: 'answered', provenance: 'model', value: { kind: 'text', text } } }] }], meta);
            expect(edited.ok).toBe(true);
        }
        expect(await readFile(htmlPath, 'utf8')).toContain('row one refilled');
        expect((await listVersions(ref)).map((entry) => entry.version)).toEqual([1, 2]);

        expect(await trimTable(ref, { thread_id: 'thread', run_ids: ['fill-run'] })).toMatchObject({ outcome: 'trimmed', trimmed_to: 1 });
        const html = await readFile(htmlPath, 'utf8');
        expect(html).toContain('Created');
        expect(html).not.toContain('row one refilled');
    });

    it('renders every write before the write returns', async () => {
        const written = expectOk(await writeTable(ref, demoSpec('rendered'), { actor: 'user' }));
        const html = await readFile(htmlPath, 'utf8');
        expect(html).toContain('rendered');
        expect(html).toContain(`data-beaver-spec-sha256="${written.sha256}"`);
        expect(JSON.parse(await readFile(sidecar('bookkeeping.json'), 'utf8'))).toMatchObject({ sha256: written.sha256 });
    });

    it('opens and writes a table still carrying receipts and a history ledger', async () => {
        expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));
        const file = await readTableFile();
        const receipt = { operation_id: 'old', request_sha256: 'a'.repeat(64), version: 2, sha256: 'b'.repeat(64) };
        await writeFile(tablePath(), JSON.stringify({ ...file, receipts: [receipt, { broken: true }] }), 'utf8');
        const history = await readHistory();
        await writeFile(sidecar('history.json'), JSON.stringify({ ...history, ledger: { receipts: [receipt] } }), 'utf8');

        expect((await openTable(ref)).spec.rows[0].cells.note?.value).toEqual({ kind: 'text', text: 'Two' });
        expect((await editTable(ref, [{ op: 'set_meta', title: 'Renamed' }], { actor: 'user' })).ok).toBe(true);
        expect((await readTable(ref)).spec.title).toBe('Renamed');
        // The next commit drops both leftovers.
        expect(await readTableFile()).not.toHaveProperty('receipts');
        expect(await readHistory()).not.toHaveProperty('ledger');
    });

    it('keeps the creation marker when a write replaces an unreadable spec', async () => {
        const creation = { operation_id: 'create', request_sha256: 'a'.repeat(64), complete: true };
        const file = await readTableFile();
        await writeFile(tablePath(), JSON.stringify({ ...file, creation }), 'utf8');
        await writeFile(tablePath(), JSON.stringify({ creation, spec: { spec_version: TABLE_SPEC_VERSION, broken: true } }), 'utf8');
        await expect(editTable(ref, [{ op: 'set_meta', title: 'X' }], { actor: 'user' })).rejects.toMatchObject({ code: 'no_spec' });
        expectOk(await writeTable(ref, demoSpec('replacement'), { actor: 'user' }));
        expect((await readTableFile()).creation).toEqual(creation);
    });

    it('reads a missing table.json beside a history as corrupt, and restoring a version repairs it', async () => {
        const written = expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));
        await rm(tablePath());
        await expect(readTable(ref)).rejects.toMatchObject({ code: 'corrupt' });
        await expect(openTable(ref)).rejects.toMatchObject({ code: 'corrupt' });
        await expect(editTable(ref, [{ op: 'set_meta', title: 'X' }], { actor: 'user' })).rejects.toMatchObject({ code: 'corrupt' });
        expect(existsSync(tablePath())).toBe(false);

        expect(await revertTable(ref, written.version, { actor: 'user' })).toMatchObject({ ok: true, version: 3 });
        const restored = await openTable(ref);
        expect(restored.spec.rows[0].cells.note?.value).toEqual({ kind: 'text', text: 'Two' });
        expect(restored.version).toBe(3);
        expect(restored.history.at(-1)).toMatchObject({ version: 3, sealed: true });
    });

    it('regenerates a missing or stale snapshot on the next read', async () => {
        await rm(htmlPath);
        await readTable(ref);
        await openTable(ref);
        expect(existsSync(htmlPath)).toBe(true);

        await writeFile(htmlPath, buildTableDocument(demoSpec('older rendering')).html);
        expect((await openTable(ref)).recovered).toContainEqual({ kind: 'rerendered' });
        const html = await readFile(htmlPath, 'utf8');
        expect(html).not.toContain('older rendering');
        expect(html).toContain(`data-beaver-spec-sha256="${(await openTable(ref)).sha256}"`);
    });

    it.each([
        ['read-only', () => (Zotero.Libraries.get as any).mockReturnValue({ editable: false, filesEditable: false })],
        ['excluded', () => checkLibraryExcluded.mockReturnValue({ message: 'excluded' } as any)],
    ])('reads a %s table with a missing table.json as corrupt and writes nothing', async (_, restrict) => {
        expectOk(await writeTable(ref, demoSpec('Two'), { actor: 'user' }));
        await rm(tablePath());
        await rm(htmlPath);
        restrict();
        await expect(openTable(ref)).rejects.toMatchObject({ code: 'corrupt' });
        expect(existsSync(tablePath())).toBe(false);
        expect(existsSync(htmlPath)).toBe(false);
    });

    it('stops a render whose library is excluded after the commit', async () => {
        const before = await readFile(htmlPath, 'utf8');
        const move = (globalThis as any).IOUtils.move;
        (globalThis as any).IOUtils.move = async (from: string, to: string) => {
            await move(from, to);
            // Excluded between the commit and the render that follows it.
            if (to === tablePath()) checkLibraryExcluded.mockReturnValue({ message: 'excluded' } as any);
        };
        const saves = item.saveTx.mock.calls.length;
        try {
            // Committed, but the render that would sync it did not happen.
            expect(expectOk(await writeTable(ref, demoSpec('excluded after commit'), { actor: 'user' })).saved).toBe(false);
        } finally {
            (globalThis as any).IOUtils.move = move;
        }
        expect(await readFile(htmlPath, 'utf8')).toBe(before);
        expect(item.saveTx).toHaveBeenCalledTimes(saves);
    });

    it('measures versions logged without a size before applying the byte bound', async () => {
        const big = (label: string) => demoSpec(`${label} ${'x'.repeat(3 * 1024 * 1024)}`);
        for (const label of ['two', 'three', 'four']) {
            expectOk(await writeTable(ref, big(label), { actor: 'user' }));
        }
        // A log from before sizes were recorded.
        const history = await readHistory();
        await writeFile(sidecar('history.json'), JSON.stringify({
            ...history,
            versions: history.versions.map(({ bytes: _bytes, ...entry }) => entry),
        }), 'utf8');
        for (const label of ['five', 'six', 'seven']) {
            expectOk(await writeTable(ref, big(label), { actor: 'user' }));
        }
        const kept = (await readHistory()).versions;
        expect(kept.every((entry) => typeof entry.bytes === 'number')).toBe(true);
        // Counted as zero, the unsized versions would all have been kept.
        expect(kept.map((entry) => entry.version)).toEqual([3, 4, 5, 6, 7]);
        expect(kept.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)).toBeLessThanOrEqual(16 * 1024 * 1024);
    });

    it('bounds retained versions by bytes beyond the floor', async () => {
        const big = (label: string) => demoSpec(`${label} ${'x'.repeat(3 * 1024 * 1024)}`);
        for (const label of ['two', 'three', 'four', 'five', 'six', 'seven']) {
            expectOk(await writeTable(ref, big(label), { actor: 'user' }));
        }
        const versions = (await readHistory()).versions.map((entry) => entry.version);
        // Five 3 MiB versions fit in 16 MiB; a sixth would not.
        expect(versions).toEqual([3, 4, 5, 6, 7]);
        expect(existsSync(sidecar('v2.json'))).toBe(false);
        const sizes = (await readHistory()).versions.map((entry) => entry.bytes ?? 0);
        expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(16 * 1024 * 1024);
    });

    it('always keeps the last three versions, even when they exceed the byte bound', async () => {
        const big = (label: string) => demoSpec(`${label} ${'x'.repeat(6 * 1024 * 1024)}`);
        for (const label of ['two', 'three', 'four', 'five']) {
            expectOk(await writeTable(ref, big(label), { actor: 'user' }));
        }
        const kept = (await readHistory()).versions;
        // Three 6 MiB versions are 18 MiB: over the byte bound, kept by the floor.
        expect(kept.map((entry) => entry.version)).toEqual([3, 4, 5]);
        expect(kept.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)).toBeGreaterThan(16 * 1024 * 1024);
        expect(existsSync(sidecar('v2.json'))).toBe(false);
        // A table this large can still go back two versions.
        expectOk(await revertTable(ref, 3, { actor: 'user' }));
    });

    it('refuses a spec of another format instead of restamping it', async () => {
        for (const spec_version of [1, TABLE_SPEC_VERSION + 1]) {
            await expect(writeTable(ref, { ...demoSpec('Old'), spec_version }, { actor: 'agent' }))
                .rejects.toMatchObject({ code: 'unsupported_version' });
        }
        expect(await storedVersion()).toBe(1);
    });

    it('refuses to open a stored table that names no format version', async () => {
        const { spec_version: _version, ...unversioned } = (await readTableFile()).spec;
        await writeFile(tablePath(), JSON.stringify({ spec: unversioned }), 'utf8');
        await expect(readTable(ref)).rejects.toMatchObject({ code: 'unsupported_version' });
    });

    it('refuses a write whose cell evidence is over the cap', async () => {
        const spec = demoSpec();
        spec.rows[0].cells.note = {
            outcome: 'answered',
            provenance: 'model',
            value: { kind: 'text', text: 'x' },
            documents: ['u-ATTACHMT'],
            evidence: Array.from({ length: 8 }, (_, i) => ({ document: 'u-ATTACHMT', locator: `s${i}`, quote: 'q'.repeat(900) })),
        };
        await expect(writeTable(ref, spec, { actor: 'agent' })).rejects.toMatchObject({ code: 'too_large' });
        const edited = await editTable(ref, [{ op: 'set_cells', cells: [{ row: 'r1', column: 'note', cell: spec.rows[0].cells.note }] }], { actor: 'agent' });
        expect(edited).toMatchObject({ ok: false, error: { code: 'too_large' } });
        expect(await storedVersion()).toBe(1);
    });

    it('reports the cell writes a fill skipped and stores the rest', async () => {
        await editTable(ref, [{ op: 'set_cells', cells: [{ row: 'r1', column: 'note', cell: { outcome: 'answered', provenance: 'user', value: { kind: 'text', text: 'mine' } } }] }], { actor: 'user' });
        const edited = await editTable(ref, [{ op: 'set_cells', cells: [{ row: 'r1', column: 'note', cell: { outcome: 'answered', provenance: 'model', value: { kind: 'text', text: 'filler' } } }] }], { actor: 'agent', run_id: 'fill' });
        expect(edited).toMatchObject({ ok: true, skipped: [{ row: 'r1', column: 'note', reason: 'user_cell' }] });
        expect((await readTable(ref)).spec.rows[0].cells.note?.value).toEqual({ kind: 'text', text: 'mine' });
    });
});

describe('item title', () => {
    it('follows a rename of the table, saved with the render', async () => {
        await editTable(ref, [{ op: 'set_meta', title: 'Renamed table' }], { actor: 'agent', run_id: 'run' });
        expect(item.title).toBe('Renamed table');
        expect(item.saveTx).toHaveBeenCalled();
        item.setField.mockClear();
        // An unchanged title is not written again.
        await editTable(ref, [{ op: 'set_meta', description: 'Now described' }], { actor: 'agent', run_id: 'run' });
        expect(item.setField).not.toHaveBeenCalled();
    });
});

describe('the fill operations', () => {
    it('reach the fill service without queue admission, the plan with the table it names', async () => {
        const run = vi.spyOn((globalThis as any).Zotero.Beaver.libraryOperations, 'run');
        const agent = {
            plan: vi.fn(async (request: any) => ({ type: 'artifact_response', request_id: request.request_id, op: 'fill_plan', ok: true, plan: {} })),
            fill: vi.fn(async (request: any) => ({ type: 'artifact_response', request_id: request.request_id, op: 'fill', ok: true, status: 'running' })),
        };
        (globalThis as any).Zotero.Beaver.tableFills = { agent };
        const context = { receivedAt: 1, reportPhase: vi.fn(), run: { runId: 'run-1', threadId: 'thread-1' } };
        const planned = await handleArtifactRequest({ event: 'artifact_request', request_id: 'p', op: 'fill_plan', key: `u-${KEY}`, columns: ['note'] });
        expect(planned).toMatchObject({ ok: true, op: 'fill_plan' });
        expect(agent.plan).toHaveBeenCalledWith(expect.objectContaining({ columns: ['note'] }), { libraryID: ref.libraryID, key: KEY });
        const filled = await handleArtifactRequest(
            { event: 'artifact_request', request_id: 'f', op: 'fill', plan_id: 'plan', tool_call_id: 'call', wait: true },
            context as any,
        );
        expect(filled).toMatchObject({ ok: true, status: 'running' });
        expect(agent.fill).toHaveBeenCalledWith(expect.objectContaining({ plan_id: 'plan' }), expect.objectContaining({ run: context.run }));
        expect(run).not.toHaveBeenCalled();
        delete (globalThis as any).Zotero.Beaver.tableFills;
        run.mockRestore();
    });

    it('refuse a plan for a table in an excluded library before asking the service', async () => {
        const agent = { plan: vi.fn(), fill: vi.fn() };
        (globalThis as any).Zotero.Beaver.tableFills = { agent };
        checkLibraryExcluded.mockReturnValue({ message: 'excluded' });
        const response = await handleArtifactRequest({ event: 'artifact_request', request_id: 'p', op: 'fill_plan', key: `u-${KEY}` });
        checkLibraryExcluded.mockReturnValue(null);
        expect(response).toMatchObject({ ok: false, error_code: 'library_excluded' });
        expect(agent.plan).not.toHaveBeenCalled();
        delete (globalThis as any).Zotero.Beaver.tableFills;
    });

    it('carry the pending work beside the summary on a read', async () => {
        const response = await handleArtifactRequest({ event: 'artifact_request', request_id: 'r', op: 'read', key: `u-${KEY}` });
        expect(response).toMatchObject({ ok: true, pending: { rows: expect.any(Number), cells: expect.any(Number) } });
    });
});

describe('the edit operations', () => {
    const meta = { actor: 'agent', run_id: 'run-edit', thread_id: 'thread-edit', change: 'Edited table' };
    const edit = (operations: unknown, operation_id = 'edit-1') =>
        handleArtifactRequest({ event: 'artifact_request', request_id: `r-${operation_id}`, op: 'apply_edit', key: `u-${KEY}`, operations, meta, operation_id });

    it('apply one edit as one sealed version and answer the change list and pending work', async () => {
        const response = await edit({ title: 'Renamed', add_columns: [{ header: 'Country', type: 'text', description: 'Where?' }] });
        expect(response).toMatchObject({
            ok: true,
            version: 2,
            replayed: false,
            changes: [{ op: 'title', title: 'Renamed' }, { op: 'add_column', column: 'country', header: 'Country' }],
            pending: { cells: 1 },
        });
        const versions = await listVersions(ref);
        expect(versions.at(-1)).toMatchObject({ version: 2, sealed: true, operation_id: 'edit-1' });
    });

    it('answer a repeat with the same id from its version, and refuse the id reused for another edit', async () => {
        await edit({ title: 'Once' });
        const repeat = await edit({ title: 'Once' });
        expect(repeat).toMatchObject({ ok: true, replayed: true, version: 2, changes: [{ op: 'title', title: 'Once' }] });
        const reused = await edit({ title: 'Twice' });
        expect(reused).toMatchObject({ ok: false, error_code: 'operation_mismatch' });
        expect(await storedVersion()).toBe(2);
    });

    it('keep the replay record of an edit on the device: versions leave without it', async () => {
        await edit({ title: 'Once' });
        const response = await handleArtifactRequest({ event: 'artifact_request', request_id: 'v', op: 'versions', key: `u-${KEY}` });
        const last = response.versions!.at(-1)! as any;
        expect(last.version).toBe(2);
        expect(last.changes).toBeUndefined();
        expect(last.operation_id).toBeUndefined();
    });

    it('refuse an edit of a table a read refuses as invalid, writing nothing', async () => {
        const file = await readTableFile();
        const spec = { ...file.spec, columns: [...file.spec.columns, file.spec.columns.at(-1)!] };
        await writeFile(tablePath(), JSON.stringify({ ...file, spec }), 'utf8');
        const read = await handleArtifactRequest({ event: 'artifact_request', request_id: 'r', op: 'read', key: `u-${KEY}` });
        expect(read).toMatchObject({ ok: false, error_code: 'invalid_spec' });
        for (const [operations, id] of [[{ title: 'Never' }, 'edit-a'], [{ refresh_sources: true }, 'edit-b']] as const) {
            expect(await edit(operations, id)).toMatchObject({ ok: false, error_code: 'invalid_spec' });
        }
        expect(await storedVersion()).toBe(file.spec.version);
        expect((await listVersions(ref)).some((entry) => entry.operation_id)).toBe(false);
    });

    it('refuse the whole call on an unknown id, naming the parameter and index', async () => {
        const response = await edit({ title: 'Never', remove_columns: ['note', 'gone'] }, 'edit-bad');
        expect(response).toMatchObject({ ok: false, error_code: 'unknown_column' });
        expect(response.error).toContain('remove_columns[1]');
        expect((await readTable(ref)).spec.title).toBe('Demo table');
    });

    it('preview sources without queue admission or a write', async () => {
        const run = vi.spyOn((globalThis as any).Zotero.Beaver.libraryOperations, 'run');
        resolvedSources.resolveSources.mockResolvedValueOnce([
            {
                entry: { id: 's1', type: 'items', ids: ['u-AAAAAAAA'] },
                papers: [{ row: { id: 'r', ref: { kind: 'item', library_ref: 'u', zotero_key: 'AAAAAAAA' }, cells: {}, documents: ['u-AAAAAPDF'] }, mode: 'document' }],
                total: 1,
                truncated: false,
                rejected: [{ id: 'u-NOTE1111', error: 'not a regular item' }],
            },
        ]);
        const response = await handleArtifactRequest({
            event: 'artifact_request',
            request_id: 'preview',
            op: 'preview',
            sources: [{ id: 's1', type: 'items', ids: ['u-AAAAAAAA', 'u-NOTE1111'] }],
            columns: [{ header: 'N', type: 'text' }],
        });
        expect(response).toMatchObject({
            ok: true,
            preview: { rows: 1, documents: 1, duplicates: 0, row_cap: 1000, sources: [{ count: 1, rejected: [{ id: 'u-NOTE1111' }] }] },
        });
        expect(run).not.toHaveBeenCalled();
        run.mockRestore();
    });

    it('refuse a preview whose column the engine refuses', async () => {
        const response = await handleArtifactRequest({
            event: 'artifact_request',
            request_id: 'preview-bad',
            op: 'preview',
            sources: [{ id: 's1', type: 'items', ids: ['u-AAAAAAAA'] }],
            columns: [{ header: 'D', type: 'select', options: [{ label: 'A' }, { label: 'a' }] }],
        });
        expect(response).toMatchObject({ ok: false, error_code: 'invalid_edit' });
    });
});

describe('fill commits', () => {
    const meta = { actor: 'agent', run_id: 'run-fill', thread_id: 'thread-fill', change: 'Filled table', collapse_key: 'job-1' } as const;
    const answer = (row: string, text: string, extra: Record<string, unknown> = {}) => ({
        row,
        column: 'note',
        cell: { outcome: 'answered', value: { kind: 'text', text }, provenance: 'model' },
        ...extra,
    });
    const commit = (cells: unknown[], mutations?: unknown[]) =>
        editTableSessionUncoordinated(
            ref,
            { mutations: (mutations ?? [{ op: 'set_cells', cells }]) as any },
            meta as any,
        );

    it('the provider no longer takes `edit`: a fill commits only through the plugin job', async () => {
        const response = await handleArtifactRequest({
            event: 'artifact_request',
            request_id: 'edit-1',
            op: 'edit',
            key: `u-${KEY}`,
            operation_id: 'session-1',
            edit_seq: 1,
            mutations: [{ op: 'set_cells', cells: [answer('r1', 'No')] }],
            meta,
        });
        expect(response).toMatchObject({ ok: false, error_code: 'unsupported_op' });
        expect(await storedVersion()).toBe(1);
    });

    it('commits cell writes without a revision guard and renders the snapshot as part of the commit', async () => {
        const result = await commit([answer('r1', 'Filled')]);
        expect(result).toMatchObject({ ok: true, version: 2, saved: true, skipped: [] });
        const { spec } = await readTable(ref);
        expect(spec.rows[0].cells.note.value).toEqual({ kind: 'text', text: 'Filled' });
        const html = await readFile(htmlPath, 'utf8');
        expect(html).toContain(`data-beaver-file-sha256="${await sha256(await readFile(tablePath(), 'utf8'))}"`);
    });

    it('collapses every commit of one job into one retained version', async () => {
        for (let n = 1; n <= 5; n++) {
            const result = await commit([answer('r1', `Commit ${n}`)]);
            expect(result).toMatchObject({ ok: true, version: 2 });
        }
        expect((await readHistory()).versions.map((v) => v.version)).toEqual([1, 2]);
        expect((await readTable(ref)).spec.rows[0].cells.note.value).toEqual({ kind: 'text', text: 'Commit 5' });
    });

    it('skips writes to a removed row or column and lands the rest of the commit', async () => {
        const result = await commit([
            answer('gone', 'Lost row'),
            { ...answer('r1', 'Lost column'), column: 'removed' },
            answer('r1', 'Kept'),
        ]);
        expect(result).toMatchObject({ ok: true, version: 2 });
        expect(result.ok && result.skipped).toEqual([
            { row: 'gone', column: 'note', reason: 'row_removed' },
            { row: 'r1', column: 'removed', reason: 'column_removed' },
        ]);
        expect((await readTable(ref)).spec.rows[0].cells.note.value).toEqual({ kind: 'text', text: 'Kept' });
    });

    it('skips user cells and answers to a changed question', async () => {
        const stale = await commit([{ ...answer('r1', 'Old question'), question_hash: '0000000000000000' }]);
        expect(stale.ok && stale.skipped).toEqual([{ row: 'r1', column: 'note', reason: 'question_changed' }]);
        await editTable(ref, [{ op: 'set_cells', cells: [{ row: 'r1', column: 'note', cell: { outcome: 'cleared', provenance: 'user' } }] }], { actor: 'user' });
        const user = await commit([answer('r1', 'Over the user')]);
        expect(user.ok && user.skipped).toEqual([{ row: 'r1', column: 'note', reason: 'user_cell' }]);
        expect((await readTable(ref)).spec.rows[0].cells.note).toMatchObject({ outcome: 'cleared', provenance: 'user' });
    });

    it('fails the whole commit on an invalid cell, with nothing written', async () => {
        const result = await commit([
            answer('r1', 'Fine'),
            { row: 'r1', column: 'note', cell: { outcome: 'answered', provenance: 'model' } },
        ]);
        expect(result).toMatchObject({ ok: false, error: { code: 'invalid_mutation' } });
        expect(await storedVersion()).toBe(1);
    });

    it('publishes the update event after each commit', async () => {
        const publish = vi.fn();
        (globalThis as any).Zotero.Beaver.runtime = { publish };
        await commit([answer('r1', 'Filled')]);
        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledWith('beaverTableUpdated', { libraryID: ref.libraryID, key: KEY, version: 2, actor: 'agent', run_id: 'run-fill' });
        delete (globalThis as any).Zotero.Beaver.runtime;
    });

    it('applies row updates with their expected documents, skipping a removed row', async () => {
        const failure = { code: 'encrypted', message: 'The PDF is password-protected.' };
        const result = await commit([], [
            { op: 'update_row', row: 'r1', documents: ['u-ATTACHMT'], failure },
            { op: 'update_row', row: 'gone', failure },
        ]);
        expect(result).toMatchObject({ ok: true, skipped: [{ row: 'gone', reason: 'row_removed' }] });
        expect((await readTable(ref)).spec.rows[0]).toMatchObject({ documents: ['u-ATTACHMT'], failure });
    });
});

