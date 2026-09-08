/**
 * What *this device* last wrote to each stored table, kept outside the table.
 *
 * ## The failure it exists for
 *
 * A table is a Zotero snapshot attachment, and its whole storage directory —
 * the rendered `.html`, `beaver/history.json`, every `beaver/v<N>.json` —
 * syncs as one file. Zotero resolves a *file* conflict by asking the user to
 * keep the local copy or the remote one (`storageLocal.js::resolveConflicts`),
 * showing nothing but modification times. There is no merge, and Beaver is
 * never consulted.
 *
 * So a user with two devices can lose a table's newer state silently, and the
 * table looks perfectly healthy afterwards: the document, the log and the
 * version files all came from the same remote copy, so they agree with each
 * other. The store's crash recovery reasons about exactly that agreement, so
 * it cannot see this at all — nothing inside the storage directory survived to
 * disagree with.
 *
 * The shadow is the thing that survives, because it is not in the storage
 * directory: a SQLite row plus a gzipped spec under the profile, neither of
 * which Zotero syncs or overwrites. On the next open the table's version is
 * compared against it, and a table that has gone *backwards* is reported.
 *
 * ## What it is not
 *
 * It is not a repair. Everything the store repairs on open is a case where one
 * answer is provably right and the store applies it. This one is a decision
 * only the user can make — the remote state may well be the one they want —
 * so detection is reported and {@link readTableShadowSpec} is offered, and
 * nothing is written back until they ask.
 *
 * ## Bundle
 *
 * Esbuild-safe, deliberately: the item-pane section is compiled into
 * `beaver.js` and has to be able to say a table is in this state. So nothing
 * here may import `tableStore.ts`/`tableItem.ts` or anything reaching `react/`.
 * The write-back lives in the store, which owns the write protocol —
 * `restoreShadowVersion`.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { readSpec, type TableSpec } from '@beaver/agent-core/layouts/table';
import { gunzipToString, gzipUtf8BytesChunked } from '../../utils/gzip';
import { sha256Hex } from '../../utils/hash';
import type { TableRef } from './tableItemIdentity';

/**
 * The slice of `BeaverDB` this module uses, as the global typings expose it —
 * a narrowed subset of the class `database.ts` exports.
 */
type ShadowDB = NonNullable<typeof Zotero.Beaver.db>;

// ---------------------------------------------------------------------------
// The storage budget
// ---------------------------------------------------------------------------

/**
 * How many written versions one table keeps a spec for.
 *
 * Three, because the point is to be able to hand back a *lost* version, and
 * the one a conflict took is not always the very last: a device can write,
 * sync, write again and only then lose the pair. Beyond three it stops being
 * insurance and starts being a second copy of the version log — which the
 * table already carries, inside the directory this exists to survive.
 */
export const TABLE_SHADOW_RETENTION = 3;

/**
 * The largest gzipped spec worth retaining, per version.
 *
 * A table's spec is JSON with one entry per cell; a large one is a megabyte or
 * so raw, which gzips to a fraction of that. This cap is not a tuning knob but
 * a refusal: past it the shadow records the version and its digest — so the
 * conflict is still *detected* — and simply has nothing to restore. Reporting
 * a conflict it cannot undo is strictly better than silently filling the
 * profile directory.
 */
export const TABLE_SHADOW_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * The most one table may hold across all its retained versions.
 *
 * Deliberately less than {@link TABLE_SHADOW_RETENTION} times the per-version
 * cap, so it is a real limit rather than arithmetic that can never bind: an
 * ordinary table is nowhere near it and keeps all three versions, while a table
 * whose specs are megabytes each keeps fewer. Bounded either way, which is what
 * a directory nothing else ever cleans up needs.
 */
export const TABLE_SHADOW_MAX_TABLE_BYTES = 2 * TABLE_SHADOW_MAX_PAYLOAD_BYTES;

/** Where the gzipped specs live, under the Zotero profile. */
const SHADOW_DIR_NAME = 'table-shadow';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** One version this device wrote, as retained. */
export interface TableShadowEntry {
    libraryID: number;
    key: string;
    version: number;
    /** SHA-256 of the serialised spec this device wrote for that version. */
    sha256: string;
    /** ISO timestamp of the write. */
    writtenAt: string;
    /** The gzipped spec, or null when it exceeded the per-version cap. */
    payloadPath: string | null;
    payloadBytes: number;
}

/**
 * The table as it stands, for comparison. `sha256` is over the serialised spec
 * and may be null: a caller that has only the version log's word for the tip
 * still gets the version comparison, which is the case that actually loses
 * data.
 */
export interface TableShadowObservation {
    version: number;
    sha256: string | null;
}

/** Why the comparison failed. */
export type TableSyncConflictReason =
    /** The table is at a *lower* version than this device wrote. */
    | 'behind'
    /** Same version number, different content: two devices numbered in parallel. */
    | 'diverged';

/**
 * A table that went backwards under this device — the state a resolved file
 * conflict leaves behind. Never one of the store's `TableRecovery` kinds: those
 * are repairs the store performs, this is a decision it refuses to make.
 */
export interface TableSyncConflict {
    kind: 'sync_conflict';
    reason: TableSyncConflictReason;
    /** The version the table is at now. */
    documentVersion: number;
    /** Null when the caller could not cheaply hash the current spec. */
    documentSha256: string | null;
    /** The version this device wrote, and lost. */
    shadowVersion: number;
    shadowSha256: string;
    /** When this device wrote it. */
    writtenAt: string;
    /** Whether the retained spec is still here to be restored. */
    restorable: boolean;
}

/** Everything known about one table's shadow, for a dev endpoint or a pane. */
export interface TableShadowReport {
    libraryID: number;
    key: string;
    /** Most recently written first. */
    entries: TableShadowEntry[];
    /** The version this device wrote last, or null when it never wrote one. */
    last: TableShadowEntry | null;
    /** Total retained bytes for this table. */
    totalBytes: number;
    conflict: TableSyncConflict | null;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * The plugin database, or null before it is up.
 *
 * `Zotero.Beaver` rather than the bare `addon` global: this module is compiled
 * into both bundles and `addon` exists in only one of them. Null is a normal
 * answer during startup and teardown, and every caller degrades to "no shadow"
 * rather than failing — the shadow is bookkeeping about writes that have
 * already landed.
 */
function shadowDb(): ShadowDB | null {
    return Zotero.Beaver?.db ?? null;
}

/** `<profile>/beaver/table-shadow/<libraryID>`, created on demand. */
async function shadowDirectory(libraryID: number): Promise<string> {
    const directory = PathUtils.join(
        Zotero.Profile.dir,
        'beaver',
        SHADOW_DIR_NAME,
        String(libraryID)
    );
    await IOUtils.makeDirectory(directory, {
        createAncestors: true,
        ignoreExisting: true,
    });
    return directory;
}

/**
 * Content-addressed, like the document cache's payloads: the digest is in the
 * name, so a rewrite of the same version with the same content reuses the file
 * and a rewrite with different content never lands on top of bytes something
 * else still points at.
 */
function payloadName(key: string, version: number, sha256: string): string {
    return `${key}.v${version}.${sha256}.json.gz`;
}

async function removeQuietly(path: string): Promise<void> {
    await IOUtils.remove(path, { ignoreAbsent: true }).catch((error) =>
        logger(`recoveryShadow: could not remove ${path}: ${String(error)}`, 2)
    );
}

function toEntry(record: {
    libraryId: number;
    zoteroKey: string;
    version: number;
    sha256: string;
    writtenAt: string;
    payloadPath: string | null;
    payloadSizeBytes: number;
}): TableShadowEntry {
    return {
        libraryID: record.libraryId,
        key: record.zoteroKey,
        version: record.version,
        sha256: record.sha256,
        writtenAt: record.writtenAt,
        payloadPath: record.payloadPath,
        payloadBytes: record.payloadSizeBytes,
    };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Records a version this device wrote, and applies the budget.
 *
 * `serialized` must be the exact string whose digest is `sha256` — the bytes
 * the store put in `beaver/v<N>.json` — because that digest is what a later
 * open compares the document against. Re-serialising here would make the two
 * sides of that comparison different computations, and any drift between them
 * would report a conflict on every ordinary open.
 *
 * One row per version number, so a run that collapses a hundred cell writes onto
 * one version keeps one row rather than a hundred. The cost of that choice is
 * that writing the same number again replaces what was retained under it: after
 * a conflict has been detected, an ordinary edit — which takes the number the
 * lost version had — ends the chance to restore it. Detect, then restore.
 *
 * Never throws: the caller is past its commit point, so a shadow that could
 * fail a write would trade a real table for a bookkeeping error.
 */
export async function recordTableShadow(
    ref: TableRef,
    version: number,
    serialized: string,
    sha256: string
): Promise<TableShadowEntry | null> {
    const db = shadowDb();
    if (!db) {
        logger('recoveryShadow: no database; skipping the shadow', 2);
        return null;
    }

    try {
        // What this version pointed at before, so a collapsing write does not
        // strand it. An agent run filling a column reuses one version number a
        // hundred times, and each of those writes has different bytes and so a
        // different content-addressed name: one row, a hundred files.
        const superseded =
            (await db.getTableShadows(ref.libraryID, ref.key)).find(
                (row) => row.version === version
            )?.payloadPath ?? null;

        const payload = await writePayload(ref, version, serialized, sha256);
        const entry: TableShadowEntry = {
            libraryID: ref.libraryID,
            key: ref.key,
            version,
            sha256,
            writtenAt: new Date().toISOString(),
            payloadPath: payload.path,
            payloadBytes: payload.bytes,
        };
        await db.upsertTableShadow({
            libraryId: entry.libraryID,
            zoteroKey: entry.key,
            version: entry.version,
            sha256: entry.sha256,
            writtenAt: entry.writtenAt,
            payloadPath: entry.payloadPath,
            payloadSizeBytes: entry.payloadBytes,
        });
        await enforceBudget(ref);
        // After the budget, so the survivors this is checked against are final.
        await removeUnreferencedPayloads(ref, [superseded]);
        return entry;
    } catch (error) {
        logger(
            `recoveryShadow: could not record ${ref.key} v${version}: ${String(error)}`,
            2
        );
        return null;
    }
}

/**
 * The gzipped spec on disk, or `{ path: null }` when it is over the cap.
 *
 * Compression comes first so the cap applies to what is actually stored, and
 * it is the shared chunked deflate the document cache uses — this runs on the
 * main thread right after a write, and a multi-megabyte spec compressed in one
 * synchronous pass is a visible stall.
 */
async function writePayload(
    ref: TableRef,
    version: number,
    serialized: string,
    sha256: string
): Promise<{ path: string | null; bytes: number }> {
    const bytes = await gzipUtf8BytesChunked(new TextEncoder().encode(serialized));
    if (bytes.byteLength > TABLE_SHADOW_MAX_PAYLOAD_BYTES) {
        logger(
            `recoveryShadow: ${ref.key} v${version} is ${bytes.byteLength} gzipped bytes, ` +
                `over the ${TABLE_SHADOW_MAX_PAYLOAD_BYTES}-byte cap; recording it without a spec`,
            2
        );
        return { path: null, bytes: 0 };
    }

    const directory = await shadowDirectory(ref.libraryID);
    const path = PathUtils.join(directory, payloadName(ref.key, version, sha256));
    const temp = `${path}.${Date.now().toString(16)}.tmp`;
    // Temp file and rename, so a reader never meets a half-written payload: a
    // restore trusts these bytes, and a truncated one would fail its digest
    // check instead of being obviously absent.
    await IOUtils.write(temp, bytes);
    await IOUtils.move(temp, path);
    return { path, bytes: bytes.byteLength };
}

/**
 * Deletes the payloads among `paths` that no surviving row points at.
 *
 * The single rule for taking a payload away, used by everything that can leave
 * one behind — a row that was dropped, and a row whose `payload_path` was
 * replaced. The survivor check is what makes it safe rather than tidy: names
 * are content-addressed, so a rewrite that produces the bytes the version
 * already held resolves to the same file, and the path a row is recorded as
 * giving up can be the path it still has. Only a path no surviving row names
 * may go.
 *
 * A row without a file is a restore that promises a spec it cannot produce, and
 * a file without a row is a byte nothing will ever collect — the shadow lives
 * under the profile, where nothing else cleans up after it.
 */
async function removeUnreferencedPayloads(
    ref: TableRef,
    paths: Array<string | null>
): Promise<void> {
    const candidates = paths.filter((path): path is string => !!path);
    if (candidates.length === 0) return;
    const db = shadowDb();
    if (!db) return;

    const referenced = new Set(
        (await db.getTableShadows(ref.libraryID, ref.key))
            .map((row) => row.payloadPath)
            .filter((path): path is string => !!path)
    );
    for (const path of candidates) {
        if (!referenced.has(path)) await removeQuietly(path);
    }
}

/** Drops retained versions until the table is inside both caps. */
async function enforceBudget(ref: TableRef): Promise<void> {
    const db = shadowDb();
    if (!db) return;

    // `rows` is newest first, so the budget keeps a prefix and drops the rest:
    // once a version has fallen out, everything older than it goes too. Keeping
    // a smaller older version because it happened to fit would leave a gap in
    // the retained range, which is not a thing to reason about.
    const rows = await db.getTableShadows(ref.libraryID, ref.key);
    const doomed: number[] = [];
    let total = 0;
    let full = false;
    for (const [index, row] of rows.entries()) {
        full ||=
            index >= TABLE_SHADOW_RETENTION ||
            total + row.payloadSizeBytes > TABLE_SHADOW_MAX_TABLE_BYTES;
        if (full) doomed.push(row.version);
        else total += row.payloadSizeBytes;
    }
    if (doomed.length === 0) return;

    const removed = await db.deleteTableShadowVersions(ref.libraryID, ref.key, doomed);
    await removeUnreferencedPayloads(
        ref,
        removed.map((row) => row.payloadPath)
    );
}

/**
 * Forgets a table entirely — every row and every payload.
 *
 * Called when the table is deleted: the shadow describes a table that no longer
 * exists, and the whole reason it lives outside the storage directory is that
 * nothing else would ever clean it up.
 */
export async function pruneTableShadow(ref: TableRef): Promise<number> {
    const db = shadowDb();
    if (!db) return 0;
    try {
        const removed = await db.deleteTableShadows(ref.libraryID, ref.key);
        for (const row of removed) {
            if (row.payloadPath) await removeQuietly(row.payloadPath);
        }
        return removed.length;
    } catch (error) {
        logger(`recoveryShadow: could not prune ${ref.key}: ${String(error)}`, 2);
        return 0;
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every retained version for a table, most recently written first. */
export async function readTableShadow(ref: TableRef): Promise<TableShadowEntry[]> {
    const db = shadowDb();
    if (!db) return [];
    try {
        return (await db.getTableShadows(ref.libraryID, ref.key)).map(toEntry);
    } catch (error) {
        logger(`recoveryShadow: could not read ${ref.key}: ${String(error)}`, 2);
        return [];
    }
}

/** The version this device wrote last, or null when it never wrote one. */
export async function lastTableShadow(
    ref: TableRef
): Promise<TableShadowEntry | null> {
    return (await readTableShadow(ref))[0] ?? null;
}

/**
 * The retained spec, or null when there is nothing to restore.
 *
 * The payload is checked against the digest the row recorded before it is
 * handed back. A payload that no longer matches cannot be vouched for, and
 * restoring bytes we cannot vouch for would make a state the user never saw
 * the current one — the same rule the store applies to its own version files.
 */
export async function readTableShadowSpec(
    entry: TableShadowEntry
): Promise<TableSpec | null> {
    if (!entry.payloadPath) return null;
    try {
        if (!(await IOUtils.exists(entry.payloadPath))) return null;
        const serialized = gunzipToString(await IOUtils.read(entry.payloadPath));
        if ((await sha256Hex(serialized)) !== entry.sha256) {
            logger(
                `recoveryShadow: ${entry.key} v${entry.version} no longer matches its digest`,
                1
            );
            return null;
        }
        const read = readSpec(JSON.parse(serialized));
        return read.ok ? read.spec : null;
    } catch (error) {
        logger(
            `recoveryShadow: could not read ${entry.key} v${entry.version}: ${String(error)}`,
            2
        );
        return null;
    }
}

// ---------------------------------------------------------------------------
// Detecting
// ---------------------------------------------------------------------------

/**
 * SHA-256 of a spec the way the store hashes one, so the two sides of the
 * comparison are the same computation over the same bytes.
 */
export async function tableSpecHash(spec: TableSpec): Promise<string> {
    return sha256Hex(JSON.stringify(spec));
}

/**
 * Whether the table went backwards under this device.
 *
 * Pure, and deliberately conservative — a false positive here would appear on
 * every open of every table, which is worse than the loss it warns about. So
 * only two things count:
 *
 * - the table is at a **lower** version than this device wrote. Numbers only
 *   ever go up through the store, so this cannot happen except by the storage
 *   directory being replaced with an older copy.
 * - the table is at the **same** version with different bytes. Two devices both
 *   numbered N and the conflict kept the other one.
 *
 * Everything else is silence. A table *ahead* of the shadow is the ordinary
 * case (another device wrote, or this one did and the shadow is a write
 * behind); an observation with no digest can only be judged on its number; and
 * a table this device never wrote to has nothing to compare against.
 */
export function detectTableSyncConflict(
    shadow: TableShadowEntry | null,
    observed: TableShadowObservation
): TableSyncConflict | null {
    if (!shadow || !Number.isFinite(observed.version) || observed.version <= 0) {
        return null;
    }

    let reason: TableSyncConflictReason;
    if (observed.version < shadow.version) {
        reason = 'behind';
    } else if (
        observed.version === shadow.version &&
        observed.sha256 !== null &&
        observed.sha256 !== shadow.sha256
    ) {
        reason = 'diverged';
    } else {
        return null;
    }

    return {
        kind: 'sync_conflict',
        reason,
        documentVersion: observed.version,
        documentSha256: observed.sha256,
        shadowVersion: shadow.version,
        shadowSha256: shadow.sha256,
        writtenAt: shadow.writtenAt,
        restorable: !!shadow.payloadPath,
    };
}

/**
 * The shadow for a table plus the conflict, if any, against an observation the
 * caller already has. One shape for the dev endpoint and the item-pane section.
 */
export async function inspectTableShadow(
    ref: TableRef,
    observed: TableShadowObservation | null
): Promise<TableShadowReport> {
    const entries = await readTableShadow(ref);
    const last = entries[0] ?? null;
    return {
        libraryID: ref.libraryID,
        key: ref.key,
        entries,
        last,
        totalBytes: entries.reduce((sum, entry) => sum + entry.payloadBytes, 0),
        conflict: observed ? detectTableSyncConflict(last, observed) : null,
    };
}
