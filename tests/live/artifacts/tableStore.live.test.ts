/**
 * Live tests for the versioned table store (`src/services/artifacts/tableStore.ts`)
 * against a running, authenticated Zotero.
 *
 * What only a real instance can show: that creation seeds the log at version 1
 * and seals it, that a run's writes collapse onto one version while the created
 * version survives underneath them, that the write protocol produces the storage
 * layout it claims (`beaver/history.json` plus one `v<N>.json` per version,
 * beside the rendered `.html`), that the document round-trips back through the
 * parse path, that a revert moves forward rather than back — including all the
 * way to version 1 — and that a write leaves the attachment marked `to_upload`,
 * the one step whose omission is silent and costly because the new bytes then
 * sit locally with nothing to tell Zotero they changed.
 *
 * Each `describe` creates and trashes its own table and asserts only versions it
 * produced itself, so a filtered run (`-t`) reports the truth rather than the
 * previous block's leftovers.
 *
 * The storage directory is inspected with plain file I/O: the tests run on the
 * same machine as the instance they drive.
 *
 * Prerequisites: dev build running + authenticated, and a writable personal
 * library. The tables this suite creates are left in the trash.
 * Run: npm run test:live -- tableStore
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isZoteroAvailable, skipIfNoZotero } from '../../helpers/zoteroAvailability';
import { post } from '../../helpers/zoteroHttpClient';

/** Zotero's `SYNC_STATE_TO_UPLOAD`. */
const TO_UPLOAD = 0;

interface CreateResponse {
    ok: boolean;
    code?: string;
    error?: string;
    key: string;
    library_id: number;
    storage_directory: string | null;
    version: number;
    entry?: {
        version: number;
        actor: string;
        run_id?: string;
        change?: string;
        sha256: string;
        sealed?: boolean;
    };
}

interface WriteResponse {
    ok: boolean;
    code?: string;
    error?: string;
    version: number;
    collapsed: boolean;
    saved: boolean;
    pruned: number[];
    entry?: { version: number; actor: string; change?: string; sha256: string };
    columns?: string[];
    spec_issues?: unknown[];
}

interface ReadResponse {
    ok: boolean;
    code?: string;
    error?: string;
    sync_state: number;
    version: number;
    storage_directory: string | null;
    spec: {
        title?: string;
        version?: number;
        key?: string;
        rows: unknown[];
        columns: Array<{ id: string }>;
    };
    spec_issues: unknown[];
}

interface VersionsResponse {
    ok: boolean;
    version: number;
    count: number;
    versions: Array<{
        version: number;
        actor: string;
        run_id?: string;
        change?: string;
        sealed?: boolean;
        summary: { rows: number };
    }>;
}

let available = false;

function spec(title: string, note: string) {
    return {
        id: 'live-table-store',
        title,
        columns: [{ id: 'note', header: 'Note', type: 'text' as const }],
        rows: [
            {
                id: 'r1',
                cells: {
                    note: {
                        value: { kind: 'text' as const, text: note },
                        provenance: 'asserted' as const,
                    },
                },
            },
        ],
    };
}

interface Table {
    key: string;
    libraryID: number;
    storageDir: string;
    created: CreateResponse;
}

/** A table of this suite's own, so no block depends on another's versions. */
async function makeTable(title: string, extra: Record<string, unknown> = {}): Promise<Table> {
    const created = await post<CreateResponse>('/beaver/test/table-create', {
        spec: spec(title, 'One'),
        title,
        ...extra,
    });
    expect(created.ok, `${created.code}: ${created.error}`).toBe(true);
    return {
        key: created.key,
        libraryID: created.library_id,
        storageDir: created.storage_directory ?? '',
        created,
    };
}

/** The store's own delete is the trash, which is what a user would get. */
async function dropTable(table: Table | null): Promise<void> {
    if (!table) return;
    await post('/beaver/test/table-delete', {
        key: table.key,
        libraryID: table.libraryID,
    }).catch(() => undefined);
}

function sidecar(table: Table, name: string): string {
    return join(table.storageDir, 'beaver', name);
}

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) {
        console.warn('\n⚠  Zotero not available — tableStore live tests will be skipped.\n');
    }
});

describe('creating a table', () => {
    let table: Table | null = null;

    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!table) table = await makeTable('Live store — creation');
    });
    afterAll(async () => dropTable(table));

    it('lands as a real attachment with a storage directory', () => {
        expect(table!.key).toMatch(/^[A-Z0-9]{8}$/);
        expect(existsSync(table!.storageDir)).toBe(true);
        expect(table!.created.version).toBe(1);
    });

    it('seeds and seals the version log, so the created state stays revertable', async () => {
        expect(table!.created.entry).toMatchObject({ version: 1, sealed: true });
        expect(existsSync(sidecar(table!, 'v1.json'))).toBe(true);

        const history = JSON.parse(await readFile(sidecar(table!, 'history.json'), 'utf8'));
        expect(history.tip).toBe(1);
        expect(history.versions.map((v: { version: number }) => v.version)).toEqual([1]);
    });
});

describe('writing versions', () => {
    let table: Table | null = null;

    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (table) return;
        table = await makeTable('Live store — writes');
        for (const [index, version] of [2, 3, 4].entries()) {
            const written = await post<WriteResponse>('/beaver/test/table-write', {
                key: table.key,
                libraryID: table.libraryID,
                spec: spec('Live store — writes', `Version ${version}`),
                actor: 'user',
                change: `Write ${index + 1}`,
            });
            expect(written.ok, `${written.code}: ${written.error}`).toBe(true);
            expect(written.version).toBe(version);
            expect(written.collapsed).toBe(false);
            expect(written.saved).toBe(true);
            expect(written.spec_issues).toEqual([]);
        }
    });
    afterAll(async () => dropTable(table));

    it('holds the log and one file per version, version 1 included', async () => {
        const history = JSON.parse(await readFile(sidecar(table!, 'history.json'), 'utf8'));
        expect(history.tip).toBe(4);
        expect(history.versions.map((v: { version: number }) => v.version)).toEqual([
            1, 2, 3, 4,
        ]);

        for (const version of [1, 2, 3, 4]) {
            expect(existsSync(sidecar(table!, `v${version}.json`))).toBe(true);
        }
    });

    it('reads the newest spec back through the document parse path', async () => {
        const read = await post<ReadResponse>('/beaver/test/table-read', {
            key: table!.key,
            libraryID: table!.libraryID,
        });

        expect(read.ok, `${read.code}: ${read.error}`).toBe(true);
        expect(read.version).toBe(4);
        expect(read.spec.key).toBe(table!.key);
        expect(read.spec.version).toBe(4);
        expect(read.spec_issues).toEqual([]);
    });

    it('marks the attachment for upload, so the new bytes actually sync', async () => {
        const read = await post<ReadResponse>('/beaver/test/table-read', {
            key: table!.key,
            libraryID: table!.libraryID,
        });

        expect(read.sync_state).toBe(TO_UPLOAD);
    });

    it('lists the version log with a summary per entry', async () => {
        const listed = await post<VersionsResponse>('/beaver/test/table-versions', {
            key: table!.key,
            libraryID: table!.libraryID,
        });

        expect(listed.ok).toBe(true);
        expect(listed.version).toBe(4);
        expect(listed.versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
        expect(listed.versions[0].summary.rows).toBe(1);
    });

    it('finds nothing to recover on a table written cleanly', async () => {
        const opened = await post<{ ok: boolean; recovered: unknown[]; version: number }>(
            '/beaver/test/table-open',
            { key: table!.key, libraryID: table!.libraryID }
        );

        expect(opened.ok).toBe(true);
        expect(opened.version).toBe(4);
        expect(opened.recovered).toEqual([]);
    });
});

describe('a run filling a table', () => {
    // The whole run happens once, in setup, and each test asserts one step of
    // it — so a filtered run still exercises the sequence it reports on.
    let table: Table | null = null;
    let runFirst: WriteResponse;
    let runSecond: WriteResponse;
    let userEdit: WriteResponse;
    let reverted: WriteResponse;
    let listed: VersionsResponse;
    let afterCollapse: ReadResponse;
    let afterRevert: ReadResponse;
    const runId = `live-run-${Date.now()}`;

    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (table) return;

        // Created *by* the run that then fills it, which is the real agent
        // shape and the one that needs sealing to be safe.
        table = await makeTable('Live store — run', { actor: 'agent', run_id: runId });
        const at = { key: table.key, libraryID: table.libraryID };

        const addColumn = (id: string, header: string) => ({
            ...at,
            mutations: [
                { op: 'add_columns', columns: [{ id, header, type: 'text' }] },
            ],
            actor: 'agent',
            run_id: runId,
        });

        runFirst = await post<WriteResponse>('/beaver/test/table-edit', addColumn('a', 'A'));
        runSecond = await post<WriteResponse>('/beaver/test/table-edit', addColumn('b', 'B'));
        listed = await post<VersionsResponse>('/beaver/test/table-versions', at);
        afterCollapse = await post<ReadResponse>('/beaver/test/table-read', at);

        userEdit = await post<WriteResponse>('/beaver/test/table-edit', {
            ...at,
            mutations: [{ op: 'set_meta', title: 'Renamed by the user' }],
            actor: 'user',
            run_id: runId,
        });

        reverted = await post<WriteResponse>('/beaver/test/table-revert', {
            ...at,
            toVersion: 1,
            actor: 'user',
        });
        afterRevert = await post<ReadResponse>('/beaver/test/table-read', at);
    });
    afterAll(async () => dropTable(table));

    it("appends the creating run's first write rather than absorbing version 1", () => {
        expect(runFirst.ok, `${runFirst.code}: ${runFirst.error}`).toBe(true);
        expect(runFirst).toMatchObject({ version: 2, collapsed: false });
    });

    it('collapses the second write of the same run onto the version it owns', () => {
        expect(runSecond.ok, `${runSecond.code}: ${runSecond.error}`).toBe(true);
        expect(runSecond).toMatchObject({ version: 2, collapsed: true });
        // Both mutations survived the collapse.
        expect(afterCollapse.spec.columns.map((c) => c.id)).toEqual(['note', 'a', 'b']);
    });

    it('leaves the created version sealed and intact underneath the run', () => {
        expect(listed.versions.map((v) => v.version)).toEqual([1, 2]);
        expect(listed.versions[0]).toMatchObject({ version: 1, sealed: true });
    });

    it('gives a user edit inside the run its own version', () => {
        expect(userEdit.ok, `${userEdit.code}: ${userEdit.error}`).toBe(true);
        expect(userEdit).toMatchObject({ version: 3, collapsed: false });
    });

    it('reverts all the way back to the version the table was created in', async () => {
        expect(reverted.ok, `${reverted.code}: ${reverted.error}`).toBe(true);
        expect(reverted.version).toBe(4);
        expect(reverted.entry?.change).toBe('Reverted to version 1');

        // The bytes the seed preserved, restored as the current table.
        const v1 = JSON.parse(await readFile(sidecar(table!, 'v1.json'), 'utf8'));
        expect(afterRevert.spec.rows).toEqual(v1.rows);
        expect(afterRevert.spec.columns.map((c) => c.id)).toEqual(['note']);
    });
});

describe('the trash', () => {
    let table: Table | null = null;

    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (!table) table = await makeTable('Live store — trash');
    });
    afterAll(async () => dropTable(table));

    it('trashes a table and takes it back out again', async () => {
        const deleted = await post<{ ok: boolean; deleted: boolean }>(
            '/beaver/test/table-delete',
            { key: table!.key, libraryID: table!.libraryID }
        );
        expect(deleted).toMatchObject({ ok: true, deleted: true });

        const restored = await post<{ ok: boolean; deleted: boolean }>(
            '/beaver/test/table-delete',
            { key: table!.key, libraryID: table!.libraryID, restore: true }
        );
        expect(restored).toMatchObject({ ok: true, deleted: false });

        const read = await post<ReadResponse>('/beaver/test/table-read', {
            key: table!.key,
            libraryID: table!.libraryID,
        });
        expect(read.ok).toBe(true);
        expect(read.version).toBe(1);
    });
});
