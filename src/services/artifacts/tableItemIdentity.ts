/**
 * Recognising and reading a stored table.
 *
 * The half of the stored-table surface that only needs Zotero: the marks that
 * identify one of ours, where its files live, and how to read `table.json`, the
 * file that is the table. Creation and every other write live in `tableItem.ts`,
 * which re-exports everything here so a caller that wants both has one import.
 *
 * **The split is load-bearing, not tidiness.** This module is reachable from
 * `src/hooks.ts`, so it is compiled into the *esbuild* bundle, where React, the
 * Jotai store and `process` do not exist. `tableItem.ts` reaches the library
 * exclusion check, which pulls in `agentDataProvider/utils` and from there the
 * whole `react/` graph — importing it from an esbuild-side module makes the
 * plugin's bundle throw `process is not defined` on load and the plugin does
 * not start. Nothing here may import `react/*` or anything that reaches it;
 * `eslint.config.mjs` enforces that for this whole subsystem.
 *
 * Nothing here is gated on library exclusion, and that is deliberate rather
 * than convenient: exclusion governs writes, indexing and what leaves the
 * machine, not whether the user may look at something already in their
 * library.
 */

import { readSpec, type TableSpec } from '@beaver/agent-core/layouts/table';
import type { TableSummary } from '@beaver/agent-core/layouts/tableMutations';
import { logger } from '@beaver/agent-core/platform/logger';
import { sha256Hex } from '../../utils/hash';
import { getTablesApi } from './tablesApi';

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

/**
 * The tag every stored table carries. Automatic (`addTag(name, 1)`) so it stays
 * out of the user's own tag vocabulary.
 */
export const TABLE_TAG = 'beaver-table';

/**
 * The row swatch. Zotero paints an emoji tag into the items-tree row, which is
 * the only row-level marker a plugin can get — `itemTree._getIcon` picks the
 * icon from the attachment's link mode and takes no plugin input.
 */
export const TABLE_EMOJI_TAG = '📊';

/**
 * Scheme of the item's `url` field. The URL field is required by the import API
 * and is surfaced in the item pane as the "archived from" link; a generated
 * table has no web origin, so a Beaver-owned scheme is used rather than a
 * plausible-looking http URL that would misrepresent the item as a capture of a
 * real page.
 */
export const TABLE_URL_PREFIX = 'beaver://table/';

/** Directory inside the attachment's storage folder for Beaver's own sidecars. */
export const TABLE_SIDECAR_DIR = 'beaver';

/** The file that is the table, beside the rendered snapshot. */
export const TABLE_FILE_NAME = 'table.json';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * One vocabulary for everything that can go wrong with a stored table, shared
 * by creation here and by the store that writes revisions of it: a caller
 * switching on a code must not have to know which module refused it.
 */
export type TableItemErrorCode =
    | 'operation_mismatch'
    | 'operation_pending'
    | 'invalid_request'
    | 'library_excluded'
    | 'no_writable_library'
    /** The library type cannot hold a table. */
    | 'unsupported_library'
    | 'invalid_target'
    | 'import_failed'
    | 'file_missing'
    /** No item with that key in that library. */
    | 'not_found'
    /** The item exists but is not one of ours. */
    | 'not_a_table'
    /** The item carries no readable table. */
    | 'no_spec'
    /** Written by a newer format than this build can read. */
    | 'unsupported_version'
    /** `table.json` is not a readable table. */
    | 'invalid_spec'
    /** `table.json` is gone and the version history cannot rebuild it. */
    | 'corrupt'
    /** The write would grow the table past a limit. */
    | 'too_large'
    /** A stored version's file disagrees with what the version log recorded. */
    | 'version_corrupt';

export class TableItemError extends Error {
    readonly code: TableItemErrorCode;

    constructor(message: string, code: TableItemErrorCode) {
        super(message);
        this.name = 'TableItemError';
        this.code = code;
    }
}

/**
 * Whether a library lets Beaver write a table's files: item edits and file
 * edits, since a table is a stored file. Exclusion is checked separately.
 */
export function tableFilesEditable(library: { editable: boolean; filesEditable?: boolean } | false | null | undefined): boolean {
    return !!library && !!library.editable && library.filesEditable !== false;
}

/**
 * Whether the store's open repair runs for a table in this library: its files
 * are editable and the library is not excluded (fail-closed until the library
 * scope has loaded, as the store's exclusion check is).
 */
export function tableRepairAllowed(libraryID: number): boolean {
    const beaver = Zotero.Beaver;
    return tableFilesEditable(Zotero.Libraries.get(libraryID))
        && !!beaver?.libraryScopeInitialized
        && (beaver.searchableLibraryIds ?? []).includes(libraryID);
}

/** Why a table's bookkeeping stays unrepaired where {@link tableRepairAllowed} is false. */
export const TABLE_REPAIR_SKIPPED =
    'Local bookkeeping needs repair, but Beaver does not modify tables in a read-only library or one excluded from Beaver.';

/** Where an unreadable table can be recovered: the item pane's restore. */
export const UNREADABLE_TABLE_RECOVERY =
    'Select the table in your library and use “Restore my version” in its Beaver Table section to write back the last version this device saved.';

/**
 * The recovery hint for an unreadable table, or '' when the item pane would
 * not offer the restore (no usable copy on this device, or a read-only
 * library). Never throws.
 */
export async function unreadableTableRecovery(ref: TableRef): Promise<string> {
    try {
        const outcome = await getTablesApi()?.shadow.check(ref);
        return outcome === 'ok' ? UNREADABLE_TABLE_RECOVERY : '';
    } catch {
        return '';
    }
}

/** Error constructors differ between the plugin and renderer bundles. */
export function isTableItemError(error: unknown): error is TableItemError {
    return !!error && typeof error === 'object'
        && (error as TableItemError).name === 'TableItemError'
        && typeof (error as TableItemError).code === 'string'
        && typeof (error as TableItemError).message === 'string';
}

// ---------------------------------------------------------------------------
// Recognising one of ours
// ---------------------------------------------------------------------------

/**
 * Slug of a table's `url`, so Zotero derives a readable filename from it:
 * `_getFileNameFromURL` takes the URL's last path segment and appends the
 * extension for the content type, giving `<slug>.html` on disk and in the item
 * pane.
 */
export function buildTableUrl(title: string): string {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/g, '');
    return `${TABLE_URL_PREFIX}${slug || 'table'}`;
}

/**
 * The item's `url` field, or null when it cannot be read.
 *
 * An attachment's URL lives in `itemData`, which Zotero loads lazily, so this
 * returns null rather than throwing on an item whose data has not been loaded —
 * use {@link loadTableItemFields} first when the answer has to be trustworthy.
 */
function tableUrlField(item: Zotero.Item): string | null {
    try {
        return item.getField('url') || null;
    } catch {
        return null;
    }
}

/**
 * Loads the fields {@link isTableItem} reads, for callers holding items that
 * came out of a lazy path (`Zotero.Items.getAsync`, a search).
 */
export async function loadTableItemFields(items: Zotero.Item[]): Promise<void> {
    if (items.length === 0) return;
    await Zotero.Items.loadDataTypes(items, ['itemData', 'tags']);
}

/**
 * Whether this item is a table Beaver stored.
 *
 * This is only a candidate check. The URL and attachment type narrow local
 * discovery; explicit access validates the embedded document and identity.
 * Cosmetic tags are not part of document identity.
 *
 * Synchronous. The tag and the attachment properties are on the item; the URL
 * needs `itemData` loaded — see {@link loadTableItemFields}.
 */
export function isTableItem(item: Zotero.Item | null | undefined): boolean {
    return isTableAttachment(item) && !!item?.hasTag(TABLE_TAG);
}

/** Candidate attachment for explicit addressing; the embedded document is checked on read. */
export function isTableAttachment(item: Zotero.Item | null | undefined): boolean {
    if (!item || !item.isAttachment() || item.attachmentContentType !== 'text/html') return false;
    if (!item.isTopLevelItem()) return false;
    if (item.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_IMPORTED_URL)
        return false;
    if (item.attachmentContentType !== 'text/html') return false;
    return tableUrlField(item)?.startsWith(TABLE_URL_PREFIX) ?? false;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The attachment's storage directory, which holds the rendered `.html` and
 * everything Beaver keeps beside it. Null when the item has no key yet or the
 * storage directory cannot be resolved.
 */
export function tableStorageDirectory(item: Zotero.Item): string | null {
    try {
        return Zotero.Attachments.getStorageDirectory(item).path;
    } catch (error) {
        logger(`tableStorageDirectory: ${String(error)}`, 2);
        return null;
    }
}

/** Beaver's own subdirectory inside the storage directory. */
export function tableSidecarDirectory(item: Zotero.Item): string | null {
    const dir = tableStorageDirectory(item);
    return dir ? PathUtils.join(dir, TABLE_SIDECAR_DIR) : null;
}

/** Where `table.json` lives: the storage directory, beside the snapshot. */
export function tableFilePath(item: Zotero.Item): string | null {
    const dir = tableStorageDirectory(item);
    return dir ? PathUtils.join(dir, TABLE_FILE_NAME) : null;
}

/** Where the edit history goes. */
export function tableHistoryPath(item: Zotero.Item): string | null {
    const dir = tableSidecarDirectory(item);
    return dir ? PathUtils.join(dir, 'history.json') : null;
}

/** Where revision `version` of the spec goes. */
export function tableVersionPath(
    item: Zotero.Item,
    version: number
): string | null {
    const dir = tableSidecarDirectory(item);
    return dir ? PathUtils.join(dir, `v${version}.json`) : null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Durable acknowledgement of a remote write, committed with the table. */
export interface TableOperationReceipt {
    operation_id: string;
    request_sha256: string;
    version: number;
    sha256: string;
}

/** The identity of a retriable creation, committed with the table. */
export interface TableCreationState {
    operation_id: string;
    request_sha256: string;
    complete: boolean;
    meta?: { actor: 'agent' | 'user' | 'system'; run_id?: string; thread_id?: string; change?: string };
}

/**
 * `table.json`: the spec, and the store state that has to commit atomically
 * with it — the receipts that make remote retries idempotent and the creation
 * marker — kept beside the spec so the spec's own bytes, and therefore its
 * hash, never include them.
 */
export interface TableFile {
    spec: TableSpec;
    receipts?: TableOperationReceipt[];
    creation?: TableCreationState;
}

export type ReadTableItemResult =
    | { ok: true; spec: TableSpec; file: TableFile; recovered?: true }
    | {
          ok: false;
          code: 'not_a_table' | 'no_file' | 'no_spec' | 'unsupported_version' | 'invalid' | 'corrupt';
          message: string;
          specVersion?: number;
      };

function isReceipt(value: unknown): value is TableOperationReceipt {
    if (!value || typeof value !== 'object') return false;
    const receipt = value as Partial<TableOperationReceipt>;
    return typeof receipt.operation_id === 'string' &&
        typeof receipt.request_sha256 === 'string' &&
        typeof receipt.version === 'number' &&
        typeof receipt.sha256 === 'string';
}

/** `table.json` text as a validated file for `item`, or why it is not one. */
export function parseTableFile(item: Zotero.Item, text: string): ReadTableItemResult {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        return { ok: false, code: 'invalid', message: `Table ${item.key} is not readable JSON: ${String(error)}` };
    }
    return tableFileFrom(item, raw);
}

/** A parsed `table.json` value as a validated file for `item`, or why it is not one. */
function tableFileFrom(item: Zotero.Item, raw: unknown): ReadTableItemResult {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, code: 'invalid', message: `Table ${item.key} is not a table file.` };
    }
    const ledger = ledgerFrom(item, raw);
    if ('error' in ledger) return { ok: false, code: 'invalid', message: ledger.error };
    const read = specFor(item, (raw as Partial<TableFile>).spec);
    if (!read.ok) return read;
    return { ok: true, spec: read.spec, file: { spec: read.spec, ...ledger } };
}

/** A parsed `table.json` value's receipts and creation marker, checked apart from its spec. */
function ledgerFrom(item: Zotero.Item, raw: object): TableLedger | { error: string } {
    const file = raw as Partial<TableFile>;
    if (file.receipts !== undefined && (!Array.isArray(file.receipts) || !file.receipts.every(isReceipt))) {
        return { error: `Table ${item.key} has unreadable operation receipts.` };
    }
    if (file.creation !== undefined && (
        !file.creation || typeof file.creation !== 'object' ||
        typeof file.creation.operation_id !== 'string' ||
        typeof file.creation.request_sha256 !== 'string' ||
        typeof file.creation.complete !== 'boolean'
    )) {
        return { error: `Table ${item.key} has an unreadable creation marker.` };
    }
    return {
        ...(file.receipts ? { receipts: file.receipts } : {}),
        ...(file.creation ? { creation: file.creation } : {}),
    };
}

/**
 * The receipts and creation marker `table.json` holds, read even when its spec
 * is not: they are what answers operation retries. Null when the file is
 * missing, unparseable, or its ledger itself is unreadable.
 */
export async function readTableFileLedger(item: Zotero.Item): Promise<TableLedger | null> {
    const path = tableFilePath(item);
    if (!path) return null;
    try {
        if (!(await IOUtils.exists(path))) return null;
        const raw: unknown = JSON.parse(await IOUtils.readUTF8(path));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const ledger = ledgerFrom(item, raw);
        return 'error' in ledger ? null : ledger;
    } catch {
        return null;
    }
}

/** A spec that is readable and says it is this item's. */
function specFor(item: Zotero.Item, raw: unknown): ReadTableItemResult {
    const read = readSpec(raw);
    if (!read.ok) {
        return read.reason === 'unsupported_version'
            ? {
                  ok: false,
                  code: 'unsupported_version',
                  specVersion: read.specVersion,
                  message: `Table ${item.key} was written by a newer format (spec_version ${read.specVersion}).`,
              }
            : { ok: false, code: 'invalid', message: read.detail };
    }
    if (read.spec.key !== item.key || !Number.isInteger(read.spec.version) || (read.spec.version ?? 0) < 1)
        return { ok: false, code: 'invalid', message: 'The table identity does not match its attachment.' };
    return { ok: true, spec: read.spec, file: { spec: read.spec } };
}

/**
 * The spec a missing `table.json` is rebuilt from: the version file of the
 * history's tip, when its bytes still hash to what the history recorded.
 * Nothing is written here; the store rewrites the file under its lock.
 */
export async function recoverTableFromHistory(item: Zotero.Item): Promise<ReadTableItemResult> {
    const corrupt: ReadTableItemResult = {
        ok: false,
        code: 'corrupt',
        message: `Table ${item.key} has no table.json and its history cannot restore it.`,
    };
    const history = await readTableHistory(item);
    const tip = history.versions[history.versions.length - 1];
    const path = tip ? tableVersionPath(item, tip.version) : null;
    if (!tip || !path) return corrupt;
    let text: string;
    try {
        if (!(await IOUtils.exists(path))) return corrupt;
        text = await IOUtils.readUTF8(path);
    } catch {
        return corrupt;
    }
    if ((await sha256Hex(text)) !== tip.sha256) return corrupt;
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return corrupt;
    }
    // The ledger is restored with the spec; an unreadable one fails like the spec.
    const read = tableFileFrom(item, { ...history.ledger, spec: raw });
    if (!read.ok || read.spec.version !== tip.version) return corrupt;
    return { ...read, recovered: true };
}

/**
 * The stored table: `table.json`, or the history's tip when that file is gone.
 *
 * Reading is deliberately not gated on library exclusion: an existing table the
 * user opens is theirs to look at, and exclusion governs what leaves the
 * machine, not what the user can see.
 */
export async function readTableItemSpec(item: Zotero.Item): Promise<ReadTableItemResult> {
    await loadTableItemFields([item]);
    if (!isTableAttachment(item)) {
        return { ok: false, code: 'not_a_table', message: `Item ${item.key} is not a Beaver table.` };
    }
    const path = tableFilePath(item);
    if (!path) {
        return { ok: false, code: 'no_file', message: `Table ${item.key} has no storage directory.` };
    }
    let text: string;
    try {
        if (!(await IOUtils.exists(path))) return missingTableFile(item);
        text = await IOUtils.readUTF8(path);
    } catch (error) {
        return { ok: false, code: 'no_file', message: `Table ${item.key} could not be read: ${String(error)}` };
    }
    return parseTableFile(item, text);
}

/**
 * Why `table.json` is absent: a table whose files have not arrived on this
 * device yet (`no_file`), a snapshot that carries no table (`no_spec`), or a
 * table whose history can rebuild it, or cannot (`corrupt`).
 */
async function missingTableFile(item: Zotero.Item): Promise<ReadTableItemResult> {
    if ((await readTableHistory(item)).versions.length) return recoverTableFromHistory(item);
    const snapshot = await item.getFilePathAsync();
    if (snapshot && (await IOUtils.exists(snapshot))) {
        return { ok: false, code: 'no_spec', message: `Table ${item.key} carries no table.` };
    }
    return { ok: false, code: 'no_file', message: `Table ${item.key} has no file on disk.` };
}

// ---------------------------------------------------------------------------
// The version log
// ---------------------------------------------------------------------------

/**
 * Who asked for a write. `tableStore.ts` owns what each value means for
 * collapsing; the shape lives here because readers on the esbuild side — the
 * item-pane section — need to name it without reaching the store.
 */
export type TableActor = 'user' | 'agent' | 'system';

/** One entry in the version log. */
export interface TableVersionEntry {
    version: number;
    actor: TableActor;
    run_id?: string;
    thread_id?: string;
    change?: string;
    /** ISO timestamp of the write. */
    at: string;
    /**
     * SHA-256 of the serialised spec exactly as it was written to
     * `beaver/v<N>.json`. Not a security claim: it is how a later read notices
     * that a file changed behind our back (a sync conflict resolved by copying,
     * a hand-edited sidecar, a write interrupted mid-sequence) rather than
     * silently trusting it. The store verifies it when opening a table and
     * refuses to revert to a version that fails it.
     */
    sha256: string;
    /** Size of that file in bytes, for the byte-bounded retention. */
    bytes?: number;
    /** `summarize()` of that spec, so listing tables never reads one. */
    summary: TableSummary;
    /**
     * This version may never be overwritten in place — see the collapse rule on
     * `writeTable`. Set on the version a table was created in, and on any
     * version reconstructed from the file rather than written by a known author.
     */
    sealed?: true;
    /** Known creation, unlike a sealed entry reconstructed from lost history. */
    creation?: true;
}

/** The retry ledger `table.json` carries beside its spec. */
export type TableLedger = Omit<TableFile, 'spec'>;

export interface TableHistory {
    /** The highest version the log knows about. 0 when there is none. */
    tip: number;
    /** Oldest first, capped by the store's retention limit. */
    versions: TableVersionEntry[];
    /**
     * A copy of `table.json`'s receipts and creation marker as of the tip, so
     * a `table.json` rebuilt from the tip still answers operation retries.
     */
    ledger?: TableLedger;
}

/** A table with no log at all — a fresh item, or one whose sidecar is gone. */
export const EMPTY_TABLE_HISTORY: TableHistory = { tip: 0, versions: [] };

/** Defends every reader against a hand-edited or truncated `history.json`. */
export function normalizeTableHistory(
    history: TableHistory | null | undefined
): TableHistory {
    const versions = Array.isArray(history?.versions)
        ? history.versions
              .filter((entry) => typeof entry?.version === 'number')
              .sort((a, b) => a.version - b.version)
        : [];
    const tip = versions.length ? versions[versions.length - 1].version : 0;
    const ledger = history?.ledger && typeof history.ledger === 'object' ? history.ledger : undefined;
    return { tip: Math.max(tip, Number(history?.tip) || 0), versions, ...(ledger ? { ledger } : {}) };
}

/**
 * The version log as stored, normalized.
 *
 * Read-only and lock-free on purpose: this is what a display surface calls to
 * learn a table's version and coverage without reading (and parsing) the whole
 * document. Every write to the log still goes through `tableStore.ts`. An
 * absent or damaged log reads as an empty one — the document is the state, and
 * the store rebuilds the log from it on the next open.
 */
export async function readTableHistory(
    item: Zotero.Item
): Promise<TableHistory> {
    const path = tableHistoryPath(item);
    if (!path) return EMPTY_TABLE_HISTORY;
    try {
        if (!(await IOUtils.exists(path))) return EMPTY_TABLE_HISTORY;
        const text = await IOUtils.readUTF8(path);
        return normalizeTableHistory(JSON.parse(text) as TableHistory);
    } catch (error) {
        logger(`readTableHistory: unusable log for ${item.key}: ${String(error)}`, 2);
        return EMPTY_TABLE_HISTORY;
    }
}

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/**
 * A stored table, by the item that holds it.
 *
 * Declared here rather than in the store because the esbuild side addresses
 * tables too — `src/ui/openTable.ts` and the item-pane section both take one —
 * and `tableStore.ts` cannot be reached from that bundle. `tableStore.ts`
 * re-exports it, so nothing that already imports it from there has to change.
 */
export interface TableRef {
    libraryID: number;
    key: string;
}

/**
 * The item behind a ref, or a typed refusal.
 *
 * Reading is never gated on library exclusion — an existing table is the user's
 * to look at. The store's `requireWritable` is where the exclusion boundary is.
 */
export async function resolveTableItem(ref: TableRef, allowTrashed = false): Promise<Zotero.Item> {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(ref.libraryID, ref.key) as
        | Zotero.Item
        | false;
    if (!item || (item.deleted && !allowTrashed)) {
        throw new TableItemError(
            item ? `Table ${ref.key} is in the trash.` : `No item ${ref.key} in library ${ref.libraryID}.`,
            'not_found'
        );
    }
    await loadTableItemFields([item]);
    if (!isTableAttachment(item)) {
        throw new TableItemError(
            `Item ${ref.key} is not a Beaver table.`,
            'not_a_table'
        );
    }
    return item;
}

/** Maps a read refusal onto the shared {@link TableItemErrorCode} vocabulary. */
export function tableReadError(
    code: 'not_a_table' | 'no_file' | 'no_spec' | 'unsupported_version' | 'invalid' | 'corrupt',
    message: string
): TableItemError {
    switch (code) {
        case 'no_file':
            return new TableItemError(message, 'file_missing');
        case 'invalid':
            return new TableItemError(message, 'invalid_spec');
        default:
            return new TableItemError(message, code);
    }
}

/**
 * The stored spec and the version it claims — the store's read API.
 *
 * Lives on this side of the split so that the esbuild bundle can read a table
 * without reaching `tableStore.ts`, which imports the library-exclusion check
 * and through it the whole React graph. `tableStore.ts` re-exports it, so
 * "read a table through the store" stays one function with one implementation.
 */
export async function readTable(
    ref: TableRef
): Promise<{ spec: TableSpec; version: number }> {
    const item = await resolveTableItem(ref);
    const read = await readTableItemSpec(item);
    if (!read.ok) throw tableReadError(read.code, read.message);
    return { spec: read.spec, version: read.spec.version ?? 0 };
}
