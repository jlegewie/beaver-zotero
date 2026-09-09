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
import { readFile, writeFile, rm } from 'node:fs/promises';
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

describe('remote retry and conversation rewind', () => {
    const tables: Table[] = [];
    beforeEach((ctx) => skipIfNoZotero(ctx, available));
    afterAll(async () => {
        for (const table of tables) await dropTable(table);
    });

    it('deduplicates creates, guards collapsed content, replays writes and preserves a user boundary', async () => {
        const operationId = `live-create-${Date.now()}`;
        const createRequest = {
            spec: spec('Live remote contract', 'One'),
            actor: 'agent',
            run_id: 'origin',
            thread_id: 'thread',
            operation_id: operationId,
        };
        const created = await post<any>('/beaver/test/table-create', createRequest);
        expect(created.ok, created.error).toBe(true);
        const table: Table = {
            key: created.key,
            libraryID: created.library_id,
            storageDir: created.storage_directory,
            created,
        };
        tables.push(table);
        const replayedCreate = await post<any>('/beaver/test/table-create', createRequest);
        expect(replayedCreate).toMatchObject({ ok: true, key: table.key, replayed: true });
        expect(created.filename).toBe('live-remote-contract.html');
        expect(replayedCreate.filename).toBe(created.filename);
        expect(replayedCreate.operation).toEqual(created.operation);
        expect(
            await post<any>('/beaver/test/table-create', {
                ...createRequest,
                spec: spec('Changed request', 'One'),
            })
        ).toMatchObject({ ok: false, code: 'operation_mismatch' });

        const at = { key: table.key, libraryID: table.libraryID };
        const owner = { actor: 'agent', run_id: 'discard', thread_id: 'thread' };
        await post('/beaver/test/table-write', {
            ...at,
            ...owner,
            spec: spec('Live remote contract', 'Base'),
        });
        const base = await post<any>('/beaver/test/table-open', at);
        expect(base.sha256).toMatch(/^[a-f0-9]{64}$/);
        const request = {
            ...at,
            ...owner,
            expectedVersion: base.version,
            expected_sha256: base.sha256,
            spec: spec('Live remote contract', 'Winner'),
            operation_id: 'first',
        };
        const [first, second] = await Promise.all([
            post<any>('/beaver/test/table-write', request),
            post<any>('/beaver/test/table-write', {
                ...request,
                operation_id: 'second',
                spec: spec('Live remote contract', 'Loser'),
            }),
        ]);
        const winner = first.ok ? first : second;
        const loser = first.ok ? second : first;
        expect(winner).toMatchObject({ ok: true, collapsed: true, version: base.version });
        expect(loser).toMatchObject({ ok: false, conflict: true, version: base.version });
        const winningRequest = first.ok
            ? request
            : { ...request, operation_id: 'second', spec: spec('Live remote contract', 'Loser') };
        const replay = await post<any>('/beaver/test/table-write', winningRequest);
        expect(replay).toMatchObject({ ok: true, replayed: true });
        expect(replay.operation).toEqual(winner.operation);

        await post('/beaver/test/table-write', {
            ...at,
            ...owner,
            actor: 'user',
            spec: spec('Live remote contract', 'User boundary'),
        });
        await post('/beaver/test/table-write', {
            ...at,
            ...owner,
            spec: spec('Live remote contract', 'Discard this'),
        });
        const trimmed = await post<any>('/beaver/test/table-trim', {
            ...at,
            thread_id: 'thread',
            run_ids: ['discard'],
        });
        expect(trimmed).toMatchObject({ ok: true, outcome: 'trimmed', trimmed_to: 3, saved: true });
        const opened = await post<any>('/beaver/test/table-open', at);
        expect(opened.spec.rows[0].cells.note.value.text).toBe('User boundary');
        expect(opened.conflict).toBeNull();
        expect(opened.recovered).toEqual([]);
        expect(existsSync(sidecar(table, 'v4.json'))).toBe(false);
        expect(await post<any>('/beaver/test/table-write', winningRequest)).toMatchObject({
            ok: true,
            replayed: true,
            version: 3,
            operation: winner.operation,
        });
    });

    it('finishes creation bookkeeping when the stamped import has no history seed', async () => {
        const request = { operation_id: `live-create-repair-${Date.now()}`, actor: 'agent',
            thread_id: 'thread', run_id: 'run', spec: spec('Live creation repair', 'One') };
        const created = await post<any>('/beaver/test/table-create', request);
        expect(created.ok, created.error).toBe(true);
        const table: Table = { key: created.key, libraryID: created.library_id,
            storageDir: created.storage_directory, created };
        tables.push(table);
        await rm(sidecar(table, 'history.json'));
        await rm(sidecar(table, 'v1.json'));
        const replay = await post<any>('/beaver/test/table-create', request);
        expect(replay).toMatchObject({ ok: true, key: created.key, replayed: true,
            entry: { version: 1, creation: true, sealed: true, actor: 'agent', run_id: 'run' } });
        expect(existsSync(sidecar(table, 'v1.json'))).toBe(true);
        const at = { key: table.key, libraryID: table.libraryID };
        expect((await post<any>('/beaver/test/table-versions', at)).versions).toHaveLength(1);
        expect((await post<any>('/beaver/test/table-read', at)).sync_state).toBe(TO_UPLOAD);
    });

    it('trashes the discarded creation despite its seal and does not resurrect it on create replay', async () => {
        const operation_id = `live-discard-create-${Date.now()}`;
        const request = {
            operation_id,
            actor: 'agent',
            thread_id: 'thread',
            run_id: 'discard',
            spec: spec('Live discarded creation', 'One'),
        };
        const created = await post<any>('/beaver/test/table-create', request);
        expect(created.ok, created.error).toBe(true);
        tables.push({
            key: created.key,
            libraryID: created.library_id,
            storageDir: created.storage_directory,
            created,
        });
        const at = { key: created.key, libraryID: created.library_id };
        expect(
            await post<any>('/beaver/test/table-trim', {
                ...at,
                thread_id: 'thread',
                run_ids: ['discard'],
            })
        ).toMatchObject({ outcome: 'trashed', trimmed_versions: [1], trimmed_to: null });
        expect(await post<any>('/beaver/test/table-create', request)).toMatchObject({
            ok: false,
            code: 'operation_pending',
        });
        expect(
            await post<any>('/beaver/test/table-trim', {
                ...at,
                thread_id: 'thread',
                run_ids: ['discard'],
            })
        ).toMatchObject({ outcome: 'unchanged' });
    });
});

describe('trim boundaries and stored citation cleanup', () => {
    const tables: Table[] = [];
    beforeEach((ctx) => skipIfNoZotero(ctx, available));
    afterAll(async () => {
        for (const table of tables) await dropTable(table);
    });

    it.each(['system', 'other-thread'])(
        'preserves the %s boundary in real history files',
        async (boundary) => {
            const table = await makeTable(`Live trim ${boundary}`);
            tables.push(table);
            const at = { key: table.key, libraryID: table.libraryID };
            const owner = { actor: 'agent', thread_id: 'thread', run_id: 'discard' };
            await post('/beaver/test/table-write', {
                ...at,
                ...owner,
                actor: boundary === 'system' ? 'system' : 'agent',
                thread_id: boundary === 'other-thread' ? 'other' : 'thread',
                spec: spec('Boundary', 'Keep'),
            });
            await post('/beaver/test/table-write', {
                ...at,
                ...owner,
                spec: spec('Discard', 'Remove'),
            });
            expect(
                await post<any>('/beaver/test/table-trim', {
                    ...at,
                    thread_id: 'thread',
                    run_ids: ['discard'],
                })
            ).toMatchObject({
                outcome: 'trimmed',
                trimmed_to: 2,
                trimmed_versions: [3],
                saved: true,
            });
            const opened = await post<any>('/beaver/test/table-open', at);
            expect(opened.spec.title).toBe('Boundary');
            expect(opened.conflict).toBeNull();
        }
    );

    it('adopts a surviving version file before trimming across a lost log entry', async () => {
        const owner = { actor: 'agent', thread_id: 'thread', run_id: 'discard' };
        const table = await makeTable('Live lost history boundary', owner);
        tables.push(table);
        const at = { key: table.key, libraryID: table.libraryID };
        expect(await post<any>('/beaver/test/table-write', {
            ...at, actor: 'user', spec: spec('Protected boundary', 'Keep'),
        })).toMatchObject({ ok: true, version: 2 });
        expect(await post<any>('/beaver/test/table-write', {
            ...at, ...owner, spec: spec('Discarded suffix', 'Remove'),
        })).toMatchObject({ ok: true, version: 3 });
        const path = sidecar(table, 'history.json');
        const history = JSON.parse(await readFile(path, 'utf8'));
        history.versions = history.versions.filter((entry: { version: number }) => entry.version !== 2);
        await writeFile(path, JSON.stringify(history));

        expect(await post<any>('/beaver/test/table-trim', {
            ...at, thread_id: 'thread', run_ids: ['discard'],
        })).toMatchObject({ outcome: 'trimmed', trimmed_to: 2, trimmed_versions: [3], saved: true });
        const opened = await post<any>('/beaver/test/table-open', at);
        expect(opened.spec.title).toBe('Protected boundary');
        expect(opened.history.find((entry: { version: number }) => entry.version === 2))
            .toMatchObject({ actor: 'system', sealed: true });
        expect(opened.conflict).toBeNull();
        expect(existsSync(sidecar(table, 'v2.json'))).toBe(true);
        expect(existsSync(sidecar(table, 'v3.json'))).toBe(false);
    });

    it.each([2, 3])('persists repaired v%i history even when trim leaves the table unchanged', async (missingVersion) => {
        const table = await makeTable('Live unchanged trim recovery', { actor: 'user' });
        tables.push(table);
        const at = { key: table.key, libraryID: table.libraryID };
        for (const version of [2, 3]) {
            expect(await post<any>('/beaver/test/table-write', {
                ...at, actor: 'user', spec: spec('Live unchanged trim recovery', String(version)),
            })).toMatchObject({ ok: true, version });
        }
        const path = sidecar(table, 'history.json');
        const history = JSON.parse(await readFile(path, 'utf8'));
        history.versions = history.versions.filter((entry: { version: number }) => entry.version !== missingVersion);
        history.tip = history.versions[history.versions.length - 1].version;
        await writeFile(path, JSON.stringify(history));

        expect(await post<any>('/beaver/test/table-trim', {
            ...at, thread_id: 'thread', run_ids: ['discard'],
        })).toMatchObject({ outcome: 'unchanged', trimmed_to: 3, saved: true });
        const listed = await post<any>('/beaver/test/table-versions', at);
        expect(listed.versions.map((entry: { version: number }) => entry.version)).toEqual([1, 2, 3]);
        expect(JSON.parse(await readFile(path, 'utf8')).tip).toBe(3);
        expect((await post<any>('/beaver/test/table-open', at)).recovered).toEqual([]);
    });

    it('reports versions pruned while replay repairs history left behind its receipt', async () => {
        const table = await makeTable('Live replay retention');
        tables.push(table);
        const at = { key: table.key, libraryID: table.libraryID };
        for (let version = 2; version <= 20; version++) {
            expect(await post<any>('/beaver/test/table-write', {
                ...at, actor: 'user', spec: spec('Live replay retention', String(version)),
            })).toMatchObject({ ok: true, version });
        }
        const historyPath = sidecar(table, 'history.json');
        const historyBefore = await readFile(historyPath, 'utf8');
        const oldestPath = sidecar(table, 'v1.json');
        const oldestBefore = await readFile(oldestPath, 'utf8');
        const base = await post<any>('/beaver/test/table-open', at);
        const request = {
            ...at, actor: 'agent', run_id: 'retention-run', thread_id: 'thread',
            operation_id: 'retention-replay', expectedVersion: base.version,
            expected_sha256: base.sha256, spec: spec('Live replay retention', 'New'),
        };
        expect(await post<any>('/beaver/test/table-write', request))
            .toMatchObject({ ok: true, version: 21, pruned: [1] });
        // Restore the sidecars an interruption before history commit would leave.
        await writeFile(historyPath, historyBefore);
        await writeFile(oldestPath, oldestBefore);
        expect(await post<any>('/beaver/test/table-write', request))
            .toMatchObject({ ok: true, replayed: true, saved: true, pruned: [1] });
        expect(existsSync(oldestPath)).toBe(false);
        const listed = await post<any>('/beaver/test/table-versions', at);
        expect(listed.versions.map((entry: { version: number }) => entry.version))
            .toEqual(Array.from({ length: 20 }, (_, i) => i + 2));
        expect(await post<any>('/beaver/test/table-write', request))
            .toMatchObject({ ok: true, replayed: true, pruned: [] });
    });

    it('reports retention exhaustion while preserving the oldest retained version', async () => {
        const table = await makeTable('Live retention exhaustion');
        tables.push(table);
        const at = { key: table.key, libraryID: table.libraryID };
        const runs: string[] = [];
        for (let i = 0; i < 22; i++) {
            const run = `discard-${i}`;
            runs.push(run);
            const written = await post<any>('/beaver/test/table-write', {
                ...at,
                actor: 'agent',
                thread_id: 'thread',
                run_id: run,
                spec: spec('Live retention exhaustion', String(i)),
            });
            expect(written.ok, written.error).toBe(true);
        }
        const history = await post<any>('/beaver/test/table-versions', at);
        const oldest = history.versions[0].version;
        expect(oldest).toBeGreaterThan(1);
        expect(
            await post<any>('/beaver/test/table-trim', {
                ...at,
                thread_id: 'thread',
                run_ids: runs,
            })
        ).toMatchObject({
            outcome: 'trimmed',
            retention_exhausted: true,
            trimmed_to: oldest,
            saved: true,
        });
        const opened = await post<any>('/beaver/test/table-open', at);
        expect(opened.version).toBe(oldest);
        expect(opened.conflict).toBeNull();
        expect(opened.history).toHaveLength(1);
    });

    it('prunes a cleared stored citation while retaining a shared citation and its parent metadata', async () => {
        const table = await makeTable('Live citation pruning');
        tables.push(table);
        const at = { key: table.key, libraryID: table.libraryID };
        const tag = '<citation id="1-CHILD001"/>';
        const cited = spec('Live citation pruning', `Evidence ${tag}`);
        cited.rows.push({ ...cited.rows[0], id: 'r2' });
        const parent_ref = { kind: 'zotero', library_id: 1, zotero_key: 'PARENT01' };
        await post('/beaver/test/table-write', {
            ...at,
            actor: 'user',
            spec: {
                ...cited,
                citations: [
                    { citation_id: 'live-citation', raw_tag: tag, parent_ref },
                    { citation_id: 'unused', raw_tag: '<citation id="1-UNUSED01"/>' },
                ],
            },
        });
        const edit = (rows: string[]) =>
            post('/beaver/test/table-edit', {
                ...at,
                actor: 'user',
                mutations: [
                    {
                        op: 'set_cells',
                        cells: rows.map((row) => ({ row, column: 'note', cell: {} })),
                    },
                ],
            });
        await edit(['r1']);
        const shared = await post<any>('/beaver/test/table-open', at);
        expect(shared.spec.citations).toEqual([
            { citation_id: 'live-citation', raw_tag: tag, parent_ref },
        ]);
        await edit(['r2']);
        const cleared = await post<any>('/beaver/test/table-open', at);
        expect(cleared.spec.citations).toEqual([]);
        expect(
            JSON.parse(await readFile(sidecar(table, `v${cleared.version}.json`), 'utf8')).citations
        ).toEqual([]);
    });
});
