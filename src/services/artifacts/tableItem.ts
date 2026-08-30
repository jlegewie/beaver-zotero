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
 * **Creation only, and only from the webpack side.** Recognition, the storage
 * paths and reading live in `tableItemIdentity.ts` and are re-exported below.
 * The split is not tidiness: this module imports the library-exclusion check,
 * which reaches `react/store` and the profile atoms, so anything the esbuild
 * bundle can reach must import that module instead — see its header for what
 * this one costs there. This module never touches the bare `addon` global
 * either, since the dev handlers under `react/` call it.
 *
 * Versioning, edit history and the write lock are not here either:
 * `tableStore.ts` owns every write to a table file and is the only caller of
 * {@link createTableItem}. The one concession to that split is the sidecar path
 * helpers next door, which name the files the store writes so the two cannot
 * disagree about where they live.
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
    type TableHtmlOptions,
} from './tableDocument';
// Only Zotero knows whether a library id is the user library or a group, so the
// row action links are built there. Imported rather than reimplemented: the
// stored document, the tab rendering and the reader must offer the same links.
import { zoteroLinksFor } from './view/tableLinks';
import {
    buildTableUrl,
    isTableItem,
    loadTableItemFields,
    tableStorageDirectory,
    TableItemError,
    TABLE_TAG,
    TABLE_EMOJI_TAG,
} from './tableItemIdentity';

// Recognition, paths and reading live next door and are re-exported here, so a
// caller that wants both halves still has one import. Anything compiled into
// the esbuild bundle must import `./tableItemIdentity` **directly** — see that
// module's header for what pulling this one into that bundle costs.
export {
    buildTableUrl,
    isTableItem,
    loadTableItemFields,
    normalizeTableHistory,
    readTable,
    readTableHistory,
    readTableItemSpec,
    resolveTableItem,
    tableHistoryPath,
    tableReadError,
    tableSidecarDirectory,
    tableStorageDirectory,
    tableVersionPath,
    EMPTY_TABLE_HISTORY,
    TableItemError,
    TABLE_EMOJI_TAG,
    TABLE_SIDECAR_DIR,
    TABLE_TAG,
    TABLE_URL_PREFIX,
} from './tableItemIdentity';
export type {
    ReadTableItemResult,
    TableActor,
    TableHistory,
    TableItemErrorCode,
    TableRef,
    TableVersionEntry,
} from './tableItemIdentity';

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
