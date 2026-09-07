/**
 * Live tests for the stored-table recovery shadow
 * (`src/services/artifacts/recoveryShadow.ts`) against a running,
 * authenticated Zotero.
 *
 * What only a real instance can show: that the shadow is a real row in
 * `beaver.sqlite` with a real gzipped spec beside it under the profile, written
 * as a side effect of the ordinary write path; that a table whose whole storage
 * directory has been rolled back — the state a Zotero file conflict resolved
 * toward another device leaves, with the document, the log and the version
 * files all agreeing — is reported as a conflict and *not* as something the
 * store repaired; and that restoring puts this device's spec back as a new
 * version while the state the conflict left keeps its own number in the log.
 *
 * The rollback is staged through `table-corrupt`'s `sync_conflict` mode, which
 * writes behind the store's back on purpose. A table with an ordinary history
 * must stay silent, which the first block asserts before anything is damaged.
 *
 * Prerequisites: dev build running + authenticated, and a writable personal
 * library. The tables this suite creates are left in the trash.
 * Run: npm run test:live -- recoveryShadow
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isZoteroAvailable, skipIfNoZotero } from '../../helpers/zoteroAvailability';
import { post } from '../../helpers/zoteroHttpClient';

interface CreateResponse {
    ok: boolean;
    code?: string;
    error?: string;
    key: string;
    library_id: number;
    storage_directory: string | null;
    version: number;
}

interface WriteResponse {
    ok: boolean;
    code?: string;
    error?: string;
    version: number;
    collapsed: boolean;
    entry?: { version: number; sha256: string };
}

interface ShadowEntry {
    libraryID: number;
    key: string;
    version: number;
    sha256: string;
    writtenAt: string;
    payloadPath: string | null;
    payloadBytes: number;
}

interface Conflict {
    kind: string;
    reason: 'behind' | 'diverged';
    documentVersion: number;
    shadowVersion: number;
    restorable: boolean;
}

interface ShadowResponse {
    ok: boolean;
    code?: string;
    error?: string;
    document_version: number;
    retention: number;
    max_payload_bytes: number;
    total_bytes: number;
    last: ShadowEntry | null;
    entries: ShadowEntry[];
    conflict: Conflict | null;
}

interface CorruptResponse {
    ok: boolean;
    code?: string;
    error?: string;
    mode: string;
    from_version: number;
    version: number;
    removed_versions: number[];
}

interface OpenResponse {
    ok: boolean;
    code?: string;
    error?: string;
    version: number;
    recovered: unknown[];
    conflict: Conflict | null;
    spec: { rows: Array<{ cells: Record<string, { value?: { text?: string } }> }> };
}

interface RestoreResponse {
    ok: boolean;
    code?: string;
    error?: string;
    version: number;
    restored_from: number;
}

interface VersionsResponse {
    ok: boolean;
    version: number;
    versions: Array<{ version: number; change?: string }>;
}

let available = false;

function spec(title: string, note: string) {
    return {
        id: 'live-recovery-shadow',
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
}

async function makeTable(title: string): Promise<Table> {
    const created = await post<CreateResponse>('/beaver/test/table-create', {
        spec: spec(title, 'One'),
        title,
    });
    expect(created.ok, `${created.code}: ${created.error}`).toBe(true);
    return {
        key: created.key,
        libraryID: created.library_id,
        storageDir: created.storage_directory ?? '',
    };
}

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

function at(table: Table): { key: string; libraryID: number } {
    return { key: table.key, libraryID: table.libraryID };
}

/** The text in the table's only cell, as the store reads it back. */
function noteOf(opened: OpenResponse): string | undefined {
    return opened.spec.rows[0]?.cells.note?.value?.text;
}

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) {
        console.warn('\n⚠  Zotero not available — recoveryShadow live tests will be skipped.\n');
    }
});

describe('the shadow of an ordinary table', () => {
    let table: Table | null = null;
    let shadow: ShadowResponse;

    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (table) return;
        table = await makeTable('Live shadow — ordinary');
        const written = await post<WriteResponse>('/beaver/test/table-write', {
            ...at(table),
            spec: spec('Live shadow — ordinary', 'Two'),
            actor: 'user',
        });
        expect(written.ok, `${written.code}: ${written.error}`).toBe(true);
        shadow = await post<ShadowResponse>('/beaver/test/table-shadow', at(table));
    });
    afterAll(async () => dropTable(table));

    it('records each write, newest first, with a gzipped spec on disk', () => {
        expect(shadow.ok, `${shadow.code}: ${shadow.error}`).toBe(true);
        expect(shadow.entries.map((entry) => entry.version)).toEqual([2, 1]);
        expect(shadow.last!.version).toBe(2);
        expect(shadow.last!.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(shadow.last!.payloadPath).toBeTruthy();
        // Outside the storage directory: that is the whole point, since the
        // storage directory is what a sync conflict replaces.
        expect(existsSync(shadow.last!.payloadPath!)).toBe(true);
        expect(shadow.last!.payloadPath!.startsWith(table!.storageDir)).toBe(false);
        expect(shadow.total_bytes).toBeGreaterThan(0);
    });

    it('reports no conflict, which is what almost every table must get', async () => {
        expect(shadow.conflict).toBeNull();

        const opened = await post<OpenResponse>('/beaver/test/table-open', at(table!));
        expect(opened.ok, `${opened.code}: ${opened.error}`).toBe(true);
        expect(opened.conflict).toBeNull();
        expect(opened.recovered).toEqual([]);
    });

    it('keeps only the last few versions', () => {
        expect(shadow.retention).toBeGreaterThanOrEqual(3);
        expect(shadow.entries.length).toBeLessThanOrEqual(shadow.retention);
    });
});

describe('a table a sync conflict rolled back', () => {
    // One rollback, staged in setup, with each test asserting a step of it — so
    // a filtered run still exercises the sequence it reports on.
    let table: Table | null = null;
    let corrupted: CorruptResponse;
    /**
     * Whether the rolled-back version files were gone *at that moment*. Sampled
     * in setup rather than asserted later, because the restore below writes a
     * new version 3 — so by the end of the sequence `v3.json` exists again, and
     * legitimately so.
     */
    let sidecarAfterConflict: { v3: boolean; v2: boolean };
    let afterConflict: OpenResponse;
    let restored: RestoreResponse;
    let afterRestore: OpenResponse;
    let versions: VersionsResponse;

    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        if (table) return;

        table = await makeTable('Live shadow — conflict');
        for (const note of ['Two', 'Mine']) {
            const written = await post<WriteResponse>('/beaver/test/table-write', {
                ...at(table),
                spec: spec('Live shadow — conflict', note),
                actor: 'user',
            });
            expect(written.ok, `${written.code}: ${written.error}`).toBe(true);
        }

        // The other device's copy wins the file conflict: the whole storage
        // directory goes back to version 2.
        corrupted = await post<CorruptResponse>('/beaver/test/table-corrupt', {
            ...at(table),
            mode: 'sync_conflict',
            toVersion: 2,
        });
        expect(corrupted.ok, `${corrupted.code}: ${corrupted.error}`).toBe(true);
        sidecarAfterConflict = {
            v3: existsSync(sidecar(table, 'v3.json')),
            v2: existsSync(sidecar(table, 'v2.json')),
        };

        afterConflict = await post<OpenResponse>('/beaver/test/table-open', at(table));
        restored = await post<RestoreResponse>(
            '/beaver/test/table-restore-shadow',
            { ...at(table), actor: 'user' }
        );
        afterRestore = await post<OpenResponse>('/beaver/test/table-open', at(table));
        versions = await post<VersionsResponse>('/beaver/test/table-versions', at(table));
    });
    afterAll(async () => dropTable(table));

    it('leaves the table internally consistent, so nothing looks damaged', () => {
        expect(corrupted.from_version).toBe(3);
        expect(corrupted.version).toBe(2);
        expect(corrupted.removed_versions).toEqual([3]);
        expect(sidecarAfterConflict.v3).toBe(false);
        expect(sidecarAfterConflict.v2).toBe(true);
    });

    it('reports the loss as a conflict rather than as something it repaired', () => {
        expect(afterConflict.ok, `${afterConflict.code}: ${afterConflict.error}`).toBe(true);
        expect(afterConflict.version).toBe(2);
        expect(noteOf(afterConflict)).toBe('Two');
        // Nothing to repair — the copy that arrived agrees with itself.
        expect(afterConflict.recovered).toEqual([]);
        expect(afterConflict.conflict).toMatchObject({
            kind: 'sync_conflict',
            reason: 'behind',
            documentVersion: 2,
            shadowVersion: 3,
            restorable: true,
        });
    });

    it('writes this device\'s version back as a new one', () => {
        expect(restored.ok, `${restored.code}: ${restored.error}`).toBe(true);
        expect(restored.restored_from).toBe(3);
        expect(restored.version).toBe(3);
        expect(noteOf(afterRestore)).toBe('Mine');
        expect(afterRestore.version).toBe(3);
        expect(afterRestore.conflict).toBeNull();
    });

    it('leaves the state the conflict brought in still in the history', async () => {
        expect(versions.versions.map((entry) => entry.version)).toEqual([1, 2, 3]);
        // The other device's version 2 keeps its number and its file, so the
        // user can go back to it as easily as they came from it.
        const theirs = JSON.parse(await readFile(sidecar(table!, 'v2.json'), 'utf8'));
        expect(theirs.rows[0].cells.note.value.text).toBe('Two');
        expect(versions.versions[2].change).toMatch(/Restored/);
    });
});
