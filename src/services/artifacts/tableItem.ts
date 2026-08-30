/**
 * A stored table, as a Zotero library item.
 *
 * A table is a snapshot attachment and nothing else: no database row, no server
 * copy. `Zotero.Attachments.importFromSnapshotContent` — the same path the
 * connector uses for single-file page captures — gives us a `text/html` file
 * attachment that opens in the reader, is full-text indexed, can be annotated
 * and syncs like any other stored file. The document it holds is
 * {@link buildTableDocument}'s, which embeds the `TableSpec` it was rendered
 * from, so the file is both the table anyone can read and the only copy of the
 * table's state.
 *
 * This module lives in the esbuild bundle but is imported by the webpack one
 * (the dev handlers under `react/` call it), so it never touches the bare
 * `addon` global.
 *
 * Versioning, edit history and the write lock are not here: this is creation,
 * recognition and reading — `tableStore.ts` owns every write to a table file
 * and is the only caller of {@link createTableItem}. The one concession to that
 * split is the sidecar path helpers below, which name the files the store
 * writes so the two cannot disagree about where they live.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    TABLE_SPEC_VERSION,
    type TableSpec,
} from '@beaver/agent-core/layouts/table';
import { getZoteroSelectURI } from '../../utils/zoteroUtils';
import { safeAttachmentFilename } from '../../utils/attachmentFiles';
import { getPref } from '../../utils/prefs';
import { checkLibraryExcluded } from '../agentDataProvider/utils';
import { CSS_RULE_BUDGET } from '../../utils/html';
import {
    buildTableDocument,
    parseTableDocument,
    type TableHtmlOptions,
} from './tableDocument';
// Only Zotero knows whether a library id is the user library or a group, so the
// row action links are built there. Imported rather than reimplemented: the
// stored document and the tab rendering must offer the same links.
import { zoteroLinksFor } from '../../ui/tableTab';

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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * One vocabulary for everything that can go wrong with a stored table, shared
 * by creation here and by the store that writes revisions of it: a caller
 * switching on a code must not have to know which module refused it.
 */
export type TableItemErrorCode =
    | 'library_excluded'
    | 'no_writable_library'
    /** The library is writable, but the import API cannot file a table there. */
    | 'unsupported_library'
    | 'invalid_target'
    | 'import_failed'
    | 'file_missing'
    /** No item with that key in that library. */
    | 'not_found'
    /** The item exists but is not one of ours. */
    | 'not_a_table'
    /** The file is there but carries no embedded spec. */
    | 'no_spec'
    /** Written by a newer format than this build can read. */
    | 'unsupported_version'
    /** The embedded spec is not a readable table. */
    | 'invalid_spec'
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

// ---------------------------------------------------------------------------
// Home library
// ---------------------------------------------------------------------------

export type ResolvedTableLibrary =
    | { libraryID: number }
    | { error: 'no_writable_library' | 'library_excluded' };

/**
 * Preference holding the library new tables are filed in. Unset (or 0) means
 * "no preference"; see {@link resolveTableLibrary}.
 */
const DEFAULT_LIBRARY_PREF = 'tables.defaultLibraryID';

function preferredLibraryID(): number | null {
    try {
        const value = getPref(DEFAULT_LIBRARY_PREF);
        return typeof value === 'number' && value > 0 ? value : null;
    } catch {
        return null;
    }
}

/**
 * Whether one candidate library can hold a table.
 *
 * Order matters: existence first, because `checkLibraryExcluded` answers `null`
 * for a library that does not exist so a bad reference is never mislabeled
 * "excluded".
 */
function checkTableLibrary(libraryID: number): ResolvedTableLibrary {
    const library = Zotero.Libraries.get(libraryID);
    if (!library) return { error: 'no_writable_library' };
    if (!library.editable) return { error: 'no_writable_library' };
    if (checkLibraryExcluded(libraryID)) return { error: 'library_excluded' };
    return { libraryID };
}

/**
 * The library a new table is filed in: an explicit choice, else the configured
 * default, else the user library.
 *
 * Creating a table is a **write**, so this is the access-control boundary
 * CLAUDE.md describes: a library the user excluded in Beaver preferences is
 * never chosen, and neither is a group library they cannot write to. Reading or
 * opening a table that already exists is deliberately *not* gated this way — a
 * thread that references an excluded library keeps working, and the user may
 * still reveal and open what is already in their library.
 *
 * An explicit id is answered as given: a caller that names a library gets that
 * library or an error, never a silent substitution. The default preference is a
 * *preference*, so an unusable one falls through to the user library rather
 * than failing the whole request.
 */
export function resolveTableLibrary(explicit?: number): ResolvedTableLibrary {
    if (explicit != null) return checkTableLibrary(explicit);

    let sawExcluded = false;
    const candidates = [preferredLibraryID(), Zotero.Libraries.userLibraryID];
    for (const candidate of candidates) {
        if (candidate == null) continue;
        const checked = checkTableLibrary(candidate);
        if ('libraryID' in checked) return checked;
        if (checked.error === 'library_excluded') sawExcluded = true;
    }
    // Excluded is the more actionable of the two refusals: it names something
    // the user can change in Beaver preferences.
    return { error: sawExcluded ? 'library_excluded' : 'no_writable_library' };
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
 * Both available marks are required, because neither is reliable alone: the
 * `beaver-table` tag is user-editable (anyone can add it to an unrelated item,
 * or remove it from one of ours), while the `url` field is not surfaced for
 * editing but is trivially shared by any snapshot the user happens to have
 * imported from a `beaver://` URL. Together they identify the item as ours
 * without a database of our own.
 *
 * Synchronous. The tag and the attachment properties are on the item; the URL
 * needs `itemData` loaded — see {@link loadTableItemFields}.
 */
export function isTableItem(item: Zotero.Item | null | undefined): boolean {
    if (!item || !item.isAttachment() || !item.isTopLevelItem()) return false;
    if (item.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_IMPORTED_URL)
        return false;
    if (item.attachmentContentType !== 'text/html') return false;
    if (!item.hasTag(TABLE_TAG)) return false;
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
// Creation
// ---------------------------------------------------------------------------

export interface CreateTableItemOptions {
    spec: TableSpec;
    /** Where to file it. Resolved by {@link resolveTableLibrary} when absent. */
    libraryID?: number;
    /** File the table as a top-level item in this collection. */
    collectionID?: number | null;
    /** Attachment title. Defaults to the spec's title. */
    title?: string;
    /** Row action links. Defaults to Zotero's own `zotero://` URIs. */
    linksFor?: TableHtmlOptions['linksFor'];
}

export interface CreatedTableItem {
    item: Zotero.Item;
    itemID: number;
    /** The Zotero item key — which is also the table's identity, see below. */
    key: string;
    libraryID: number;
    title: string;
    filename: string | null;
    storageDirectory: string | null;
    byteLength: number;
    cssRuleCount: number;
    /** The spec as stored: `key` and `version` stamped in. */
    spec: TableSpec;
    /** Reveals the table in the library pane. */
    selectUri: string | null;
    /** Opens the table in the reader. */
    openUri: string | null;
}

/** Builds the `zotero://open` URI for a file attachment. */
function getZoteroOpenURI(libraryID: number, key: string): string | null {
    const library = Zotero.Libraries.get(libraryID);
    if (!library) return null;
    // @ts-ignore groupID is defined for group libraries
    const segment = library.libraryType === 'group' ? `groups/${library.groupID}` : 'library';
    return `zotero://open/${segment}/items/${key}`;
}

/**
 * Creates the library item for a table.
 *
 * **The item-layer primitive, not the entry point.** This imports the
 * attachment and writes the document; it knows nothing about versions, so a
 * table created through it directly has a version 1 with no log entry and no
 * `beaver/v1.json` — a state nobody can revert to. `tableStore.createTable` is
 * its only caller and seeds that; go through the store.
 *
 * ## Two writes, on purpose
 *
 * `TableSpec.key` holds the **Zotero item key** of this attachment: there is no
 * separate artifact id, so a table's identity is the identity of the item that
 * holds it. That creates an ordering problem — the key does not exist until the
 * item does — which is why the file is written twice:
 *
 * 1. Import the document rendered from the caller's spec. Zotero assigns the
 *    key here, and not before.
 * 2. Stamp `key` (and `version: 1`) into the spec and re-render, so the stored
 *    file is self-identifying: anything that later reads it — a reopen, an
 *    export, another device — learns which table it is from the file alone,
 *    without being told by whoever handed it over.
 *
 * The second write must go back through {@link buildTableDocument} rather than
 * patching the embedded JSON in the HTML. The document is a pure function of
 * the spec, and keeping it that way is what makes the round trip
 * (`buildTableDocument` → `parseTableDocument`) exact; a hand-patched file would
 * carry a spec the renderer never rendered.
 */
export async function createTableItem(
    options: CreateTableItemOptions
): Promise<CreatedTableItem> {
    const { spec, collectionID } = options;

    const resolved = resolveTableLibrary(options.libraryID);
    if ('error' in resolved) {
        throw new TableItemError(
            resolved.error === 'library_excluded'
                ? 'That library is excluded in Beaver preferences, so Beaver will not write to it.'
                : 'No writable library is available for a new table.',
            resolved.error
        );
    }
    const libraryID = resolved.libraryID;

    // `Zotero.Attachments.importFromSnapshotContent` has no `libraryID` option:
    // its `_addToDB` takes the library from the *parent item*, and a top-level
    // attachment therefore always lands in the user library (`setCollections`
    // assigns `Zotero.Libraries.userLibraryID` before it resolves anything).
    // Passing a group collection would file a user-library item against a group
    // collection, so a writable group library is refused here rather than
    // misfiled. Filing tables in a group needs the item built by hand — a
    // separate decision, not something to fake through this API.
    if (libraryID !== Zotero.Libraries.userLibraryID) {
        throw new TableItemError(
            'Beaver can currently only create tables in your personal library.',
            'unsupported_library'
        );
    }

    if (collectionID) {
        const collection = Zotero.Collections.get(collectionID) as
            | Zotero.Collection
            | false;
        if (!collection || collection.libraryID !== libraryID) {
            throw new TableItemError(
                `Collection ${collectionID} is not in library ${libraryID}.`,
                'invalid_target'
            );
        }
    }

    // One name, not two. The item's title, the document's <title> and the
    // spec's own title are the same string, so renaming the table anywhere
    // cannot leave the library row disagreeing with what the table says it is.
    const title = options.title || spec.title || 'Table';
    const named: TableSpec = spec.title === title ? spec : { ...spec, title };
    const linksFor = options.linksFor ?? zoteroLinksFor;

    const first = buildTableDocument(named, { linksFor });
    if (first.cssRuleCount > CSS_RULE_BUDGET) {
        // Above the reader's threshold the snapshot loses its palette in dark mode.
        logger(
            `createTableItem: stylesheet has ${first.cssRuleCount} top-level rules, over the ${CSS_RULE_BUDGET} budget`,
            2
        );
    }

    // Re-checked immediately before the write: exclusion may have changed while
    // the document was being rendered.
    const excludedNow = checkLibraryExcluded(libraryID);
    if (excludedNow) {
        throw new TableItemError(excludedNow.message, 'library_excluded');
    }

    const importOptions: Record<string, unknown> = {
        url: buildTableUrl(title),
        snapshotContent: first.html,
        title,
    };
    if (collectionID) importOptions.collections = [collectionID];

    const item = await Zotero.Attachments.importFromSnapshotContent(importOptions);
    if (!item?.key) {
        throw new TableItemError(
            'Zotero returned no attachment for the table snapshot.',
            'import_failed'
        );
    }

    // --- phase 2: the file learns which table it is
    const stored: TableSpec = {
        ...named,
        spec_version: named.spec_version ?? TABLE_SPEC_VERSION,
        key: item.key,
        // A fresh item is revision 1 whatever the incoming spec claimed; a spec
        // copied from an existing table starts its own history here.
        version: 1,
    };
    const second = buildTableDocument(stored, { linksFor });

    const path = await item.getFilePathAsync();
    if (!path) {
        throw new TableItemError(
            `Table ${item.key} has no file on disk.`,
            'file_missing'
        );
    }
    await Zotero.File.putContentsAsync(path, second.html);

    item.addTag(TABLE_TAG, 1);
    item.addTag(TABLE_EMOJI_TAG, 1);

    // The index was queued against the first write; the file has changed since.
    await queueTableFullText(item);
    // Load-bearing, not bookkeeping: Zotero schedules its auto-sync off data
    // object saves, not off file writes. Without a save a new or changed table
    // sits unsynced until some unrelated change triggers the next sync.
    await item.saveTx();

    return {
        item,
        itemID: item.id,
        key: item.key,
        libraryID: item.libraryID,
        title,
        filename: safeAttachmentFilename(item),
        storageDirectory: tableStorageDirectory(item),
        byteLength: new TextEncoder().encode(second.html).length,
        cssRuleCount: second.cssRuleCount,
        spec: stored,
        selectUri: getZoteroSelectURI(item.libraryID, item.key),
        openUri: getZoteroOpenURI(item.libraryID, item.key),
    };
}

/** Full-text indexing is best-effort: a failure must not lose the table. */
export async function queueTableFullText(item: Zotero.Item): Promise<void> {
    try {
        await (
            Zotero as unknown as {
                FullText?: { queueItem?: (item: Zotero.Item) => Promise<void> };
            }
        ).FullText?.queueItem?.(item);
    } catch (error) {
        logger(`queueTableFullText: ${String(error)}`, 2);
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ReadTableItemResult =
    | { ok: true; spec: TableSpec }
    | {
          ok: false;
          code: 'not_a_table' | 'no_file' | 'no_spec' | 'unsupported_version' | 'invalid';
          message: string;
          specVersion?: number;
      };

/**
 * The spec stored in a table item's file.
 *
 * Reading is deliberately not gated on library exclusion: an existing table the
 * user opens is theirs to look at, and exclusion governs what leaves the
 * machine, not what the user can see.
 */
export async function readTableItemSpec(
    item: Zotero.Item
): Promise<ReadTableItemResult> {
    await loadTableItemFields([item]);
    if (!isTableItem(item)) {
        return {
            ok: false,
            code: 'not_a_table',
            message: `Item ${item.key} is not a Beaver table.`,
        };
    }

    const path = await item.getFilePathAsync();
    if (!path) {
        return {
            ok: false,
            code: 'no_file',
            message: `Table ${item.key} has no file on disk.`,
        };
    }

    let html: string;
    try {
        html = (await Zotero.File.getContentsAsync(path)) as string;
    } catch (error) {
        return {
            ok: false,
            code: 'no_file',
            message: `Table ${item.key} could not be read: ${String(error)}`,
        };
    }

    const parsed = parseTableDocument(html);
    if (parsed.ok) return { ok: true, spec: parsed.spec };
    if (parsed.reason === 'unsupported_version') {
        return {
            ok: false,
            code: 'unsupported_version',
            specVersion: parsed.specVersion,
            message: `Table ${item.key} was written by a newer format (spec_version ${parsed.specVersion}).`,
        };
    }
    if (parsed.reason === 'no_spec') {
        return {
            ok: false,
            code: 'no_spec',
            message: `Table ${item.key} carries no embedded spec.`,
        };
    }
    return {
        ok: false,
        code: 'invalid',
        message: parsed.detail ?? `Table ${item.key} has an unreadable spec.`,
    };
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

/**
 * Moves a table to the trash. Deleting outright is not offered: the table is
 * the only copy of its state, so the recoverable step is the only safe one.
 */
export async function trashTableItem(item: Zotero.Item): Promise<void> {
    item.deleted = true;
    await item.saveTx();
}

export async function restoreTableItem(item: Zotero.Item): Promise<void> {
    item.deleted = false;
    await item.saveTx();
}
