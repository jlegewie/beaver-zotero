/**
 * The versioned store for stored tables — every write to a table file goes
 * through here, and nothing else may write one.
 *
 * A table is a Zotero snapshot attachment whose embedded {@link TableSpec} is
 * the only copy of its state ({@link createTableItem}). There is no database
 * row to rebuild it from, so the file *is* the commit: the whole point of this
 * module is that a write either leaves the previous table intact or leaves the
 * new one intact, never something in between, and that the numbers it hands out
 * for the states it has produced never move.
 *
 * ## Storage layout, inside the attachment's storage directory
 *
 * ```
 * <slug>.html            always render(spec); carries the canonical spec
 * beaver/history.json    { tip, versions: [ … ] }
 * beaver/v<N>.json       the full spec of version N
 * ```
 *
 * `beaver/`, not `.beaver/`. The storage directory as a whole is what syncs for
 * a stored file attachment, and Zotero's zip writer (`Zotero.File`'s
 * `_addZipEntries`) skips every **file** whose name starts with a dot — so
 * anything that has to travel with the table must avoid dot names. The write
 * temporaries below use them for exactly the opposite reason: a temp file left
 * behind by a crash never reaches the server.
 *
 * ## Two sources of truth, and which one wins
 *
 * The document is the state; the sidecar is bookkeeping about it. Everything
 * here follows from that: the document is written at the commit point and every
 * disagreement is resolved in its favour, by rebuilding the sidecar rather than
 * by rolling the document back. {@link openTable} is where that repair happens.
 *
 * ## Addressing
 *
 * A table is addressed by {@link TableRef} — a library id and a Zotero item
 * key. The item key *is* the table's identity; there is no separate artifact
 * id, which is why the spec written to disk is always stamped with the key of
 * the item it lives in rather than with whatever the caller passed.
 *
 * This module lives in the esbuild bundle but is imported by the webpack one,
 * so it never touches the bare `addon` global.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    readSpec,
    TABLE_SPEC_VERSION,
    type TableSpec,
} from '@beaver/agent-core/layouts/table';
import {
    applyMutations,
    summarize,
    type ApplyError,
    type TableMutation,
} from '@beaver/agent-core/layouts/tableMutations';
import { sha256Hex } from '../../utils/hash';
import { checkLibraryExcluded } from '../agentDataProvider/utils';
import { zoteroLinksFor } from './view/tableLinks';
import { buildTableDocument } from './tableDocument';
import {
    createTableItem,
    normalizeTableHistory,
    queueTableFullText,
    readTableItemSpec,
    resolveTableItem,
    restoreTableItem,
    tableHistoryPath,
    tableReadError,
    tableSidecarDirectory,
    tableVersionPath,
    trashTableItem,
    EMPTY_TABLE_HISTORY,
    TableItemError,
    type CreatedTableItem,
    type CreateTableItemOptions,
    type TableActor,
    type TableHistory,
    type TableRef,
    type TableVersionEntry,
} from './tableItem';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

// Addressing, reading and the shape of the version log live next door, so that
// the esbuild bundle can reach them without reaching this module (which imports
// the library-exclusion check and through it the whole React graph).
// Re-exported here because this is the store's public surface: `readTable` is
// still "read a table through the store", with one implementation, and a caller
// that already imports `TableVersionEntry` from here keeps working.
//
// Only the *shape* and the read moved. Every write to `history.json` is still
// this module's, under its lock.
export {
    normalizeTableHistory,
    readTable,
    readTableHistory,
    resolveTableItem,
} from './tableItemIdentity';
export type {
    TableActor,
    TableHistory,
    TableRef,
    TableVersionEntry,
} from './tableItemIdentity';

export interface TableWriteMeta {
    actor: TableActor;
    /** The agent run this write belongs to, if any. Drives version collapsing. */
    run_id?: string;
    thread_id?: string;
    /** One line describing what changed, for a history list. */
    change?: string;
}

/** What {@link openTable} had to repair. */
export type TableRecovery =
    /** The document was ahead of the log: the commit landed, the log did not. */
    | { kind: 'history_appended'; version: number }
    /** The log claimed versions the document never committed. */
    | { kind: 'history_truncated'; versions: number[] }
    /** Version files at or below the commit point the log had lost track of. */
    | { kind: 'history_adopted'; versions: number[] }
    /** The tip's version file disagreed with its entry and was rewritten. */
    | { kind: 'version_file_repaired'; version: number }
    /** Version files above the commit point: writes that never committed. */
    | { kind: 'orphan_removed'; versions: number[] }
    /** Versions the retention cap dropped while the log was being rewritten. */
    | { kind: 'pruned'; versions: number[] };

export interface TableWriteOk {
    ok: true;
    version: number;
    /** True when this write replaced the version it found instead of adding one. */
    collapsed: boolean;
    /**
     * False when the post-commit item save did not land. The table on disk is
     * still the new one; only Zotero's own bookkeeping is behind — see
     * {@link markForUpload}.
     */
    saved: boolean;
    /** The spec as stored: `key`, `version` and `spec_version` stamped in. */
    spec: TableSpec;
    entry: TableVersionEntry;
    /** Versions the retention cap dropped, if any. */
    pruned: number[];
}

/**
 * The write was refused because the table moved under the caller. `spec` is the
 * table as it stands, so the caller can rebase on it; it is null only when the
 * stored file itself is unreadable.
 */
export interface TableWriteConflict {
    ok: false;
    conflict: true;
    version: number;
    spec: TableSpec | null;
}

export type TableWriteResult = TableWriteOk | TableWriteConflict;

/** {@link editTable} also fails when the mutations themselves are wrong. */
export interface TableEditRejected {
    ok: false;
    error: ApplyError;
}

export type TableEditResult = TableWriteResult | TableEditRejected;

export interface CreateTableOptions extends CreateTableItemOptions {
    /** Who is creating it. Defaults to `agent`. */
    actor?: TableActor;
    run_id?: string;
    thread_id?: string;
    /** The line the version log shows for version 1. */
    change?: string;
}

export interface CreatedTable extends CreatedTableItem {
    /** Always 1: a new table starts its own history. */
    version: number;
    entry: TableVersionEntry;
}

export interface OpenTableResult {
    ref: TableRef;
    spec: TableSpec;
    version: number;
    history: TableVersionEntry[];
    /** Empty on a table whose sidecar already agreed with its document. */
    recovered: TableRecovery[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How many version files a table keeps. Older entries fall out of the log and
 * their files are deleted, so a long-lived table's storage directory — which is
 * uploaded whole on every sync — stays bounded.
 */
export const TABLE_VERSION_RETENTION = 20;

/** The line version 1 carries when the caller does not supply one. */
const CREATED_CHANGE = 'Created the table';

/** What an entry rebuilt from the document says it is. */
const RECOVERED_CHANGE = 'Recovered from an interrupted write';

/** What an entry rebuilt from a version file the log had lost says it is. */
const ADOPTED_CHANGE = 'Recovered from a lost log entry';

// ---------------------------------------------------------------------------
// The single-flight lock
// ---------------------------------------------------------------------------

/**
 * One promise chain per table, so a user edit and an agent write cannot
 * interleave their read-modify-write.
 *
 * Every operation that changes a table takes it for the *whole* of its
 * read-modify-write, not just the write half — a read outside the lock is what
 * lets two callers derive their new spec from the same base and one of them
 * lose. Nothing here nests: the `*Locked` functions assume the lock is already
 * held and never take it again.
 *
 * One process, one lock: this is the whole concurrency story. Two Zotero
 * instances pointed at the same data directory are not something the file
 * layout can defend against, and `expectedVersion` on {@link writeTable} is
 * what turns that case into a refused write rather than a lost one.
 *
 * **One bundle, too — and that is load-bearing.** This map is module state, so
 * it is per bundle instance. The lock is genuinely single only because this
 * module imports `checkLibraryExcluded` and through it the React graph, which
 * keeps it out of the esbuild bundle: `src/hooks.ts` reaches
 * `tableItemIdentity.ts`, never this file. If anything ever pulls the store
 * into esbuild there would be two maps, two locks, and no serialisation at all
 * between a user edit and an agent write — the write protocol's whole
 * concurrency story would be void while every test still passed.
 * `eslint.config.mjs` guards the esbuild side of that line, and
 * `npm run check:bundle` fails if the React graph reaches `beaver.js`.
 */
const locks = new Map<string, Promise<unknown>>();

function lockKey(ref: TableRef): string {
    return `${ref.libraryID}/${ref.key}`;
}

function withTableLock<T>(ref: TableRef, run: () => Promise<T>): Promise<T> {
    const key = lockKey(ref);
    const previous = locks.get(key) ?? Promise.resolve();
    // Runs whether the previous holder resolved or rejected: one failed write
    // must not wedge the table for the rest of the session.
    const result = previous.then(run, run);
    // The chain itself must never reject, or the next waiter would inherit an
    // unhandled rejection instead of its turn.
    const settled = result.then(
        () => undefined,
        () => undefined
    );
    locks.set(key, settled);
    void settled.then(() => {
        if (locks.get(key) === settled) locks.delete(key);
    });
    return result;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * One staging path per table, shared by every file this module writes.
 *
 * Dot-named, so a temporary a crash left behind never reaches the server, and
 * *one* path rather than one per target, so the litter a crash can leave is
 * bounded at a single file that the next write reuses. Sharing it is safe
 * because the lock guarantees exactly one writer per table at a time.
 */
function tableTempPath(item: Zotero.Item): string {
    return PathUtils.join(requireSidecar(item), '.write.tmp');
}

/**
 * Writes `text` to the staging path and renames it into place.
 *
 * The rename is what makes a torn write impossible: a reader sees either the
 * previous file or the complete new one, never a half-written one — which is
 * the whole reason a table can be the only copy of its own state.
 */
async function writeAtomic(
    path: string,
    text: string,
    tempPath: string
): Promise<void> {
    await IOUtils.writeUTF8(tempPath, text);
    await IOUtils.move(tempPath, path);
}

/** File contents, or null when it is absent or unreadable. */
async function readText(path: string): Promise<string | null> {
    try {
        if (!(await IOUtils.exists(path))) return null;
        return await IOUtils.readUTF8(path);
    } catch (error) {
        // A sidecar we cannot read is treated as absent rather than fatal: the
        // document is the state, and everything here can be rebuilt from it.
        logger(`tableStore: unreadable sidecar ${path}: ${String(error)}`, 2);
        return null;
    }
}

async function readJson<T>(path: string): Promise<T | null> {
    const text = await readText(path);
    if (text === null) return null;
    try {
        return JSON.parse(text) as T;
    } catch (error) {
        logger(`tableStore: unparseable sidecar ${path}: ${String(error)}`, 2);
        return null;
    }
}

async function removeQuietly(path: string): Promise<void> {
    await IOUtils.remove(path, { ignoreAbsent: true }).catch((error) =>
        logger(`tableStore: could not remove ${path}: ${String(error)}`, 2)
    );
}

function requireSidecar(item: Zotero.Item): string {
    const directory = tableSidecarDirectory(item);
    if (!directory) {
        throw new TableItemError(
            `Table ${item.key} has no storage directory.`,
            'file_missing'
        );
    }
    return directory;
}

/** The sidecar directory, created if it is not there. */
async function ensureSidecarDirectory(item: Zotero.Item): Promise<string> {
    const directory = requireSidecar(item);
    await IOUtils.makeDirectory(directory, {
        createAncestors: true,
        ignoreExisting: true,
    });
    return directory;
}

function historyPathOf(item: Zotero.Item): string {
    requireSidecar(item);
    return tableHistoryPath(item) as string;
}

function versionPathOf(item: Zotero.Item, version: number): string {
    requireSidecar(item);
    return tableVersionPath(item, version) as string;
}

/** The version numbers with a `v<N>.json` file on disk, ascending. */
async function versionFilesOnDisk(item: Zotero.Item): Promise<number[]> {
    const directory = tableSidecarDirectory(item);
    if (!directory) return [];
    let children: string[];
    try {
        children = await IOUtils.getChildren(directory);
    } catch {
        return [];
    }
    const versions: number[] = [];
    for (const child of children) {
        const match = /^v(\d+)\.json$/.exec(PathUtils.filename(child));
        if (match) versions.push(Number(match[1]));
    }
    return versions.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Resolving an item
// ---------------------------------------------------------------------------

/**
 * The exclusion boundary for a table. Every path that changes a table's file or
 * its item goes through here first: a library the user excluded in Beaver
 * preferences is one Beaver does not write to.
 *
 * Called twice on every mutation — once by the entry point and once inside the
 * lock — because the set can change while a caller waits its turn.
 */
function requireWritable(ref: TableRef): void {
    const excluded = checkLibraryExcluded(ref.libraryID);
    if (excluded) throw new TableItemError(excluded.message, 'library_excluded');
}

// ---------------------------------------------------------------------------
// Reading the current state
// ---------------------------------------------------------------------------

interface CurrentState {
    /** The spec embedded in the document, or null when it cannot be read. */
    spec: TableSpec | null;
    /** The version the document claims. 0 when unknown. */
    htmlVersion: number;
    history: TableHistory;
}

/**
 * What the table looks like right now, from both sources of truth, unreconciled
 * — {@link reconcileLog} is what makes them agree.
 */
async function readCurrentState(item: Zotero.Item): Promise<CurrentState> {
    const read = await readTableItemSpec(item);
    // `unsupported_version` is fatal on purpose: writing back today's format
    // over a file a newer build wrote would silently drop whatever that build
    // understood and we do not. A missing file has nothing to reconcile.
    if (
        !read.ok &&
        (read.code === 'unsupported_version' ||
            read.code === 'no_file' ||
            read.code === 'not_a_table')
    ) {
        throw tableReadError(read.code, read.message);
    }

    const spec = read.ok ? read.spec : null;
    if (!read.ok) {
        // A readable file with an unreadable spec is broken, not fatal: a write
        // re-renders the document from the caller's spec and repairs it.
        logger(`tableStore: ${read.code} reading ${item.key}: ${read.message}`, 2);
    }

    const history =
        (await readJson<TableHistory>(historyPathOf(item))) ?? EMPTY_TABLE_HISTORY;

    return {
        spec,
        htmlVersion: typeof spec?.version === 'number' ? spec.version : 0,
        history: normalizeTableHistory(history),
    };
}

// ---------------------------------------------------------------------------
// Log entries
// ---------------------------------------------------------------------------

/**
 * The log entry a version's spec implies.
 *
 * One builder for every entry the store writes — a new version, a seeded
 * version 1, a reconstructed one — so `sha256` always describes the exact bytes
 * beside it and `summary` always comes from the same pass.
 */
async function versionEntry(
    version: number,
    spec: TableSpec,
    serialized: string,
    meta: TableWriteMeta
): Promise<TableVersionEntry> {
    return {
        version,
        actor: meta.actor,
        ...(meta.run_id ? { run_id: meta.run_id } : {}),
        ...(meta.thread_id ? { thread_id: meta.thread_id } : {}),
        ...(meta.change ? { change: meta.change } : {}),
        at: new Date().toISOString(),
        sha256: await sha256Hex(serialized),
        summary: summarize(spec),
    };
}

/**
 * Marks a version as one no later write may overwrite in place.
 *
 * Two kinds of version get this. A version nobody can prove they wrote — one
 * rebuilt from a file after an interrupted write — has no owner, so no run may
 * claim it as its own working version. And the version a table was created in
 * records a state the user has never seen change; letting the creating run's
 * very next write absorb it would destroy the one state most likely to be
 * wanted back, which is the whole reason creation seeds a log at all.
 */
function seal(entry: TableVersionEntry): TableVersionEntry {
    return { ...entry, sealed: true };
}

/**
 * The entry for a version the document committed but the log never recorded,
 * rebuilt from the document — which is the only description of that version
 * that survived.
 *
 * The version file is written unconditionally rather than only when absent: an
 * existing one may hold something else entirely, and an entry whose `sha256`
 * described the document while different bytes sat beside it would bake a
 * mismatch into a log that looks freshly written. The document is authoritative,
 * so the file is made to match it.
 */
async function reconstructEntry(
    item: Zotero.Item,
    spec: TableSpec,
    version: number
): Promise<TableVersionEntry> {
    const serialized = JSON.stringify(spec);
    await ensureSidecarDirectory(item);
    await writeAtomic(versionPathOf(item, version), serialized, tableTempPath(item));
    return seal(
        await versionEntry(version, spec, serialized, {
            actor: 'system',
            change: RECOVERED_CHANGE,
        })
    );
}

/**
 * The entry a version file implies, for a file at or below the commit point the
 * log has lost track of. Null when the file is not a readable spec.
 *
 * Nothing is written: the file is already a complete spec and knows its own
 * version, so the entry is built to describe the bytes that are there.
 */
async function adoptEntry(
    item: Zotero.Item,
    version: number
): Promise<TableVersionEntry | null> {
    const serialized = await readText(versionPathOf(item, version));
    if (serialized === null) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(serialized);
    } catch {
        return null;
    }
    const read = readSpec(raw);
    if (!read.ok) return null;
    return seal(
        await versionEntry(version, read.spec, serialized, {
            actor: 'system',
            change: ADOPTED_CHANGE,
        })
    );
}

/** `entries` with `entry` in place of any entry for the same version. */
function mergeEntry(
    entries: TableVersionEntry[],
    entry: TableVersionEntry
): TableVersionEntry[] {
    return [...entries.filter((e) => e.version !== entry.version), entry];
}

/**
 * Replaces `history.json` with `entries`, applies the retention cap, and
 * deletes the version files the cap drops. Returns the dropped versions.
 */
async function commitHistory(
    item: Zotero.Item,
    entries: TableVersionEntry[]
): Promise<number[]> {
    const sorted = [...entries].sort((a, b) => a.version - b.version);
    const dropped = sorted.slice(
        0,
        Math.max(0, sorted.length - TABLE_VERSION_RETENTION)
    );
    const versions = sorted.slice(-TABLE_VERSION_RETENTION);
    const tip = versions.length ? versions[versions.length - 1].version : 0;

    await writeAtomic(
        historyPathOf(item),
        JSON.stringify({ tip, versions } satisfies TableHistory),
        tableTempPath(item)
    );

    // After the log, never before: a version file deleted first would be
    // unrecoverable if the log write then failed. Deleting them here rather
    // than leaving them is what keeps them from looking like stray files to a
    // later open — retention is a deliberate drop, not damage.
    for (const stale of dropped) {
        await removeQuietly(versionPathOf(item, stale.version));
    }
    return dropped.map((e) => e.version);
}

// ---------------------------------------------------------------------------
// Reconciling the log with the document
// ---------------------------------------------------------------------------

interface Reconciled {
    versions: TableVersionEntry[];
    repairs: TableRecovery[];
}

/**
 * Makes the log agree with the document about *which version the table is at*.
 *
 * Cheap enough to run on every write, and it must: a write that skipped it
 * would either lose the version the user is looking at (log behind) or write
 * back versions this device never held (log ahead) as revert targets. Sharing
 * one implementation with {@link openTable} is what stops the write path and
 * the open path from disagreeing about the same file.
 *
 * Nothing is decided against a document we cannot read, or one that carries no
 * version stamp: there is nothing to reconcile against, and truncating a good
 * log on the strength of an unreadable file would be the worst possible trade.
 */
async function reconcileLog(
    item: Zotero.Item,
    current: CurrentState
): Promise<Reconciled> {
    const repairs: TableRecovery[] = [];
    let versions = current.history.versions;
    if (!current.spec || current.htmlVersion <= 0) return { versions, repairs };

    const { htmlVersion } = current;

    // The log claims commits the document never took. Their version files are
    // above the commit point, so the audit below deletes them.
    const abandoned = versions.filter((e) => e.version > htmlVersion);
    if (abandoned.length) {
        versions = versions.filter((e) => e.version <= htmlVersion);
        repairs.push({
            kind: 'history_truncated',
            versions: abandoned.map((e) => e.version),
        });
    }

    // The document is ahead of the log: the commit landed and the log rewrite
    // did not.
    if (!versions.some((e) => e.version === htmlVersion)) {
        versions = [
            ...versions,
            await reconstructEntry(item, current.spec, htmlVersion),
        ];
        repairs.push({ kind: 'history_appended', version: htmlVersion });
    }

    return { versions, repairs };
}

/**
 * Checks the version files against the log and repairs what disagrees.
 *
 * Run on open rather than on every write, because it reads and hashes files a
 * write does not otherwise need. Three rules, and the distinction between them
 * is the point:
 *
 * - **The tip's file must match its entry.** It is the only file a collapsing
 *   write rewrites in place, so it is the only one whose bytes can drift from
 *   what the log says they are. On a mismatch the document wins: the file is
 *   rewritten from it and the entry's digest and summary are refreshed.
 * - **A file at or below the commit point is adopted, not deleted.** It is a
 *   complete spec that knows its own version — a state the user may well want
 *   back, and the log having lost track of it is a reason to rebuild the entry,
 *   not to destroy the evidence.
 * - **Only a file above the commit point is garbage.** It can only have come
 *   from a write that stopped before the commit, so nothing ever referred to
 *   it and nothing ever will.
 *
 * A file at or below the commit point that is not a readable spec is garbage
 * too: it cannot be restored and cannot be described.
 */
async function auditSidecar(
    item: Zotero.Item,
    spec: TableSpec,
    htmlVersion: number,
    entries: TableVersionEntry[]
): Promise<Reconciled> {
    const repairs: TableRecovery[] = [];
    let versions = entries;
    const tip = versions.length ? versions[versions.length - 1].version : 0;
    if (tip <= 0) return { versions, repairs };

    // --- the tip's file against its entry
    //
    // Only when the tip is the version the document carries, since the document
    // is the spec the repair would write. After {@link reconcileLog} that is the
    // normal case; it is not one on a document whose version stamp was lost, and
    // writing this spec under someone else's number would be worse than the
    // mismatch it was meant to fix.
    const tipEntry = versions[versions.length - 1];
    const tipPath = versionPathOf(item, tip);
    const stored = htmlVersion === tip ? await readText(tipPath) : undefined;
    if (stored !== undefined && (stored === null || (await sha256Hex(stored)) !== tipEntry.sha256)) {
        const serialized = JSON.stringify(spec);
        await ensureSidecarDirectory(item);
        await writeAtomic(tipPath, serialized, tableTempPath(item));
        versions = [
            ...versions.slice(0, -1),
            {
                ...tipEntry,
                sha256: await sha256Hex(serialized),
                summary: summarize(spec),
            },
        ];
        repairs.push({ kind: 'version_file_repaired', version: tip });
    }

    // --- files the log has lost track of, and files nothing can refer to
    const onDisk = await versionFilesOnDisk(item);
    const known = new Set(versions.map((e) => e.version));
    const adopted: number[] = [];
    const garbage: number[] = [];
    for (const version of onDisk) {
        if (version > tip) {
            garbage.push(version);
            continue;
        }
        if (known.has(version)) continue;
        const entry = await adoptEntry(item, version);
        if (entry) {
            versions = [...versions, entry];
            adopted.push(version);
        } else {
            garbage.push(version);
        }
    }

    if (adopted.length) {
        versions = [...versions].sort((a, b) => a.version - b.version);
        repairs.push({ kind: 'history_adopted', versions: adopted });
    }
    if (garbage.length) {
        for (const version of garbage) {
            await removeQuietly(versionPathOf(item, version));
        }
        repairs.push({ kind: 'orphan_removed', versions: garbage.sort((a, b) => a - b) });
    }

    return { versions, repairs };
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/**
 * Creates a table and starts its version log — **the** way a table comes into
 * existence.
 *
 * {@link createTableItem} is the item-layer primitive: it imports the snapshot
 * attachment and writes the document, but it knows nothing about versions, so a
 * table created through it directly has a version 1 that is neither logged nor
 * revertable. Since the state a table was created in is the one a user is most
 * likely to want back after an agent has filled it, that is the worst version
 * to be missing — so creation seeds `beaver/v1.json` and a `history.json`
 * holding one entry, through the same helpers every later write uses. The
 * seeded entry therefore has the same shape as any other: `actor`, `at`,
 * `sha256` over the exact bytes beside it, and `summary`.
 *
 * The entry keeps the creating run's `run_id` — that is real provenance — and
 * is {@link seal}ed, which is what stops that run's next write from collapsing
 * onto it and overwriting the state the seed exists to preserve.
 *
 * **The seed is a copy, not a re-derivation.** `v1.json` holds the spec
 * `createTableItem` stamped and rendered, serialised here. The two agree today
 * because both serialise the same object; if that two-phase stamp ever came to
 * differ from what the store would have written, this file — not the store's
 * idea of it — is what a revert to version 1 restores.
 */
export async function createTable(
    options: CreateTableOptions
): Promise<CreatedTable> {
    const { actor = 'agent', run_id, thread_id, change, ...itemOptions } = options;

    // Library exclusion is enforced inside `createTableItem`, which resolves
    // the target library and re-checks it immediately before the import.
    const created = await createTableItem(itemOptions);
    const ref: TableRef = { libraryID: created.libraryID, key: created.key };
    const meta: TableWriteMeta = {
        actor,
        run_id,
        thread_id,
        change: change ?? CREATED_CHANGE,
    };

    let entry: TableVersionEntry;
    try {
        entry = await withTableLock(ref, async () => {
            const version = created.spec.version ?? 1;
            const serialized = JSON.stringify(created.spec);
            const seeded = seal(
                await versionEntry(version, created.spec, serialized, meta)
            );

            await ensureSidecarDirectory(created.item);
            await writeAtomic(
                versionPathOf(created.item, version),
                serialized,
                tableTempPath(created.item)
            );
            await commitHistory(created.item, [seeded]);
            return seeded;
        });
    } catch (error) {
        // The item is already in the library and already saved, so a failure
        // here would otherwise leave a table nothing tracks — and a caller that
        // retries would make a second one. Trashing is reversible, so this is
        // safe even when the seed failed for a reason that left the file fine:
        // the user can restore it from the trash.
        await trashTableItem(created.item).catch((cleanupError) =>
            logger(
                `tableStore: could not trash ${created.key} after a failed seed: ${String(cleanupError)}`,
                1
            )
        );
        throw error;
    }

    emitTableUpdated(ref, entry.version, meta);
    return { ...created, version: entry.version, entry };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Stores `spec` as the next version of a table.
 *
 * The sequence is fixed, and the order is the crash-safety argument:
 *
 * 1. Take the table's single-flight lock, and hold it for the read *and* the
 *    write, so no other caller can derive a new state from the same base.
 * 2. Read the document and the log, and reconcile them
 *    ({@link reconcileLog}) so the tip is the version the document actually
 *    committed.
 * 3. Refuse with a conflict when the tip is not `expectedVersion`, handing back
 *    the current spec so the caller can rebase. `expectedVersion` undefined
 *    means "no guard".
 * 4. Write `beaver/v<N>.json`, temp file + rename — but only *before* the
 *    document when this write is taking a new number. See below.
 * 5. Render and write the document, temp file + rename. **This is the commit
 *    point** — the document carries the spec, so the moment it lands the table
 *    is the new one whatever happens next.
 * 6. Rewrite `beaver/history.json`, applying the retention cap and deleting the
 *    version files that fall out of it. A crash before this leaves the log
 *    behind the document, which the next reconciliation repairs.
 * 7. Queue full-text indexing, mark the attachment for upload and save the
 *    item. Zotero schedules auto-sync off data-object notifications, not off
 *    file writes, so without this the change sits unsynced until something
 *    unrelated triggers a sync — see {@link markForUpload}. It is bookkeeping
 *    *after* the state has changed, so a failure here is reported as
 *    `saved: false` rather than as a failed write: a caller that retried would
 *    apply its mutations twice.
 * 8. Release the lock and announce the change.
 *
 * ## What `expectedVersion` does and does not guard
 *
 * It compares the tip against what the caller last saw, so it catches a *third
 * party* moving the table: another device through sync, or a hand-edited file.
 * It is **not** a general lost-update guard, because a collapsing write leaves
 * the tip where it was — two writes from the same run both see the version they
 * expect. What protects that case is the lock: read and write happen in one
 * acquisition, so a same-run pair is serialised and the second one builds on
 * the first.
 *
 * ## A run's writes collapse
 *
 * When the tip is already owned by this run — `meta.run_id` matches the tip
 * entry's and that entry is not sealed — the version file and the log entry are
 * overwritten in place and the number does not advance. A run that fills a
 * column cell by cell would otherwise issue a hundred versions nobody wants to
 * revert to individually.
 *
 * The rule that makes it safe is that the number is only ever reused while it
 * is still the run's own: once anyone else has written above it the next write
 * appends. **A version number, once issued, must never move off a state the
 * user could still be looking at or reverting to** — which is why every user
 * edit is its own version even inside a run, and why the created and
 * reconstructed versions are sealed against reuse entirely.
 *
 * A collapsing write also inverts steps 4 and 5. Its version file is one the
 * log already points at, so overwriting it before the commit lands would leave
 * a file describing neither the old state nor the new one; writing it after
 * means the worst a crash can leave is a file holding an earlier moment of the
 * same run's working version. (That residual case — file and entry consistent
 * with each other but behind the document — is the one thing
 * {@link auditSidecar} cannot see, since detecting it would mean re-serialising
 * the document's spec and comparing bytes, which is not stable enough to be a
 * signal.)
 */
export async function writeTable(
    ref: TableRef,
    spec: TableSpec,
    meta: TableWriteMeta,
    expectedVersion?: number
): Promise<TableWriteResult> {
    requireWritable(ref);
    const result = await withTableLock(ref, async () => {
        const { item, current } = await prepareWrite(ref);
        return commitWrite(ref, item, current, spec, meta, expectedVersion);
    });
    if (result.ok) emitTableUpdated(ref, result.version, meta);
    return result;
}

interface PreparedWrite {
    item: Zotero.Item;
    current: CurrentState;
}

/** Resolves the item and reads its state. Call only with the lock held. */
async function prepareWrite(ref: TableRef): Promise<PreparedWrite> {
    const item = await resolveTableItem(ref);
    // Re-checked under the lock: exclusion may have changed while the caller
    // was preparing the write, or while it waited its turn.
    requireWritable(ref);
    return { item, current: await readCurrentState(item) };
}

/** The write itself. Call only with the lock held. */
async function commitWrite(
    ref: TableRef,
    item: Zotero.Item,
    current: CurrentState,
    spec: TableSpec,
    meta: TableWriteMeta,
    expectedVersion: number | undefined
): Promise<TableWriteResult> {
    const reconciled = await reconcileLog(item, current);
    if (reconciled.repairs.length) {
        logger(
            `tableStore: reconciled ${item.key} before writing: ${reconciled.repairs
                .map((r) => r.kind)
                .join(', ')}`,
            2
        );
    }
    const versions = reconciled.versions;

    // After reconciliation the log's last entry is the committed version. With
    // an unreadable or unstamped document there is nothing to reconcile
    // against, so the log stands on its own.
    const tip = versions.length
        ? versions[versions.length - 1].version
        : current.htmlVersion;

    if (expectedVersion !== undefined && expectedVersion !== tip) {
        return { ok: false, conflict: true, version: tip, spec: current.spec };
    }

    const tipEntry = versions.find((e) => e.version === tip);
    const collapse =
        meta.actor !== 'user' &&
        !!meta.run_id &&
        !!tipEntry &&
        !tipEntry.sealed &&
        tipEntry.run_id === meta.run_id;
    const version = collapse ? tip : tip + 1;

    // Never the caller's word for either: the file says which table it is and
    // which revision of it, and only the store gets to decide that.
    const stored: TableSpec = {
        ...spec,
        spec_version: spec.spec_version ?? TABLE_SPEC_VERSION,
        key: item.key,
        version,
    };

    const serialized = JSON.stringify(stored);
    const entry = await versionEntry(version, stored, serialized, meta);

    await ensureSidecarDirectory(item);
    const temp = tableTempPath(item);
    const versionPath = versionPathOf(item, version);
    const document = buildTableDocument(stored, { linksFor: zoteroLinksFor });
    const htmlPath = await item.getFilePathAsync();
    if (!htmlPath) {
        throw new TableItemError(
            `Table ${item.key} has no file on disk.`,
            'file_missing'
        );
    }

    if (collapse) {
        // The version file is already referenced by the log, so it goes last.
        await writeAtomic(htmlPath, document.html, temp);
        await writeAtomic(versionPath, serialized, temp);
    } else {
        // Nothing points at this number yet, so a crash between the two leaves
        // a file the next open deletes as garbage and a table nobody touched.
        await writeAtomic(versionPath, serialized, temp);
        await writeAtomic(htmlPath, document.html, temp);
    }

    const pruned = await commitHistory(item, mergeEntry(versions, entry));

    let saved = true;
    try {
        await queueTableFullText(item);
        markForUpload(item);
        await item.saveTx();
    } catch (error) {
        // Past the commit point: the table on disk is already the new one, so
        // failing the call would make a caller retry mutations that landed.
        saved = false;
        logger(
            `tableStore: ${ref.key} was written but its item save failed: ${String(error)}`,
            1
        );
    }

    return {
        ok: true,
        version,
        collapsed: collapse,
        saved,
        spec: stored,
        entry,
        pruned,
    };
}

/**
 * Marks the attachment's file as needing upload.
 *
 * Zotero decides what to send from the item's sync state, so a table that has
 * already synced once would otherwise keep its `in_sync` state and the new
 * bytes would wait for the next file-modification scan.
 *
 * It is also what makes the following `saveTx` a real save: Zotero skips a save
 * on an unchanged object, and an unchanged object emits no notification for the
 * auto-sync timer to hear. A table that is *already* marked for upload needs
 * neither — its upload is pending regardless.
 */
function markForUpload(item: Zotero.Item): void {
    item.attachmentSyncState = Zotero.Sync.Storage.Local.SYNC_STATE_TO_UPLOAD;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * The ergonomic write: read the table, apply `mutations`, store the result.
 *
 * This is what "edit a table" means in practice — the document is never
 * patched, it is re-rendered from the new spec, so it can never describe a
 * table the spec does not.
 *
 * Read, apply and write happen in **one** lock acquisition, because they are
 * one operation. Splitting them is what would let two same-run edits both start
 * from the same spec and both collapse onto the same version, with the first
 * one's mutations gone from the file and from the log while both callers were
 * told they succeeded.
 *
 * There is consequently no `expectedVersion` here and no conflict-and-rebase
 * loop: nothing else in this process can move the table between the read and
 * the write, so the guard would be comparing the read against itself. It is not
 * a guard against another process either — there is no cross-process lock, and
 * a check would leave exactly the same window open between itself and the
 * rename. A caller that held a spec across an await boundary of its own — a UI
 * writing back what a user edited — wants {@link writeTable} with the version
 * it was shown.
 *
 * A mutation the table cannot accept comes back unchanged: the caller wrote
 * something wrong, and retrying would not fix it.
 */
export async function editTable(
    ref: TableRef,
    mutations: TableMutation[],
    meta: TableWriteMeta
): Promise<TableEditResult> {
    requireWritable(ref);
    const result = await withTableLock(ref, async () => {
        const { item, current } = await prepareWrite(ref);
        if (!current.spec) {
            throw new TableItemError(
                `Table ${ref.key} carries no readable spec to edit.`,
                'no_spec'
            );
        }

        const applied = applyMutations(current.spec, mutations);
        if (!applied.ok) return { ok: false, error: applied.error } as const;

        return commitWrite(ref, item, current, applied.spec, meta, undefined);
    });
    if (result.ok) emitTableUpdated(ref, result.version, meta);
    return result;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The version log, oldest first. */
export async function listVersions(ref: TableRef): Promise<TableVersionEntry[]> {
    const item = await resolveTableItem(ref);
    const history = await readJson<TableHistory>(historyPathOf(item));
    return normalizeTableHistory(history).versions;
}

/**
 * Opens a table, repairing anything an interrupted write or a partial sync left
 * behind.
 *
 * Two passes: {@link reconcileLog} settles which version the table is at, and
 * {@link auditSidecar} settles whether the files match what the log says about
 * them. Both resolve every disagreement in the document's favour, and neither
 * deletes a version file that could still be restored — the rules are on those
 * two functions.
 *
 * Recovery writes, so it is done under the lock and skipped entirely in an
 * excluded library, where Beaver does not write at all.
 */
export async function openTable(ref: TableRef): Promise<OpenTableResult> {
    return withTableLock(ref, async () => {
        const item = await resolveTableItem(ref);
        const current = await readCurrentState(item);
        if (!current.spec) {
            throw new TableItemError(
                `Table ${ref.key} carries no readable spec.`,
                'no_spec'
            );
        }

        const recovered: TableRecovery[] = [];
        if (!checkLibraryExcluded(ref.libraryID)) {
            const reconciled = await reconcileLog(item, current);
            const audited = await auditSidecar(
                item,
                current.spec,
                current.htmlVersion,
                reconciled.versions
            );
            recovered.push(...reconciled.repairs, ...audited.repairs);
            if (recovered.length) {
                const pruned = await commitHistory(item, audited.versions);
                if (pruned.length) recovered.push({ kind: 'pruned', versions: pruned });
            }
        }

        const history = normalizeTableHistory(
            await readJson<TableHistory>(historyPathOf(item))
        );
        return {
            ref,
            spec: current.spec,
            version: Math.max(current.htmlVersion, history.tip),
            history: history.versions,
            recovered,
        };
    });
}

// ---------------------------------------------------------------------------
// Reverting
// ---------------------------------------------------------------------------

/**
 * Stores an earlier version again, as a **new** version.
 *
 * The number never rewinds: a revert is an edit like any other, and a history
 * whose numbers go backwards cannot be reasoned about — the version a user was
 * shown must keep meaning the same table.
 *
 * The stored file is checked against the digest its log entry recorded before
 * anything is restored. A version file that has drifted is refused rather than
 * restored: putting bytes the log cannot vouch for back into the document would
 * make a state the user never saw the current one, under a version number that
 * says otherwise.
 */
export async function revertTable(
    ref: TableRef,
    toVersion: number,
    meta: TableWriteMeta
): Promise<TableWriteResult> {
    requireWritable(ref);
    // A revert is a deliberate step back, so it is never folded into the
    // version a run is currently building.
    const revertMeta: TableWriteMeta = {
        ...meta,
        change: meta.change ?? `Reverted to version ${toVersion}`,
        run_id: undefined,
    };

    const result = await withTableLock(ref, async () => {
        const { item, current } = await prepareWrite(ref);
        const spec = await readStoredVersion(ref, item, current, toVersion);
        return commitWrite(ref, item, current, spec, revertMeta, undefined);
    });
    if (result.ok) emitTableUpdated(ref, result.version, revertMeta);
    return result;
}

/** The spec of a stored version, verified against its log entry. */
async function readStoredVersion(
    ref: TableRef,
    item: Zotero.Item,
    current: CurrentState,
    version: number
): Promise<TableSpec> {
    const serialized = await readText(versionPathOf(item, version));
    if (serialized === null) {
        throw new TableItemError(
            `Table ${ref.key} has no stored version ${version}.`,
            'not_found'
        );
    }

    const entry = current.history.versions.find((e) => e.version === version);
    if (entry && (await sha256Hex(serialized)) !== entry.sha256) {
        throw new TableItemError(
            `Version ${version} of table ${ref.key} no longer matches what the log recorded for it, so it cannot be trusted as a state to restore.`,
            'version_corrupt'
        );
    }

    let raw: unknown;
    try {
        raw = JSON.parse(serialized);
    } catch (error) {
        throw new TableItemError(
            `Version ${version} of table ${ref.key} is not readable JSON: ${String(error)}`,
            'version_corrupt'
        );
    }
    const read = readSpec(raw);
    if (read.ok) return read.spec;
    if (read.reason === 'unsupported_version') {
        throw new TableItemError(
            `Version ${version} of table ${ref.key} was written by a newer format (spec_version ${read.specVersion}).`,
            'unsupported_version'
        );
    }
    throw new TableItemError(
        `Version ${version} of table ${ref.key} is not a readable table: ${read.detail}`,
        'version_corrupt'
    );
}

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

/**
 * Moves a table to the trash. Deleting outright is not offered: the file is the
 * only copy of the table's state, so the recoverable step is the only safe one.
 */
export async function deleteTable(ref: TableRef): Promise<void> {
    requireWritable(ref);
    await withTableLock(ref, async () => {
        const item = await resolveTableItem(ref);
        requireWritable(ref);
        await trashTableItem(item);
    });
    emitTableUpdated(ref, null, { actor: 'user', change: 'Moved to trash' });
}

/** Takes a trashed table back out of the trash. */
export async function restoreTable(ref: TableRef): Promise<void> {
    requireWritable(ref);
    await withTableLock(ref, async () => {
        const item = Zotero.Items.getByLibraryAndKey(ref.libraryID, ref.key) as
            | Zotero.Item
            | false;
        if (!item) {
            throw new TableItemError(
                `No item ${ref.key} in library ${ref.libraryID}.`,
                'not_found'
            );
        }
        requireWritable(ref);
        await restoreTableItem(item);
    });
    emitTableUpdated(ref, null, { actor: 'user', change: 'Restored from trash' });
}

// ---------------------------------------------------------------------------
// Announcing a change
// ---------------------------------------------------------------------------

/** Event name a table tab, the window and any card listen for. */
export const TABLE_UPDATED_EVENT = 'beaverTableUpdated';

export interface TableUpdatedDetail {
    libraryID: number;
    key: string;
    /** The new tip, or null when the change was not a write. */
    version: number | null;
    actor: TableActor;
    run_id?: string;
}

/**
 * Tells the rest of the plugin the table moved, so anything showing it re-reads
 * from the file rather than from a copy it kept.
 *
 * Best-effort by design: a window that has gone away, or a startup path with no
 * bus yet, must not fail a write that has already landed on disk.
 */
function emitTableUpdated(
    ref: TableRef,
    version: number | null,
    meta: TableWriteMeta
): void {
    try {
        const win = Zotero.getMainWindow?.();
        const bus = win?.__beaverEventBus;
        if (!win || !bus) return;
        const detail: TableUpdatedDetail = {
            libraryID: ref.libraryID,
            key: ref.key,
            version,
            actor: meta.actor,
            ...(meta.run_id ? { run_id: meta.run_id } : {}),
        };
        const Ctor = (win as any).CustomEvent ?? CustomEvent;
        bus.dispatchEvent(new Ctor(TABLE_UPDATED_EVENT, { detail }));
    } catch (error) {
        logger(`tableStore: table-updated dispatch failed: ${String(error)}`, 2);
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Maps a spec-read failure onto the shared table error vocabulary. */
