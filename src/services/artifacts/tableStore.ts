/**
 * The versioned store for stored tables — every write to a table file goes
 * through here, and nothing else may write one.
 *
 * A table is a Zotero snapshot attachment whose `table.json` is the only copy
 * of its state ({@link createTableItem}). There is no database row to rebuild
 * it from, so that file *is* the commit: the whole point of this module is that
 * a write either leaves the previous table intact or leaves the new one intact,
 * never something in between, and that the numbers it hands out for the states
 * it has produced never move.
 *
 * ## Storage layout, inside the attachment's storage directory
 *
 * ```
 * table.json             { spec, creation } — the table
 * <slug>.html            the snapshot rendered from it (`tableRenderer.ts`)
 * beaver/history.json    { tip, versions: [ … ] }
 * beaver/v<N>.json       the full spec of version N
 * beaver/bookkeeping.json  the spec and table.json digests the last completed render covered
 * ```
 *
 * A write commits in a fixed order: the version file (for a new number),
 * `table.json` — the commit point, after which nothing rejects — then the
 * history and the recovery shadow. The snapshot follows through the renderer,
 * which every write schedules and which never takes this module's lock.
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
 * `table.json` is the state; the sidecar is bookkeeping about it. Everything
 * here follows from that: `table.json` is written at the commit point and every
 * disagreement is resolved in its favour, by rebuilding the sidecar rather than
 * by rolling the table back. {@link openTable} is where that repair happens.
 * A `table.json` missing beside a retained history is not repaired: the table
 * reads as `corrupt`, and restoring a retained version ({@link revertTable},
 * {@link restoreShadowVersion}) writes a new one.
 *
 * ## The one thing the file layout cannot answer
 *
 * That argument holds only while the storage directory is this device's. It is
 * also what syncs, and Zotero resolves a file conflict by keeping one whole
 * copy — so a table can arrive complete, internally consistent, and older than
 * what this device wrote. Nothing inside the directory survives to say so, so
 * the store records each write to a shadow outside it (`recoveryShadow.ts`) and
 * {@link openTable} reports the disagreement as a `conflict` rather than a
 * repair. {@link restoreShadowVersion} is the way back, and it is an ordinary
 * write.
 *
 * ## Addressing
 *
 * A table is addressed by {@link TableRef} — a library id and a Zotero item
 * key. The item key *is* the table's identity; there is no separate artifact
 * id, which is why the spec written to disk is always stamped with the key of
 * the item it lives in rather than with whatever the caller passed.
 *
 * Public operations dispatch to the plugin-owned library operation service.
 * Internal implementations and lock lifetimes belong to that plugin realm.
 */

import {
    readSpec,
    TABLE_SPEC_VERSION,
    type TableSpec,
} from '@beaver/agent-core/layouts/table';
import {
    applyMutations,
    carryColumnRevisions,
    checkTableLimits,
    summarize,
    type ApplyError,
    type SkippedCell,
    type TableMutation,
} from '@beaver/agent-core/layouts/tableMutations';
import { logger } from '@beaver/agent-core/platform/logger';
import { sha256Hex } from '../../utils/hash';
import { checkLibraryExcluded } from '../agentDataProvider/utils';
import {
    detectTableSyncConflict,
    lastTableShadow,
    pruneTableShadow,
    readTableShadowSpec,
    recordTableShadow,
    tableSpecHash,
    type TableShadowEntry,
    type TableSyncConflict,
} from './recoveryShadow';
import { readTable, tableFilesEditable } from './tableItemIdentity';
import {
    renderIsCurrent,
    renderTable,
    markTablePending,
} from './tableRenderer';
import {
    isTableAttachment,
    buildTableUrl,
    createTableItem,
    describeTableItem,
    EMPTY_TABLE_HISTORY,
    loadTableItemFields,
    normalizeTableHistory,
    readTableHistory,
    readTableFileCreation,
    readTableItemSpec,
    resolveTableItem,
    resolveTableLibrary,
    restoreTableItem,
    storedSpecVersion,
    TABLE_EMOJI_TAG,
    TABLE_TAG,
    TABLE_URL_PREFIX,
    tableFilePath,
    tableHistoryPath,
    TableItemError,
    tableReadError,
    tableSidecarDirectory,
    tableVersionPath,
    trashTableItem,
    type CreatedTableItem,
    type CreateTableItemOptions,
    type TableActor,
    type TableCreationState,
    type TableFile,
    type TableHistory,
    type TableRef,
    type TableVersionEntry,
} from './tableItem';
import { getTablesApi, setTableShadowRestore, tableWriteLocks, tableLocalCommands, type TableLocalCommands } from './tablesApi';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

// Addressing, reading and the shape of the version log live next door, so
// read-only callers need not load the write implementation.
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
    resolveTableItem
} from './tableItemIdentity';
export type {
    TableActor,
    TableHistory,
    TableRef,
    TableVersionEntry
} from './tableItemIdentity';
// The sync conflict is part of what opening a table tells you, so its shape is
// re-exported here for the same reason the log's is: one import for callers of
// the store. Detection and retention live next door, esbuild-side, because the
// item-pane section has to reach them without reaching this module.
export type {
    TableShadowEntry,
    TableSyncConflict,
    TableSyncConflictReason
} from './recoveryShadow';

export interface TableWriteMeta {
    actor: TableActor;
    /** The agent run this write belongs to, if any. */
    run_id?: string;
    thread_id?: string;
    /**
     * Writes with the same key collapse into one version while nobody else
     * writes in between: a fill's job id, a tab's editing session. Without
     * one, an agent write's run and thread are its key. See {@link commitWrite}.
     */
    collapse_key?: string;
    /**
     * Commit a version nothing collapses onto, and never collapse this write
     * onto the tip: a model edit, a destructive edit, a restore.
     */
    seal?: boolean;
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
    | { kind: 'pruned'; versions: number[] }
    /** The snapshot was missing or a render behind, and a render was scheduled. */
    | { kind: 'rerendered' }
    | { kind: 'bookkeeping_pending' };

export type TableAccessGuard = (spec: TableSpec) => void;

export interface TableWriteOk {
    sha256: string;
    ok: true;
    version: number;
    /** True when this write replaced the version it found instead of adding one. */
    collapsed: boolean;
    /**
     * False when a step *after* the commit point did not land: the version
     * file a collapsing write rewrites, the version log, or the item save.
     *
     * The table on disk is the new one either way — that is what makes this a
     * flag rather than a rejection — and what is behind is bookkeeping the next
     * {@link openTable} reconciles using the current committed document.
     */
    saved: boolean;
    /** The spec as stored: `key`, `version` and `spec_version` stamped in. */
    spec: TableSpec;
    entry: TableVersionEntry;
    /** Versions the retention cap dropped, if any. */
    pruned: number[];
    /** `set_cells` writes the engine declined, for an {@link editTable}. */
    skipped?: SkippedCell[];
}

/**
 * The write was refused because the table moved under the caller. `spec` is the
 * table as it stands, so the caller can rebase on it; it is null only when the
 * stored file itself is unreadable.
 */
export interface TableWriteConflict {
    sha256: string | null;
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
    accessGuard?: TableAccessGuard;
    operation_id?: string;
    /**
     * The collection to file into, by key in the create library. Resolved only
     * when the table is actually created, so a retry of a creation that already
     * committed replays even if the collection has since gone.
     */
    collectionKey?: string;
    /** Who is creating it. Defaults to `agent`. */
    actor?: TableActor;
    run_id?: string;
    thread_id?: string;
    /** The line the version log shows for version 1. */
    change?: string;
}

export interface CreatedTable extends CreatedTableItem {
    /** A retry of a committed creation, answered from the item it made. */
    replayed?: boolean;
    sha256?: string;
    /** Starts at 1; a replay reports the current version of the original item. */
    version: number;
    entry: TableVersionEntry;
}

export interface OpenTableResult {
    sha256: string;
    ref: TableRef;
    spec: TableSpec;
    version: number;
    history: TableVersionEntry[];
    /** Empty on a table whose sidecar already agreed with its document. */
    recovered: TableRecovery[];
    /**
     * Set when the table went backwards under this device — a Zotero file
     * conflict resolved toward another device's copy.
     *
     * Deliberately not a {@link TableRecovery}: those are damage the store
     * repairs and moves on from, and folding this in with them would say the
     * same thing about a case where nothing has been repaired and nothing will
     * be. Which state the user wants is theirs to choose; the store only offers
     * {@link restoreShadowVersion}.
     */
    conflict: TableSyncConflict | null;
}

/** What {@link checkShadowRestore} found. */
export type TableShadowRestoreCheck = 'ok' | 'no_shadow' | 'no_payload' | 'not_writable' | 'unavailable';

/** The outcome of {@link restoreShadowVersion}. */
export type TableShadowRestoreResult =
    | {
          ok: true;
          /** The new version the retained spec was written as. */
          version: number;
          /** The version it was retained under. */
          restoredFrom: number;
          entry: TableVersionEntry;
      }
    | {
          ok: false;
          code:
              /** This device never wrote to this table (or the shadow was pruned). */
              | 'no_shadow'
              /** The version is known but its spec was not retained, or no longer verifies. */
              | 'no_payload'
              /** The write itself was refused. */
              | 'write_refused';
          error: string;
          /** The version that would have been restored, when one is known. */
          version?: number;
      };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How many version files a table keeps. Older entries fall out of the log and
 * their files are deleted, so a long-lived table's storage directory — which is
 * uploaded whole on every sync — stays bounded.
 */
export const TABLE_VERSION_RETENTION = 20;

/**
 * The bytes of version files a table keeps beyond {@link TABLE_VERSION_RETENTION_FLOOR}.
 * A large table keeps fewer versions, so twenty copies of it never become a
 * multi-megabyte upload.
 */
export const TABLE_VERSION_RETENTION_BYTES = 16 * 1024 * 1024;

/**
 * The newest versions a table always keeps, whatever their size, so even a
 * table near the spec cap can be reverted.
 */
export const TABLE_VERSION_RETENTION_FLOOR = 3;

/** The line version 1 carries when the caller does not supply one. */
const CREATED_CHANGE = 'Created the table';

/** What an entry rebuilt from the document says it is. */
const RECOVERED_CHANGE = 'Recovered from an interrupted write';

/** What an entry rebuilt from a version file the log had lost says it is. */
const ADOPTED_CHANGE = 'Recovered from a lost log entry';

// ---------------------------------------------------------------------------
// The single-flight lock
// ---------------------------------------------------------------------------

function lockKey(ref: TableRef): string {
    return `${ref.libraryID}/${ref.key}`;
}

/**
 * One promise chain per table, so a user edit and an agent write cannot
 * interleave their read-modify-write.
 *
 * Every operation that changes a table takes it for the *whole* of its
 * read-modify-write, not just the write half — a read outside the lock is what
 * lets two callers derive their new spec from the same base and one of them
 * lose. Creation takes its operation lock before the newly assigned item lock;
 * no path takes them in the reverse order or acquires an item lock twice.
 *
 * One process, one lock: this is the whole concurrency story. Two Zotero
 * instances pointed at the same data directory are not something the file
 * layout can defend against, and `expectedVersion` on {@link writeTable} is
 * what turns that case into a refused write rather than a lost one.
 *
 * The chains themselves live on the shared global ({@link tableWriteLocks}),
 * not as module state. Module state is per bundle; the lock has to be per
 * process. See {@link tableWriteLocks} for why, and for the window-realm
 * caveat on the entries.
 */
function withTableLock<T>(ref: TableRef, run: () => Promise<T>): Promise<T> {
    const locks = tableWriteLocks();
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
/** Why Beaver may not write this table now, or null when it may. */
function writeRefusal(ref: TableRef): TableItemError | null {
    const excluded = checkLibraryExcluded(ref.libraryID);
    if (excluded) return new TableItemError(excluded.message, 'library_excluded');
    const library = Zotero.Libraries.get(ref.libraryID);
    if (library && !tableFilesEditable(library)) return new TableItemError('Library is read-only.', 'invalid_target');
    return null;
}

function requireWritable(ref: TableRef): void {
    const refusal = writeRefusal(ref);
    if (refusal) throw refusal;
}

// ---------------------------------------------------------------------------
// Reading the current state
// ---------------------------------------------------------------------------

interface CurrentState {
    /** The spec in `table.json`, or null when it is not a readable table. */
    spec: TableSpec | null;
    /** Why `spec` is null: an unreadable file, or one missing beside its history. */
    unreadable: TableItemError | null;
    /** The version `table.json` claims. 0 when unknown. */
    version: number;
    history: TableHistory;
    /** The creation marker committed with the spec. */
    file: Omit<TableFile, 'spec'>;
}

/**
 * What the table looks like right now, from both sources of truth, unreconciled
 * — {@link reconcileLog} is what makes them agree. Call only with the lock held.
 * Writes nothing, so a read in a library Beaver may not modify stays a read.
 *
 * An unreadable or missing `table.json` reads with a null spec rather than
 * throwing, so a revert or a restore can write a new one; every other write
 * refuses it through {@link requireCurrentSpec}.
 */
async function readCurrentState(item: Zotero.Item): Promise<CurrentState> {
    const read = await readTableItemSpec(item);
    if (!read.ok && read.code !== 'invalid' && read.code !== 'no_spec' && read.code !== 'corrupt') {
        throw tableReadError(read.code, read.message);
    }
    if (!read.ok) {
        logger(`tableStore: ${read.code} reading ${item.key}: ${read.message}`, 2);
    }
    const spec = read.ok ? read.spec : null;
    const history =
        (await readJson<TableHistory>(historyPathOf(item))) ?? EMPTY_TABLE_HISTORY;
    // Only the creation marker is carried from one commit to the next; any
    // other field an older build wrote is dropped. An unreadable spec keeps its
    // marker, so a write that replaces it does not lose the creation identity.
    const creation = read.ok ? read.file.creation : await readTableFileCreation(item);
    return {
        spec,
        unreadable: read.ok ? null : tableReadError(read.code, read.message),
        file: creation ? { creation } : {},
        version: typeof spec?.version === 'number' ? spec.version : 0,
        history: normalizeTableHistory(history),
    };
}

/** The current spec, or the reason it cannot be edited. */
function requireCurrentSpec(ref: TableRef, current: CurrentState): TableSpec {
    if (current.spec) return current.spec;
    if (current.unreadable?.code === 'corrupt') throw current.unreadable;
    throw new TableItemError(`Table ${ref.key} carries no readable spec.`, 'no_spec');
}

/** Writes `table.json`: the commit point of every write. */
async function writeTableFile(item: Zotero.Item, file: TableFile): Promise<void> {
    const path = tableFilePath(item);
    if (!path) {
        throw new TableItemError(`Table ${item.key} has no storage directory.`, 'file_missing');
    }
    await ensureSidecarDirectory(item);
    await writeAtomic(path, JSON.stringify(file), tableTempPath(item));
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
    meta: TableWriteMeta,
    record?: TableEditRecord
): Promise<TableVersionEntry> {
    return {
        version,
        actor: meta.actor,
        ...(meta.run_id ? { run_id: meta.run_id } : {}),
        ...(meta.thread_id ? { thread_id: meta.thread_id } : {}),
        ...(meta.collapse_key ? { collapse_key: meta.collapse_key } : {}),
        ...(meta.change ? { change: meta.change } : {}),
        at: new Date().toISOString(),
        sha256: await sha256Hex(serialized),
        bytes: new TextEncoder().encode(serialized).length,
        summary: summarize(spec),
        ...(meta.seal ? { sealed: true as const } : {}),
        ...(record
            ? { operation_id: record.operation_id, request_sha256: record.request_sha256, changes: record.changes }
            : {}),
    };
}

/** What a model edit records on the version it commits, so a repeat replays it. */
interface TableEditRecord {
    operation_id: string;
    request_sha256: string;
    changes: unknown[];
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
    version: number,
    creationMeta?: TableWriteMeta
): Promise<TableVersionEntry> {
    const serialized = JSON.stringify(spec);
    await ensureSidecarDirectory(item);
    await writeAtomic(versionPathOf(item, version), serialized, tableTempPath(item));
    const entry = seal(
        await versionEntry(
            version,
            spec,
            serialized,
            creationMeta ?? {
                actor: 'system',
                change: RECOVERED_CHANGE,
            }
        )
    );
    return creationMeta ? { ...entry, creation: true } : entry;
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
    // Entries logged before sizes were recorded are measured from their files,
    // so the byte bound holds for them too; the measured size is kept.
    const sorted = await Promise.all(
        [...entries].sort((a, b) => a.version - b.version).map(async (entry) => {
            if (typeof entry.bytes === 'number') return entry;
            try {
                return { ...entry, bytes: (await IOUtils.stat(versionPathOf(item, entry.version))).size ?? 0 };
            } catch {
                return entry;
            }
        })
    );
    // Newest first: the floor always stays, then either bound stops it.
    let kept = 0;
    let bytes = 0;
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
        const size = sorted[i].bytes ?? 0;
        if (
            kept >= TABLE_VERSION_RETENTION_FLOOR &&
            (kept >= TABLE_VERSION_RETENTION || bytes + size > TABLE_VERSION_RETENTION_BYTES)
        )
            break;
        kept += 1;
        bytes += size;
    }
    const dropped = sorted.slice(0, sorted.length - kept);
    const versions = sorted.slice(sorted.length - kept);
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
    if (!current.spec || current.version <= 0) return { versions, repairs };

    const { version: tableVersion } = current;

    // The log claims commits the document never took. Their version files are
    // above the commit point, so the audit below deletes them.
    const abandoned = versions.filter((e) => e.version > tableVersion);
    if (abandoned.length) {
        versions = versions.filter((e) => e.version <= tableVersion);
        repairs.push({
            kind: 'history_truncated',
            versions: abandoned.map((e) => e.version),
        });
    }

    // The table is ahead of the log: the commit landed and the log rewrite
    // did not.
    if (!versions.some((e) => e.version === tableVersion)) {
        // Version 1 of a table whose creation marker is complete is that
        // creation: version 1 is sealed, so no later write can have reused it.
        const creation = current.file.creation;
        versions = [
            ...versions,
            await reconstructEntry(
                item,
                current.spec,
                tableVersion,
                tableVersion === 1 && creation?.complete ? creation.meta ?? { actor: 'agent' } : undefined
            ),
        ];
        repairs.push({ kind: 'history_appended', version: tableVersion });
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
    tableVersion: number,
    entries: TableVersionEntry[],
    strictCleanup = false
): Promise<Reconciled> {
    const repairs: TableRecovery[] = [];
    let versions = entries;
    const tip = versions.length ? versions[versions.length - 1].version : 0;
    if (tip <= 0) return { versions, repairs };

    // --- the tip's file against its entry
    //
    // Only when the tip is the version `table.json` carries, since that is the
    // spec the repair would write. After {@link reconcileLog} that is the
    // normal case; it is not one on a table whose version stamp was lost, and
    // writing this spec under someone else's number would be worse than the
    // mismatch it was meant to fix.
    const tipEntry = versions[versions.length - 1];
    const tipPath = versionPathOf(item, tip);
    const stored = tableVersion === tip ? await readText(tipPath) : undefined;
    if (
        stored !== undefined &&
        (stored === null ||
            (await sha256Hex(stored)) !== tipEntry.sha256 ||
            (await tableSpecHash(spec)) !== tipEntry.sha256)
    ) {
        const serialized = JSON.stringify(spec);
        await ensureSidecarDirectory(item);
        await writeAtomic(tipPath, serialized, tableTempPath(item));
        versions = [
            ...versions.slice(0, -1),
            {
                ...tipEntry,
                sha256: await sha256Hex(serialized),
                bytes: new TextEncoder().encode(serialized).length,
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
            if (strictCleanup) {
                await IOUtils.remove(versionPathOf(item, version), { ignoreAbsent: true });
            } else {
                await removeQuietly(versionPathOf(item, version));
            }
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
 * attachment and writes `table.json`, but it knows nothing about versions, so a
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
 * `createTableItem` stamped and committed, serialised here. The two agree today
 * because both serialise the same object; if that two-phase stamp ever came to
 * differ from what the store would have written, this file — not the store's
 * idea of it — is what a revert to version 1 restores.
 */
/** A collection a new table can be filed into: in the library and not in the trash. */
function collectionIDForCreate(libraryID: number, key: string): number {
    const collection = Zotero.Collections.getByLibraryAndKey(libraryID, key) as Zotero.Collection | false;
    if (!collection || collection.deleted)
        throw new TableItemError('Collection unavailable.', 'invalid_target');
    return collection.id;
}

export async function createTableUncoordinated(options: CreateTableOptions): Promise<CreatedTable> {
    const { operation_id, accessGuard, collectionKey, ...ordinary } = options;
    const spec = options.spec;
    checkNewSpec(spec, accessGuard);
    if (operation_id === undefined) {
        if (!collectionKey) return createTableOnce({ ...ordinary, spec, accessGuard });
        const target = resolveTableLibrary(options.libraryID);
        if ('error' in target)
            throw new TableItemError('No eligible library for this table.', target.error);
        const collectionID = collectionIDForCreate(target.libraryID, collectionKey);
        return createTableOnce({ ...ordinary, libraryID: target.libraryID, collectionID, spec, accessGuard });
    }
    return withCreationOperation(
        {
            libraryID: options.libraryID,
            operation_id,
            title: options.title || spec.title || 'Table',
            // The collection enters the hash by key: the same request on another
            // device, or after the collection is gone, is still the same request.
            fingerprint: {
                ...ordinary,
                collectionKey,
                linksFor: undefined,
                creationOperation: undefined,
                spec: unstampedSpec(spec),
            },
        },
        (item, requestHash) => replayTableCreation(item, requestHash, accessGuard),
        async ({ libraryID, requestHash, url }) => {
            accessGuard?.(spec);
            const collectionID = collectionKey ? collectionIDForCreate(libraryID, collectionKey) : ordinary.collectionID;
            const created = await createTableOnce({
                ...ordinary,
                ...(collectionID ? { collectionID } : {}),
                accessGuard,
                libraryID,
                spec,
                creationOperation: { operation_id, request_sha256: requestHash, url, meta: creationMeta(options) },
            });
            return { ...created, replayed: false, sha256: created.entry.sha256 };
        }
    );
}

/** A table a creation from a request builds, or why it cannot. */
export type TableBuildResult =
    | { ok: true; spec: TableSpec; changes: unknown[] }
    | { ok: false; code: string; message: string };

export interface CreateTableRequestOptions {
    libraryID: number;
    /** The collection to file into, by key; resolved only for a new table. */
    collectionKey?: string;
    title: string;
    operation_id: string;
    /** What the creation is retried by: fingerprinted in place of the spec. */
    request: unknown;
    actor?: TableActor;
    run_id?: string;
    thread_id?: string;
    change?: string;
    accessGuard?: TableAccessGuard;
    /** Builds the table. Runs only when no earlier import has this identity. */
    build: () => Promise<TableBuildResult>;
}

export type CreatedTableFromRequest = CreatedTable & { changes: unknown[]; replayed: boolean };

/**
 * Creates a table from a request the caller resolves itself — the model's
 * `create`. Same operation identity as {@link createTable}, but the
 * fingerprint covers the request, not a spec: `build` (which resolves sources)
 * runs only for a new table, so a replay never resolves them again, and the
 * change list it answered with is kept on the creation marker and returned by
 * a replay. A failed build writes nothing and comes back unchanged.
 */
export async function createTableFromRequestUncoordinated(
    o: CreateTableRequestOptions
): Promise<CreatedTableFromRequest | { ok: false; code: string; message: string }> {
    return withCreationOperation<CreatedTableFromRequest | { ok: false; code: string; message: string }>(
        {
            libraryID: o.libraryID,
            operation_id: o.operation_id,
            title: o.title || 'Table',
            fingerprint: { request: o.request, collectionKey: o.collectionKey, libraryID: o.libraryID },
        },
        async (item, requestHash): Promise<CreatedTableFromRequest> => {
            const replayed = await replayTableCreation(item, requestHash, o.accessGuard);
            return { ...replayed, changes: replayed.changes ?? [], replayed: true };
        },
        async ({ libraryID, requestHash, url }) => {
            // Before the build: a collection that is gone fails without resolving sources.
            const collectionID = o.collectionKey ? collectionIDForCreate(libraryID, o.collectionKey) : undefined;
            const built = await o.build();
            if (!built.ok) return { ok: false as const, code: built.code, message: built.message };
            checkNewSpec(built.spec, o.accessGuard);
            requireWritable({ libraryID, key: '' });
            const created = await createTableOnce({
                spec: built.spec,
                title: o.title,
                libraryID,
                ...(collectionID ? { collectionID } : {}),
                accessGuard: o.accessGuard,
                actor: o.actor,
                run_id: o.run_id,
                thread_id: o.thread_id,
                change: o.change,
                creationOperation: {
                    operation_id: o.operation_id,
                    request_sha256: requestHash,
                    url,
                    meta: creationMeta(o),
                    changes: built.changes,
                },
            });
            return { ...created, replayed: false, sha256: created.entry.sha256, changes: built.changes };
        }
    );
}

/** The checks a new table's spec passes before anything is imported. */
function checkNewSpec(spec: TableSpec, accessGuard?: TableAccessGuard): void {
    accessGuard?.(spec);
    storedSpecVersion(spec);
    const limit = checkTableLimits(null, spec);
    if (limit) throw new TableItemError(limit.message, 'too_large');
}

function creationMeta(o: Pick<CreateTableOptions, 'actor' | 'run_id' | 'thread_id' | 'change'>): TableCreationState['meta'] {
    return {
        actor: o.actor ?? 'agent',
        run_id: o.run_id,
        thread_id: o.thread_id,
        change: o.change ?? CREATED_CHANGE,
    };
}

/**
 * Runs a retriable creation under its operation identity.
 *
 * The identity lives in the attachment URL (`operation-<sha256(id)>/<slug>`),
 * so it is found again after the process lost every other trace of it, and the
 * lookup and the import happen under one `create:<operation_id>` lock. With an
 * earlier import of that identity `replay` answers from it; otherwise `create`
 * makes the table.
 */
async function withCreationOperation<T>(
    o: { libraryID?: number; operation_id: string; title: string; fingerprint: unknown },
    replay: (item: Zotero.Item, requestHash: string) => Promise<T>,
    create: (identity: { libraryID: number; requestHash: string; url: string }) => Promise<T>
): Promise<T> {
    if (typeof o.operation_id !== 'string' || !o.operation_id.trim())
        throw new TableItemError('operation_id must not be empty.', 'invalid_request');
    const resolved = resolveTableLibrary(o.libraryID);
    if ('error' in resolved)
        throw new TableItemError('No eligible library for this table.', resolved.error);
    const libraryID = resolved.libraryID;
    const requestHash = await tableOperationHash(o.fingerprint);
    const identityUrl = `${TABLE_URL_PREFIX}operation-${await sha256Hex(o.operation_id)}`;
    const url = `${identityUrl}/${buildTableUrl(o.title).slice(TABLE_URL_PREFIX.length)}`;
    return withTableLock({ libraryID, key: `create:${o.operation_id}` }, async () => {
        requireWritable({ libraryID, key: '' });
        const ids: number[] = [];
        await Zotero.DB.queryAsync(
            `SELECT i.itemID FROM items i JOIN itemData d ON d.itemID=i.itemID
             JOIN itemDataValues v ON v.valueID=d.valueID
             WHERE i.libraryID=? AND d.fieldID=? AND (v.value=? OR v.value LIKE ?)`,
            [libraryID, Zotero.ItemFields.getID('url'), identityUrl, `${identityUrl}/%`],
            {
                onRow: (row: any) => {
                    ids.push(row.getResultByIndex(0));
                },
            }
        );
        if (ids.length) {
            if (ids.length !== 1)
                throw new TableItemError(
                    'Multiple imports have this operation identity.',
                    'operation_pending'
                );
            return replay(await Zotero.Items.getAsync(ids[0]), requestHash);
        }
        requireWritable({ libraryID, key: '' });
        return create({ libraryID, requestHash, url });
    });
}

/** Answers a retried creation from the item it made, writing nothing new. */
async function replayTableCreation(
    item: Zotero.Item,
    requestHash: string,
    accessGuard?: TableAccessGuard
): Promise<CreatedTable & { changes?: unknown[] }> {
    const ref = { libraryID: item.libraryID, key: item.key };
    return withTableLock(ref, async () => {
        requireWritable(ref);
        await loadTableItemFields([item]);
        const path = tableFilePath(item);
        if (!path || !(await IOUtils.exists(path))) {
            // Beside a retained history the creation committed and the file
            // was lost since; without one the import never got that far.
            if ((await readTableHistory(item)).versions.length)
                throw new TableItemError(`Table ${item.key} has no table.json; restore a retained version to repair it.`, 'corrupt');
            throw new TableItemError('The earlier import has no committed table yet.', 'operation_pending');
        }
        const opened = await readCurrentState(item);
        const creation = opened.file.creation;
        if (creation?.request_sha256 !== requestHash)
            throw new TableItemError('Operation identity was reused with a different request.', 'operation_mismatch');
        if (!creation.complete || item.deleted)
            throw new TableItemError('The earlier import is incomplete or has been discarded.', 'operation_pending');
        if (!opened.spec)
            throw new TableItemError('The earlier creation has no matching readable spec.', 'invalid_spec');
        const spec = opened.spec;
        accessGuard?.(spec);
        await guardStoredTable(ref, item, opened, accessGuard);
        let saved = true;
        let entry = seal(await versionEntry(spec.version ?? 1, spec, JSON.stringify(spec),
            creation.meta ?? { actor: 'agent' }));
        try {
            const history = await reconcileLog(item, opened);
            const audited = await auditSidecar(item, spec, opened.version, history.versions);
            if (history.repairs.length || audited.repairs.length) await commitHistory(item, audited.versions);
            entry = audited.versions[audited.versions.length - 1];
            await repairItemBookkeeping(item);
        } catch (error) {
            saved = false;
            logger(`tableStore: committed creation still needs repair: ${String(error)}`, 1);
        }
        // Version 1 is sealed, so a table still at it holds the created state;
        // its shadow is recorded only when missing, never over later evidence.
        const sha256 = await tableSpecHash(spec);
        try {
            if (spec.version === 1 && !(await lastTableShadow(ref))) {
                await recordTableShadow(ref, 1, JSON.stringify(spec), sha256);
            }
        } catch (error) {
            logger(`tableStore: could not repair the creation recovery shadow for ${ref.key}: ${String(error)}`, 2);
        }
        emitTableUpdated(ref, entry.version, entry);
        return {
            ...describeTableItem(item, spec, (await readSnapshotText(item)) ?? ''),
            version: spec.version ?? 1,
            entry,
            replayed: true,
            saved,
            sha256,
            ...(creation.changes ? { changes: creation.changes } : {}),
        };
    });
}

/**
 * The snapshot's text, for describing a committed creation. Best effort: a
 * snapshot that is missing or unreadable answers null and never fails a
 * creation that has already committed.
 */
async function readSnapshotText(item: Zotero.Item): Promise<string | null> {
    try {
        const path = await item.getFilePathAsync();
        return path ? await IOUtils.readUTF8(path) : null;
    } catch (error) {
        logger(`tableStore: could not read the snapshot of ${item.key}: ${String(error)}`, 2);
        return null;
    }
}

/**
 * Renders a committed table's snapshot as part of the write that committed
 * it. Call with the table's lock held. A failure is bookkeeping: logged,
 * answered false, and repaired by the next open.
 */
async function renderCommitted(ref: TableRef): Promise<boolean> {
    try {
        // False when the library stopped being writable after the commit.
        return await renderTable(ref);
    } catch (error) {
        logger(`tableStore: rendering ${ref.key} failed: ${String(error)}`, 1);
        return false;
    }
}

async function createTableOnce(options: CreateTableOptions): Promise<CreatedTable> {
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

    let saved = true;
    let entry = { ...seal(await versionEntry(created.spec.version ?? 1, created.spec,
        JSON.stringify(created.spec), meta)), creation: true as const };
    try {
        entry = await withTableLock(ref, async () => {
            const version = created.spec.version ?? 1;
            const serialized = JSON.stringify(created.spec);
            const seeded = {
                ...seal(await versionEntry(version, created.spec, serialized, meta)),
                creation: true as const,
            };

            await ensureSidecarDirectory(created.item);
            await writeAtomic(
                versionPathOf(created.item, version),
                serialized,
                tableTempPath(created.item)
            );
            await commitHistory(created.item, [seeded]);
            // Version 1 is a write like any other as far as the shadow is
            // concerned, and it is the state most likely to be wanted back.
            await recordTableShadow(ref, version, serialized, seeded.sha256).catch((error) =>
                logger(
                    `tableStore: could not record the recovery shadow for ${ref.key}: ${String(error)}`,
                    2
                )
            );
            return seeded;
        });
    } catch (error) {
        saved = false;
        logger(`tableStore: committed creation needs history repair: ${String(error)}`, 1);
    }
    let described: CreatedTableItem = created;
    await withTableLock(ref, async () => {
        // The item's tags may not have been saved; the render adds them.
        if (created.saved === false) await markTablePending(created.item);
        // A render that lands also saves the item, tags included.
        if (!(await renderCommitted(ref))) {
            saved = false;
            return;
        }
        // Describe the snapshot as rendered, as a replay of this creation will.
        const html = await readSnapshotText(created.item);
        if (html !== null) described = describeTableItem(created.item, created.spec, html);
    });
    emitTableUpdated(ref, entry.version, meta);
    return { ...created, ...described, saved, version: entry.version, entry };
}

/** JSON object key order is irrelevant to retry identity; array order is significant. */
export async function tableOperationHash(value: unknown): Promise<string> {
    const canonical = (input: any): any => {
        if (Array.isArray(input)) return input.map(canonical);
        if (input && typeof input === 'object') return Object.fromEntries(
            Object.keys(input).sort().filter((key) => input[key] !== undefined)
                .map((key) => [key, canonical(input[key])])
        );
        return input;
    };
    return sha256Hex(JSON.stringify(canonical(value)));
}

function unstampedSpec(spec: TableSpec): Omit<TableSpec, 'key' | 'version'> {
    const { key: _key, version: _version, ...content } = spec;
    return { ...content, spec_version: content.spec_version ?? TABLE_SPEC_VERSION };
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
 * 2. Read `table.json` and the log, and reconcile them ({@link reconcileLog})
 *    so the tip is the version the table actually committed.
 * 3. Refuse with a conflict when the tip is not `expectedVersion`, handing back
 *    the current spec so the caller can rebase. `expectedVersion` undefined
 *    means "no guard".
 * 4. Write `beaver/v<N>.json`, temp file + rename — but only *before* the
 *    commit when this write is taking a new number. See below.
 * 5. Write `table.json`, temp file + rename. **This is the commit point** —
 *    the moment it lands the table is the new one whatever happens next.
 * 6. Rewrite `beaver/history.json`, applying the retention bounds and deleting
 *    the version files that fall out of them. A crash before this leaves the
 *    log behind the table, which the next reconciliation repairs.
 * 7. Record the recovery shadow, release the lock and schedule the snapshot
 *    render, which indexes, marks the attachment for upload and saves the item
 *    — Zotero schedules auto-sync off data-object notifications, not off file
 *    writes, so without it the change sits unsynced.
 *
 * ## Nothing after step 5 may reject
 *
 * Step 6 — and the version file a *collapsing* write defers past the commit —
 * run when the table on disk is already the new one. So they are not allowed
 * to fail the call in either of the two ways they could: not by crashing (the
 * next open reconciles what they left behind) and not by throwing, which is the
 * worse half, because it tells the caller the write did not happen while it
 * did. A retrying agent would then apply its mutations to an already-mutated
 * table. They report through `saved: false` instead, and the call still
 * succeeds. A failed render never reaches the caller at all.
 *
 * ## Writes with one collapse key collapse
 *
 * When the tip was written under this write's collapse key by the same actor
 * and is not sealed, the version file and the log entry are overwritten in
 * place and the number does not advance. The key is `meta.collapse_key` (a
 * fill's job id, a tab's editing session) or, for an agent write without one,
 * its run and thread. A fill that commits every few rows would otherwise issue
 * a hundred versions nobody wants to revert to individually.
 *
 * The rule that makes it safe is that the number is only ever reused while it
 * is still the writer's own: once anyone else has written above it the next
 * write appends. **A version number, once issued, must never move off a state
 * the user could still be looking at or reverting to** — which is why a user
 * write without a key is its own version, and why a sealed version (creation,
 * a model edit, a destructive edit, a restore, a reconstructed entry) is never
 * reused. A sealed write never collapses onto the tip either.
 *
 * A collapsing write also inverts steps 4 and 5. Its version file is one the
 * log already points at, so overwriting it before the commit lands would leave
 * a file describing neither the old state nor the new one; writing it after
 * means the worst a crash can leave is a file holding an earlier moment of the
 * same writer's working version. The sidecar audit compares both the retained
 * file and the current spec against the log digest and repairs either mismatch.
 *
 * This is the local whole-spec write (a restore, development tooling). It may
 * replace an unreadable `table.json`; edits go through {@link editTable},
 * {@link editTableSession} and {@link applyTableEdit}.
 */
export async function writeTableUncoordinated(
    ref: TableRef,
    spec: TableSpec,
    meta: TableWriteMeta,
    expectedVersion?: number
): Promise<TableWriteResult> {
    requireWritable(ref);
    const result = await withTableLock(ref, async () => {
        const { item, current } = await prepareWrite(ref);
        return commitWrite(ref, item, current, spec, meta, { expectedVersion, carryRevisions: true });
    });
    if (result.ok) emitTableUpdated(ref, result.version, meta);
    return result;
}

/**
 * The key a write or a version entry collapses under: its explicit
 * `collapse_key`, else an agent write's run and thread; undefined for a write
 * that always takes a new version.
 */
function collapseKeyOf(
    entry: Pick<TableVersionEntry, 'actor' | 'run_id' | 'thread_id' | 'collapse_key'>
): string | undefined {
    if (entry.collapse_key) return `key:${entry.collapse_key}`;
    if (entry.actor === 'agent' && entry.run_id) return `run:${entry.run_id}\u0000${entry.thread_id ?? ''}`;
    return undefined;
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

interface CommitOptions {
    /** Refuse with a conflict unless the tip is this version. */
    expectedVersion?: number;
    /** Checked on the current and the resulting spec, just before the commit. */
    accessGuard?: TableAccessGuard;
    /** Carry and advance column revisions (whole-spec writes and reverts). */
    carryRevisions?: boolean;
    /** The model edit this version records. */
    record?: TableEditRecord;
}

/**
 * The write itself — the sequence and the collapse rule documented on
 * {@link writeTable}. Call only with the lock held.
 */
async function commitWrite(
    ref: TableRef,
    item: Zotero.Item,
    current: CurrentState,
    spec: TableSpec,
    meta: TableWriteMeta,
    options: CommitOptions = {}
): Promise<TableWriteResult> {
    const { expectedVersion, accessGuard, carryRevisions = false, record } = options;
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
    // an unreadable or unstamped table there is nothing to reconcile against,
    // so the log stands on its own.
    const tip = versions.length ? versions[versions.length - 1].version : current.version;

    if (expectedVersion !== undefined && expectedVersion !== tip) {
        const sha256 = current.spec ? await tableSpecHash(current.spec) : null;
        return { ok: false, conflict: true, version: tip, sha256, spec: current.spec };
    }
    const limit = checkTableLimits(current.spec, spec);
    if (limit) throw new TableItemError(limit.message, 'too_large');

    const tipEntry = versions.find((e) => e.version === tip);
    const key = collapseKeyOf(meta);
    const collapse =
        key !== undefined &&
        !meta.seal &&
        !!tipEntry &&
        !tipEntry.sealed &&
        tipEntry.actor === meta.actor &&
        collapseKeyOf(tipEntry) === key;
    const version = collapse ? tip : tip + 1;

    // Never the caller's word for either: the file says which table it is and
    // which revision of it, and only the store gets to decide that. A
    // whole-spec write or a revert changes columns without `update_column`,
    // so their revisions are carried and advanced here, and a fill's answer
    // planned against a column such a write changed is skipped. Mutation
    // writes are left to the engine: a fill's own answers grow an open
    // select's options, which must not invalidate the rest of that fill.
    const stored: TableSpec = {
        ...(carryRevisions ? carryColumnRevisions(current.spec, spec) : spec),
        spec_version: storedSpecVersion(spec),
        key: item.key,
        version,
    };

    const serialized = JSON.stringify(stored);
    const entry = await versionEntry(version, stored, serialized, meta, record);

    await ensureSidecarDirectory(item);
    const temp = tableTempPath(item);
    const versionPath = versionPathOf(item, version);
    const file: TableFile = { spec: stored, ...current.file };

    if (!collapse) {
        // Nothing points at this number yet, so a crash between the two leaves
        // a file the next open deletes as garbage and a table nobody touched.
        // Still before the commit point, so a failure here is a failed write.
        await writeAtomic(versionPath, serialized, temp);
    }
    requireWritable(ref);
    if (current.spec) accessGuard?.(current.spec);
    accessGuard?.(stored);
    await writeTableFile(item, file);

    // ---- past the commit point ------------------------------------------
    // The table on disk is the new one from here down, so nothing below may
    // reject: a caller told the write failed would apply its mutations again,
    // onto a table that already has them. Every remaining step reports through
    // `saved` instead, and everything it can leave behind is something the next
    // `openTable` reconciles.
    let saved = true;
    const bookkeepingFailed = (step: string, error: unknown): void => {
        saved = false;
        logger(
            `tableStore: ${ref.key} v${version} was committed but ${step} failed: ${String(error)}`,
            1
        );
    };

    if (collapse) {
        // The version file is already referenced by the log, so it goes last.
        try {
            await writeAtomic(versionPath, serialized, temp);
        } catch (error) {
            bookkeepingFailed('rewriting its version file', error);
        }
    }

    let pruned: number[] = [];
    try {
        pruned = await commitHistory(item, mergeEntry(versions, entry));
    } catch (error) {
        bookkeepingFailed('rewriting the version log', error);
    }

    // The recovery shadow: what this device wrote, kept outside the storage
    // directory so it survives that directory being replaced by a sync
    // conflict resolution. Logged and dropped on failure, and the one
    // post-commit step that stays out of `saved`: it is insurance held beside
    // the table rather than part of it, and its absence changes nothing about
    // the table the caller was handed.
    await recordTableShadow(ref, version, serialized, entry.sha256).catch((error) =>
        logger(
            `tableStore: could not record the recovery shadow for ${ref.key}: ${String(error)}`,
            2
        )
    );

    if (!(await renderCommitted(ref))) saved = false;

    return {
        ok: true,
        sha256: entry.sha256,
        version,
        collapsed: collapse,
        saved,
        spec: stored,
        entry,
        pruned,
    };
}

/**
 * Repairs the item-level marks of a committed table and, when its last render
 * did not cover it (or `render` says the snapshot is stale), renders it:
 * indexing, the upload mark and the item save.
 * Call with the table's lock held.
 */
async function repairItemBookkeeping(item: Zotero.Item, options: { render?: boolean } = {}): Promise<void> {
    const ref = { libraryID: item.libraryID, key: item.key };
    requireWritable(ref);
    if (!item.hasTag(TABLE_TAG) || !item.hasTag(TABLE_EMOJI_TAG)) {
        item.addTag(TABLE_TAG, 1);
        item.addTag(TABLE_EMOJI_TAG, 1);
        await item.saveTx();
    }
    if ((options.render || !(await renderIsCurrent(item))) && !(await renderCommitted(ref))) {
        throw new Error(`Table ${ref.key} could not be rendered.`);
    }
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * The ergonomic write: read the table, apply `mutations`, store the result.
 * Cell writes the engine declines (user cells, changed questions) come back in
 * `skipped`; the rest of the batch is stored.
 *
 * Read, apply and write happen in **one** lock acquisition, because they are
 * one operation. Splitting them is what would let two same-run edits both start
 * from the same spec and both collapse onto the same version, with the first
 * one's mutations gone from the file and from the log while both callers were
 * told they succeeded.
 *
 * A UI draft may supply the version/hash pair it displayed. That optional
 * guard is checked inside the lock before applying mutations, so a concurrent
 * edit produces a conflict rather than silently overwriting a correction.
 * Calls without a guard apply directly to the current state under the lock.
 * This is process-local serialization, not a cross-device lock.
 *
 * A mutation the table cannot accept comes back unchanged: the caller wrote
 * something wrong, and retrying would not fix it.
 */
export async function editTableUncoordinated(
    ref: TableRef,
    mutations: TableMutation[],
    meta: TableWriteMeta,
    expected?: { version: number; sha256: string }
): Promise<TableEditResult> {
    requireWritable(ref);
    const result = await withTableLock(ref, async () => {
        const { item, current } = await prepareWrite(ref);
        const spec = requireCurrentSpec(ref, current);

        if (expected && (current.version !== expected.version || await tableSpecHash(spec) !== expected.sha256)) {
            return { ok: false, conflict: true, version: current.version, sha256: await tableSpecHash(spec), spec } as const;
        }
        const applied = applyMutations(spec, mutations);
        if (!applied.ok) return { ok: false, error: applied.error } as const;

        const written = await commitWrite(ref, item, current, applied.spec, meta);
        return written.ok ? { ...written, skipped: applied.skipped } : written;
    });
    if (result.ok) emitTableUpdated(ref, result.version, meta);
    return result;
}

/** One commit of a fill job: its cell writes and row updates. */
export interface TableEditSessionRequest {
    mutations: TableMutation[];
}

export type TableEditSessionResult =
    | {
          ok: true;
          version: number;
          sha256: string;
          spec: TableSpec;
          saved: boolean;
          skipped: SkippedCell[];
      }
    | TableEditRejected;

/**
 * One commit of a fill job, an incremental write.
 *
 * Applies `mutations` to the current table under the lock with no revision
 * guard: a cell write conflicts only with a change to that cell, its row or its
 * column, and the engine handles each per cell (`skipMissing`), so a row or
 * column removed while the fill ran is skipped and reported and the rest of
 * the commit lands. It commits like every other write — `table.json`, the
 * history, the shadow, then the render — collapses by its collapse key (the
 * job id) onto a tip nobody else wrote, and emits the update event after the
 * render. A job's commits are local and never repeated.
 *
 * The access guard covers the current and the resulting spec (inside the
 * commit), not the retained versions a guarded open also inspects: a fill
 * commits often, and the history is unchanged by it apart from the job's own
 * version.
 */
export async function editTableSessionUncoordinated(
    ref: TableRef,
    request: TableEditSessionRequest,
    meta: TableWriteMeta,
    accessGuard?: TableAccessGuard
): Promise<TableEditSessionResult> {
    requireWritable(ref);
    if (!Array.isArray(request.mutations)) {
        throw new TableItemError('A fill commit requires mutations.', 'invalid_request');
    }
    const result = await withTableLock(ref, async (): Promise<TableEditSessionResult> => {
        const { item, current } = await prepareWrite(ref);
        const applied = applyMutations(requireCurrentSpec(ref, current), request.mutations, { skipMissing: true });
        if (!applied.ok) return { ok: false, error: applied.error };
        const written = await commitWrite(ref, item, current, applied.spec, meta, { accessGuard });
        // Without an expected version the write cannot conflict; an unreadable
        // table was refused above.
        if (!written.ok) throw new TableItemError(`Table ${ref.key} could not be written.`, 'corrupt');
        return {
            ok: true,
            version: written.version,
            sha256: written.sha256,
            spec: written.spec,
            saved: written.saved,
            skipped: applied.skipped,
        };
    });
    if (result.ok) emitTableUpdated(ref, result.version, meta);
    return result;
}

/** The identity of a model edit, so a repeat of it applies once. */
export interface TableEditOperation {
    operation_id: string;
    /** Fingerprint of the request; the same id with another request is refused. */
    request_sha256: string;
}

/** Builds the edited spec from the current one, or says why it cannot. */
export type TableEditBuild = (spec: TableSpec) =>
    | { ok: true; spec: TableSpec; changes: unknown[] }
    | { ok: false; code: string; message: string };

export type TableApplyEditResult =
    | {
          ok: true;
          /** A repeat answered from the version the first call committed. */
          replayed: boolean;
          version: number;
          sha256: string;
          spec: TableSpec;
          saved: boolean;
          changes: unknown[];
      }
    | { ok: false; code: string; message: string };

/**
 * One model edit (`apply_edit`): build the new spec from the current one and
 * commit it as one sealed version, under the lock.
 *
 * The version entry records the edit's `operation_id`, request fingerprint
 * and change list. A repeat with the same id finds that entry among the
 * retained versions and answers the current state with the recorded changes,
 * writing nothing; the same id with a different request is
 * `operation_mismatch`. A failed build, or one that changes nothing, writes
 * nothing. Column revisions come from the build, not from the store.
 */
export async function applyTableEditUncoordinated(
    ref: TableRef,
    build: TableEditBuild,
    meta: TableWriteMeta,
    operation: TableEditOperation,
    accessGuard?: TableAccessGuard
): Promise<TableApplyEditResult> {
    requireWritable(ref);
    if (
        typeof operation?.operation_id !== 'string' || !operation.operation_id.trim() ||
        typeof operation.request_sha256 !== 'string' || !operation.request_sha256
    ) {
        throw new TableItemError('An edit requires operation_id and request_sha256.', 'invalid_request');
    }
    let committed = false;
    const result = await withTableLock(ref, async (): Promise<TableApplyEditResult> => {
        const { item, current } = await prepareWrite(ref);
        const spec = requireCurrentSpec(ref, current);
        accessGuard?.(spec);
        const sha256 = await tableSpecHash(spec);

        const prior = current.history.versions.find((e) => e.operation_id === operation.operation_id);
        if (prior) {
            if (prior.request_sha256 !== operation.request_sha256) {
                throw new TableItemError('Operation identity was reused with a different request.', 'operation_mismatch');
            }
            // A repeat may follow a render that never finished.
            const saved = (await renderIsCurrent(item)) || (await renderCommitted(ref));
            return { ok: true, replayed: true, version: current.version, sha256, spec, saved, changes: prior.changes ?? [] };
        }

        const built = build(spec);
        if (!built.ok) return { ok: false, code: built.code, message: built.message };
        if ((await tableOperationHash(unstampedSpec(built.spec))) === (await tableOperationHash(unstampedSpec(spec)))) {
            return { ok: true, replayed: false, version: current.version, sha256, spec, saved: true, changes: built.changes };
        }
        const written = await commitWrite(ref, item, current, built.spec, { ...meta, seal: true }, {
            accessGuard,
            record: { ...operation, changes: built.changes },
        });
        // Without an expected version the write cannot conflict.
        if (!written.ok) throw new TableItemError(`Table ${ref.key} could not be written.`, 'corrupt');
        committed = true;
        return {
            ok: true,
            replayed: false,
            version: written.version,
            sha256: written.sha256,
            spec: written.spec,
            saved: written.saved,
            changes: built.changes,
        };
    });
    if (committed && result.ok) emitTableUpdated(ref, result.version, meta);
    return result;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The version log, oldest first. */
export async function listVersions(ref: TableRef): Promise<TableVersionEntry[]> {
    return (await readTableHistory(await resolveTableItem(ref))).versions;
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
export async function openTableUncoordinated(ref: TableRef, accessGuard?: TableAccessGuard): Promise<OpenTableResult> {
    return withTableLock(ref, async () => {
        const item = await resolveTableItem(ref);
        const current = await readCurrentState(item);
        const spec = requireCurrentSpec(ref, current);

        if (current.file.creation && !current.file.creation.complete) {
            throw new TableItemError('The imported table is not confirmed complete.', 'operation_pending');
        }
        const recovered = await guardStoredTable(ref, item, current, accessGuard);
        const sha256 = await tableSpecHash(spec);
        const library = Zotero.Libraries.get(ref.libraryID);
        if (!checkLibraryExcluded(ref.libraryID) && tableFilesEditable(library)) {
            try {
                const reconciled = await reconcileLog(item, current);
                const audited = await auditSidecar(
                    item,
                    spec,
                    current.version,
                    reconciled.versions
                );
                recovered.push(...reconciled.repairs, ...audited.repairs);
                if (reconciled.repairs.length || audited.repairs.length) {
                    const pruned = await commitHistory(item, audited.versions);
                    if (pruned.length) recovered.push({ kind: 'pruned', versions: pruned });
                }
                // A snapshot a render behind (a sync that carried the table but
                // not its rendering, or a render that failed) is re-rendered.
                const rendered = await renderIsCurrent(item);
                if (recovered.length || !rendered) {
                    await guardStoredTable(ref, item, current, accessGuard);
                    await repairItemBookkeeping(item, { render: !rendered });
                    if (!rendered) recovered.push({ kind: 'rerendered' });
                    if (current.version === 1 && current.file.creation?.complete) {
                        try {
                            if (!(await lastTableShadow(ref))) await recordTableShadow(ref, 1,
                                JSON.stringify(spec), sha256);
                        } catch (error) {
                            logger(`tableStore: creation shadow repair unavailable: ${String(error)}`, 2);
                        }
                    }
                }
            } catch (error) {
                if (error instanceof TableItemError && error.code === 'library_excluded') throw error;
                recovered.push({ kind: 'bookkeeping_pending' });
                logger(`tableStore: local bookkeeping repair failed: ${String(error)}`, 1);
            }
        } else if (!(await renderIsCurrent(item))) {
            recovered.push({ kind: 'bookkeeping_pending' });
        }

        const history = normalizeTableHistory(
            await readJson<TableHistory>(historyPathOf(item))
        );
        return {
            ref,
            sha256,
            spec,
            version: Math.max(current.version, history.tip),
            history: history.versions,
            recovered,
            conflict: await detectSyncConflict(ref, current),
        };
    });
}

/**
 * Whether the table went backwards under this device.
 *
 * The table's version is compared against the last one this device wrote.
 * The digest is only computed when the two numbers are equal, because that is
 * the only case it decides — and hashing a re-serialised megabyte on every open
 * to answer a question already settled would be a real cost for nothing.
 *
 * The comparison is exact rather than approximate, and that is what keeps an
 * ordinary open silent: the shadow's digest is over the very bytes the store
 * wrote to `beaver/v<N>.json`, and the document embeds that same spec, so a
 * table nobody else touched hashes to what the shadow recorded.
 */
async function detectSyncConflict(
    ref: TableRef,
    current: CurrentState
): Promise<TableSyncConflict | null> {
    try {
        if (!current.spec || current.version <= 0) return null;
        const shadow = await lastTableShadow(ref);
        if (!shadow) return null;
        const sha256 =
            current.version === shadow.version
                ? await tableSpecHash(current.spec)
                : null;
        return detectTableSyncConflict(shadow, {
            version: current.version,
            sha256,
        });
    } catch (error) {
        // Opening a table must not fail because the shadow could not be read.
        logger(
            `tableStore: could not check the recovery shadow for ${ref.key}: ${String(error)}`,
            2
        );
        return null;
    }
}

// ---------------------------------------------------------------------------
// Restoring what a sync conflict took
// ---------------------------------------------------------------------------

/** The version this device last wrote, and its spec when a restore could write it back. */
async function retainedShadow(
    ref: TableRef
): Promise<{ shadow: null; spec: null } | { shadow: TableShadowEntry; spec: TableSpec | null }> {
    const shadow = await lastTableShadow(ref);
    if (!shadow) return { shadow: null, spec: null };
    return { shadow, spec: await readTableShadowSpec(shadow) };
}

/**
 * Why the table itself would refuse a restore's write, or null when it would
 * accept one: the checks {@link prepareWrite} makes on the item and its current
 * file — a trashed table, or a `table.json` that is missing beyond repair or
 * written in another format. Reads only, so it may run without the lock.
 */
async function restoreTargetRefusal(ref: TableRef): Promise<TableItemError | null> {
    try {
        await readCurrentState(await resolveTableItem(ref));
        return null;
    } catch (error) {
        if (error instanceof TableItemError) return error;
        throw error;
    }
}

/**
 * Whether {@link restoreShadowVersion} would write a version back right now,
 * checked the way the restore checks it. Surfaces that offer or mention the
 * restore ask this rather than judging from the shadow row, whose payload can
 * be over the retention cap, pruned or no longer match its digest.
 *
 * - `ok`: the restore would run.
 * - `no_shadow` / `no_payload`: this device keeps no usable copy.
 * - `not_writable`: a copy is kept, but the library is excluded or read-only.
 * - `unavailable`: a copy is kept, but the table is trashed or its current file
 *   cannot be written over (see {@link restoreTargetRefusal}).
 */
export async function checkShadowRestore(ref: TableRef): Promise<TableShadowRestoreCheck> {
    try {
        const retained = await retainedShadow(ref);
        if (!retained.shadow) return 'no_shadow';
        if (!retained.spec) return 'no_payload';
        if (writeRefusal(ref)) return 'not_writable';
        return (await restoreTargetRefusal(ref)) ? 'unavailable' : 'ok';
    } catch (error) {
        logger(`tableStore: could not check the restore for ${ref.key}: ${String(error)}`, 2);
        return 'no_payload';
    }
}

/**
 * Writes the version this device last wrote back, as a **new** version.
 *
 * The whole point is that it goes through {@link writeTable} rather than around
 * it: the state the conflict resolution left behind keeps its number and stays
 * in the log, the restored state gets the next number, and the user can revert
 * between them like any other pair of versions. Nothing is erased, and the
 * exclusion boundary, the lock and the crash-safe write order all apply exactly
 * as they do to any other write.
 *
 * A shadow that has a version but no usable spec — over the retention size cap,
 * pruned, or no longer matching its digest — is refused with `no_payload`
 * rather than restored approximately. Detecting a loss it cannot undo is a
 * useful thing to say; pretending to undo it is not.
 */
export async function restoreShadowVersionUncoordinated(
    ref: TableRef,
    meta: TableWriteMeta = { actor: 'user' }
): Promise<TableShadowRestoreResult> {
    requireWritable(ref);

    const retained = await retainedShadow(ref);
    if (!retained.shadow) {
        return {
            ok: false,
            code: 'no_shadow',
            error: `This device has no recorded version of table ${ref.key} to restore.`,
        };
    }
    const { shadow, spec } = retained;
    if (!spec) {
        return {
            ok: false,
            code: 'no_payload',
            version: shadow.version,
            error:
                `This device wrote version ${shadow.version} of table ${ref.key}, but its ` +
                'stored copy is missing or no longer matches what was recorded for it, so it cannot be restored.',
        };
    }
    const refusal = await restoreTargetRefusal(ref);
    if (refusal) {
        return { ok: false, code: 'write_refused', version: shadow.version, error: refusal.message };
    }

    // A restore is a deliberate step, never folded into whatever version a run
    // is currently building — the same rule a revert follows.
    const result = await writeTableUncoordinated(ref, spec, {
        ...meta,
        run_id: undefined,
        seal: true,
        change: meta.change ?? `Restored this device's version ${shadow.version}`,
    });
    if (!result.ok) {
        return {
            ok: false,
            code: 'write_refused',
            version: shadow.version,
            error: `The table is at version ${result.version}; the restore was refused.`,
        };
    }
    return {
        ok: true,
        version: result.version,
        restoredFrom: shadow.version,
        entry: result.entry,
    };
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
export async function revertTableUncoordinated(
    ref: TableRef,
    toVersion: number,
    meta: TableWriteMeta,
    accessGuard?: TableAccessGuard
): Promise<TableWriteResult> {
    requireWritable(ref);
    // A revert is a deliberate step back, so it is never folded into the
    // version a run is currently building.
    const revertMeta: TableWriteMeta = {
        ...meta,
        change: meta.change ?? `Reverted to version ${toVersion}`,
        run_id: undefined,
        seal: true,
    };

    const result = await withTableLock(ref, async () => {
        const { item, current } = await prepareWrite(ref);
        await guardStoredTable(ref, item, current, accessGuard);
        const spec = await readStoredVersion(ref, item, current, toVersion);
        accessGuard?.(spec);
        return commitWrite(ref, item, current, spec, revertMeta, { accessGuard, carryRevisions: true });
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
            `Version ${version} of table ${ref.key} was written in another format (spec_version ${read.specVersion}).`,
            'unsupported_version'
        );
    }
    throw new TableItemError(
        `Version ${version} of table ${ref.key} is not a readable table: ${read.detail}`,
        'version_corrupt'
    );
}

function isKnownCreation(entry: TableVersionEntry): boolean {
    return (
        entry.creation === true ||
        (entry.version === 1 && entry.sealed === true && entry.actor !== 'system')
    );
}

export interface TableTrimRequest {
    thread_id: string;
    run_ids: string[];
}

export interface TableTrimResult {
    ok: true;
    outcome: 'unchanged' | 'trimmed' | 'trashed';
    trimmed_versions: number[];
    trimmed_to: number | null;
    retention_exhausted: boolean;
    saved: boolean;
}

/** Trash is already committed; cleanup failure must remain visible and retriable. */
async function retireTrashedTableShadow(ref: TableRef): Promise<boolean> {
    try {
        await pruneTableShadow(ref, true);
        return true;
    } catch (error) {
        logger(`tableStore: table is trashed but shadow cleanup failed: ${String(error)}`, 1);
        return false;
    }
}

/** Drops only the contiguous suffix owned by discarded runs of this conversation. */
export async function trimTableUncoordinated(
    ref: TableRef,
    request: TableTrimRequest,
    accessGuard?: TableAccessGuard
): Promise<TableTrimResult> {
    requireWritable(ref);
    if (
        typeof request.thread_id !== 'string' ||
        !request.thread_id.trim() ||
        !Array.isArray(request.run_ids) ||
        request.run_ids.some((id) => typeof id !== 'string' || !id.trim())
    ) {
        throw new TableItemError('Trim requires thread_id and run_ids.', 'invalid_request');
    }
    const result = await withTableLock(ref, async (): Promise<TableTrimResult> => {
        const existing = await Zotero.Items.getByLibraryAndKeyAsync(ref.libraryID, ref.key) as
            | Zotero.Item
            | false;
        requireWritable(ref);
        if (accessGuard && existing && !existing.deleted) {
            await loadTableItemFields([existing]);
            if (isTableAttachment(existing))
                await guardStoredTable(ref, existing, await readCurrentState(existing), accessGuard);
        }
        if (existing && existing.deleted) {
            await loadTableItemFields([existing]);
            if (!isTableAttachment(existing))
                throw new TableItemError('Item is not a stored table.', 'not_a_table');
            return {
                ok: true,
                outcome: 'unchanged',
                trimmed_versions: [],
                trimmed_to: null,
                retention_exhausted: false,
                saved: await retireTrashedTableShadow(ref),
            };
        }
        const { item, current } = await prepareWrite(ref);
        if (!current.spec)
            throw new TableItemError('The table has no readable state to trim.', 'no_spec');
        const reconciled = await reconcileLog(item, current);
        // A surviving file with a lost log entry has unknown ownership and must
        // become a protected boundary before we choose the discardable suffix.
        // Cleanup must also succeed before a retry can acknowledge the prior trim.
        const audited = await auditSidecar(item, current.spec, current.version, reconciled.versions, true);
        const versions = audited.versions;
        const runs = new Set(request.run_ids);
        let keep = versions.length;
        while (keep > 0) {
            const entry = versions[keep - 1];
            if (
                entry.actor !== 'agent' ||
                entry.thread_id !== request.thread_id ||
                !entry.run_id ||
                !runs.has(entry.run_id) ||
                (entry.sealed && !isKnownCreation(entry))
            )
                break;
            keep--;
        }
        // Losing the oldest retained state is not proof the discarded runs created the item.
        const exhausted = keep === 0 && versions.length > 0 && !isKnownCreation(versions[0]);
        if (exhausted) keep = 1;
        const dropped = versions.slice(keep).map((entry) => entry.version);
        const target = keep ? versions[keep - 1].version : null;
        if (!dropped.length) {
            if (reconciled.repairs.length || audited.repairs.length) {
                await commitHistory(item, versions);
            }
            // A previous trim may have committed the table before its render
            // landed; the render is what indexes, uploads and saves the item.
            const saved = (await renderIsCurrent(item)) || (await renderCommitted(ref));
            return {
                ok: true,
                outcome: 'unchanged',
                trimmed_versions: [],
                trimmed_to: target,
                retention_exhausted: exhausted,
                saved,
            };
        }
        if (keep === 0) {
            requireWritable(ref);
            await guardStoredTable(ref, item, await readCurrentState(item), accessGuard);
        await trashTableItem(item);
            const saved = await retireTrashedTableShadow(ref);
            return {
                ok: true,
                outcome: 'trashed',
                trimmed_versions: dropped,
                trimmed_to: null,
                retention_exhausted: false,
                saved,
            };
        }
        const spec = await readStoredVersion(
            ref,
            item,
            { ...current, history: { tip: current.version, versions } },
            target!
        );
        await ensureSidecarDirectory(item);
        // Intentionally retire the discarded shadow before the rollback commit. A failed
        // commit may lose this insurance, but must not report an intentional rewind as sync loss.
        await pruneTableShadow(ref, true);
        requireWritable(ref);
        accessGuard?.(spec);
        await writeTableFile(item, { ...current.file, spec });
        let saved = true;
        try {
            await commitHistory(item, versions.slice(0, keep));
            for (const version of dropped)
                await IOUtils.remove(versionPathOf(item, version), { ignoreAbsent: true });
            try {
                await recordTableShadow(ref, target!, JSON.stringify(spec), await tableSpecHash(spec));
            } catch (error) {
                logger(`tableStore: could not record the trim recovery shadow for ${ref.key}: ${String(error)}`, 2);
            }
        } catch (error) {
            saved = false;
            logger(`tableStore: trim committed but bookkeeping failed: ${String(error)}`, 1);
        }
        if (!(await renderCommitted(ref))) saved = false;
        return {
            ok: true,
            outcome: 'trimmed',
            trimmed_versions: dropped,
            trimmed_to: target,
            retention_exhausted: exhausted,
            saved,
        };
    });
    if (result.outcome !== 'unchanged')
        emitTableUpdated(ref, result.trimmed_to, {
            actor: 'system',
            thread_id: request.thread_id,
            change: 'Trimmed discarded runs',
        });
    return result;
}

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

/**
 * Moves a table to the trash. Deleting outright is not offered: the file is the
 * only copy of the table's state, so the recoverable step is the only safe one.
 */
export async function deleteTableUncoordinated(ref: TableRef): Promise<void> {
    requireWritable(ref);
    await withTableLock(ref, async () => {
        const item = await resolveTableItem(ref, true);
        requireWritable(ref);
        // Trashing returns no document content and must work even when it is corrupt.
        await trashTableItem(item);
        // The shadow lives outside the storage directory, so nothing else would
        // ever collect it: a deleted table's retained specs would sit in the
        // profile for the life of the install.
        await pruneTableShadow(ref);
    });
    emitTableUpdated(ref, null, { actor: 'user', change: 'Moved to trash' });
}

/** Takes a trashed table back out of the trash. */
export async function restoreTableUncoordinated(ref: TableRef): Promise<void> {
    requireWritable(ref);
    await withTableLock(ref, async () => {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(ref.libraryID, ref.key) as
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
    meta: TableWriteMeta,
): void {
    try {
        const detail: TableUpdatedDetail = {
            libraryID: ref.libraryID,
            key: ref.key,
            version,
            actor: meta.actor,
            ...(meta.run_id ? { run_id: meta.run_id } : {}),
        };
        getTablesApi()?.tableChanged(ref);
        Zotero.Beaver?.runtime?.publish(TABLE_UPDATED_EVENT, detail);
    } catch (error) {
        logger(`tableStore: table-updated dispatch failed: ${String(error)}`, 2);
    }
}

// ---------------------------------------------------------------------------
// Publishing the write half
// ---------------------------------------------------------------------------

/** Registers the store callbacks for one renderer and returns its teardown. */
export function registerTableLocalCommands(
    win: Window,
    owner?: string,
    renderer: Pick<TableLocalCommands, 'activateCitation'> = {},
): () => void {
    const commands: TableLocalCommands = {
        ...renderer,
        read: async (ref: TableRef) => Zotero.Beaver.libraryOperations.run('table_openTable', [ref], { owner }),
        history: async (ref: TableRef) => (await Zotero.Beaver.libraryOperations.run('table_openTable', [ref], { owner })).history,
        revert: (ref: TableRef, version: number) => Zotero.Beaver.libraryOperations.run('table_revertTable', [ref, version, { actor: 'user' }], { owner }),
        restoreShadow: (ref: TableRef) => Zotero.Beaver.libraryOperations.run('table_restoreShadowVersion', [ref], { owner }),
    };
    const entries = tableLocalCommands();
    entries.set(win, commands);
    return () => {
        if (entries.get(win) !== commands) return;
        entries.delete(win);
    };
}

/** Publishes the plugin-owned recovery operation for every table surface. */
export function registerTableShadowRestore(): void {
    setTableShadowRestore((ref) => restoreShadowVersion(ref));
}

/** Repair canonical bookkeeping before validating history for provider access. */
async function guardStoredTable(ref: TableRef, item: Zotero.Item, current: CurrentState, guard?: TableAccessGuard): Promise<TableRecovery[]> {
    if (!guard) return [];
    if (checkLibraryExcluded(ref.libraryID)) throw new TableItemError('Table unavailable.', 'library_excluded');
    if (current.spec) guard(current.spec);

    // Check readable sidecar content before any repair, including unlogged files
    // the audit might adopt. Digests are enforced after the canonical tip has had
    // a chance to repair its interrupted write; older damaged history still fails.
    for (const version of await versionFilesOnDisk(item)) {
        if (version > current.version) continue;
        const raw = await readJson<unknown>(versionPathOf(item, version));
        const read = readSpec(raw);
        if (read.ok) guard(read.spec);
    }
    const recovered: TableRecovery[] = [];
    const library = Zotero.Libraries.get(ref.libraryID);
    if (current.spec && tableFilesEditable(library)) {
        guard(current.spec);
        requireWritable(ref);
        const reconciled = await reconcileLog(item, current);
        const audited = await auditSidecar(item, current.spec, current.version, reconciled.versions);
        recovered.push(...reconciled.repairs, ...audited.repairs);
        const repaired = { ...current, history: { ...current.history, versions: audited.versions } };
        for (const entry of audited.versions) {
            guard(await readStoredVersion(ref, item, repaired, entry.version));
        }
        guard(current.spec);
        requireWritable(ref);
        if (recovered.length) {
            const pruned = await commitHistory(item, audited.versions);
            if (pruned.length) recovered.push({ kind: 'pruned', versions: pruned });
            current.history = normalizeTableHistory(await readJson<TableHistory>(historyPathOf(item)));
        }
    }
    for (const entry of current.history.versions) {
        guard(await readStoredVersion(ref, item, current, entry.version));
    }
    return recovered;
}

export function createTable(...args: Parameters<typeof createTableUncoordinated>): ReturnType<typeof createTableUncoordinated> {
    return Zotero.Beaver.libraryOperations.run('table_createTable', args);
}

export function createTableFromRequest(...args: Parameters<typeof createTableFromRequestUncoordinated>): ReturnType<typeof createTableFromRequestUncoordinated> {
    return Zotero.Beaver.libraryOperations.run('table_createTableFromRequest', args);
}

export function applyTableEdit(...args: Parameters<typeof applyTableEditUncoordinated>): ReturnType<typeof applyTableEditUncoordinated> {
    return Zotero.Beaver.libraryOperations.run('table_applyTableEdit', args);
}

export function writeTable(...args: Parameters<typeof writeTableUncoordinated>): ReturnType<typeof writeTableUncoordinated> {
    return Zotero.Beaver.libraryOperations.run('table_writeTable', args);
}

export function editTable(...args: Parameters<typeof editTableUncoordinated>): ReturnType<typeof editTableUncoordinated> {
    return Zotero.Beaver.libraryOperations.run('table_editTable', args);
}

export function editTableSession(...args: Parameters<typeof editTableSessionUncoordinated>): ReturnType<typeof editTableSessionUncoordinated> {
    return Zotero.Beaver.libraryOperations.run('table_editTableSession', args);
}

export function openTable(...args: Parameters<typeof openTableUncoordinated>): ReturnType<typeof openTableUncoordinated> {
    return Zotero.Beaver.libraryOperations.run('table_openTable', args);
}

export function restoreShadowVersion(...args: Parameters<typeof restoreShadowVersionUncoordinated>): ReturnType<typeof restoreShadowVersionUncoordinated> {
    return Zotero.Beaver.libraryOperations.run('table_restoreShadowVersion', args);
}

export function revertTable(...args: Parameters<typeof revertTableUncoordinated>): ReturnType<typeof revertTableUncoordinated> {
    return Zotero.Beaver.libraryOperations.run('table_revertTable', args);
}

export function trimTable(...args: Parameters<typeof trimTableUncoordinated>): ReturnType<typeof trimTableUncoordinated> {
    return Zotero.Beaver.libraryOperations.run('table_trimTable', args);
}

export function deleteTable(...args: Parameters<typeof deleteTableUncoordinated>): ReturnType<typeof deleteTableUncoordinated> {
    return Zotero.Beaver.libraryOperations.run('table_deleteTable', args);
}

export function restoreTable(...args: Parameters<typeof restoreTableUncoordinated>): ReturnType<typeof restoreTableUncoordinated> {
    return Zotero.Beaver.libraryOperations.run('table_restoreTable', args);
}
