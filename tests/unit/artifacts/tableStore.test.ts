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
    TABLE_VERSION_RETENTION,
    type TableHistory,
    type TableWriteResult,
} from '../../../src/services/artifacts/tableStore';

// ---------------------------------------------------------------------------
// A temp directory standing in for the attachment's storage directory
// ---------------------------------------------------------------------------

const LIBRARY_ID = 1;
const KEY = 'TBL00001';

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
        // No event bus on the test window: the store must degrade silently.
        getMainWindow: vi.fn(() => null),
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
        item.hasTag = () => false;

        await expect(readTable(ref)).rejects.toMatchObject({ code: 'not_a_table' });
    });
});
