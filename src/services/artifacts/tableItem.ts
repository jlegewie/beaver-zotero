/**
 * A stored table, as a Zotero library item.
 *
 * A table is a snapshot attachment and nothing else: no database row, no server
 * copy. Zotero’s snapshot attachment APIs give us a `text/html` file
 * attachment that opens in the reader, is full-text indexed, can be annotated
 * and syncs like any other stored file — and syncs its whole storage
 * directory, which is where `table.json`, the table itself, lives beside the
 * rendered snapshot.
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

import { tableSpecHash } from './recoveryShadow';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    TABLE_SPEC_VERSION,
    type TableSpec,
} from '@beaver/agent-core/layouts/table';
import { getZoteroOpenURI, getZoteroSelectURI } from '../../utils/zoteroUtils';
import { safeAttachmentFilename } from '../../utils/attachmentFiles';
import { getPref } from '../../utils/prefs';
import { checkLibraryExcluded } from '../agentDataProvider/utils';
import { CSS_RULE_BUDGET, countTopLevelCssRules } from '../../utils/html';
import { buildTableDocument, type TableHtmlOptions } from './tableDocument';
// Only Zotero knows whether a library id is the user library or a group, so the
// row action links are built there. Imported rather than reimplemented: the
// stored document, the tab rendering and the reader must offer the same links.
import { zoteroLinkScope, zoteroLinksFor } from './view/tableLinks';
import {
    buildTableUrl,
    isTableItem,
    loadTableItemFields,
    tableFilePath,
    tableFilesEditable,
    tableStorageDirectory,
    TableItemError,
    TABLE_TAG,
    TABLE_EMOJI_TAG,
    type TableCreationState,
    type TableFile,
} from './tableItemIdentity';

// Recognition, paths and reading live next door and are re-exported here, so a
// caller that wants both halves still has one import. Anything compiled into
// the esbuild bundle must import `./tableItemIdentity` **directly** — see that
// module's header for what pulling this one into that bundle costs.
export {
    buildTableUrl,
    isTableItem,
    isTableAttachment,
    loadTableItemFields,
    normalizeTableHistory,
    readTable,
    readTableHistory,
    readTableItemSpec,
    readTableFileLedger,
    parseTableFile,
    recoverTableFromHistory,
    resolveTableItem,
    tableFilePath,
    tableHistoryPath,
    tableReadError,
    tableSidecarDirectory,
    tableStorageDirectory,
    tableVersionPath,
    EMPTY_TABLE_HISTORY,
    TableItemError,
    TABLE_EMOJI_TAG,
    TABLE_FILE_NAME,
    TABLE_SIDECAR_DIR,
    TABLE_TAG,
    TABLE_URL_PREFIX,
} from './tableItemIdentity';

/**
 * The format version a spec is stored under: always this build's. A spec that
 * names another version is refused rather than restamped, since its fields
 * would be read with this format's assumptions. A spec that names none was
 * built in this process and is stamped with the current one.
 */
export function storedSpecVersion(spec: Pick<TableSpec, 'spec_version'>): number {
    if (spec.spec_version !== undefined && spec.spec_version !== TABLE_SPEC_VERSION) {
        throw new TableItemError(
            `This build stores tables in format ${TABLE_SPEC_VERSION}, not ${String(spec.spec_version)}.`,
            'unsupported_version'
        );
    }
    return TABLE_SPEC_VERSION;
}
export type {
    ReadTableItemResult,
    TableCreationState,
    TableFile,
    TableOperationReceipt,
    TableActor,
    TableHistory,
    TableItemErrorCode,
    TableLedger,
    TableRef,
    TableVersionEntry,
} from './tableItemIdentity';

// ---------------------------------------------------------------------------
// Home library
// ---------------------------------------------------------------------------

export type ResolvedTableLibrary =
    | { libraryID: number }
    | { error: 'no_writable_library' | 'library_excluded' | 'unsupported_library' };

/**
 * Preference holding the library new tables are filed in. Unset (or 0) means
 * "no preference"; see {@link resolveTableLibrary}.
 *
 * An unavailable, excluded or read-only default falls back to the user library.
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
 * Exclusions are checked before permissions. Personal and group libraries must
 * permit both item and stored-file edits; other library types are unsupported.
 */
function checkTableLibrary(libraryID: number): ResolvedTableLibrary {
    const library = Zotero.Libraries.get(libraryID);
    if (!library) return { error: 'no_writable_library' };
    if (checkLibraryExcluded(libraryID)) return { error: 'library_excluded' };
    if (libraryID !== Zotero.Libraries.userLibraryID &&
        library.libraryType !== 'group')
        return { error: 'unsupported_library' };
    if (!tableFilesEditable(library))
        return { error: 'no_writable_library' };
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
    // Excluded is the most actionable of the refusals: it names something the
    // user can change in Beaver preferences.
    return { error: sawExcluded ? 'library_excluded' : 'no_writable_library' };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/** What a caller is told when {@link resolveTableLibrary} refuses. */
const TABLE_LIBRARY_REFUSALS: Record<
    Extract<ResolvedTableLibrary, { error: string }>['error'],
    string
> = {
    library_excluded:
        'That library is excluded in Beaver preferences, so Beaver will not write to it.',
    unsupported_library:
        'Tables require a personal or group library.',
    no_writable_library: 'Tables require permission to edit both items and files in the library.',
};

export interface CreateTableItemOptions {
    spec: TableSpec;
    /** Provider source-library checks repeated at each content write. */
    accessGuard?: (spec: TableSpec) => void;
    /** Store-owned identity for a retriable import. */
    creationOperation?: {
        operation_id: string;
        request_sha256: string;
        url: string;
        meta: TableCreationState['meta'];
    };
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
    saved?: boolean;
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

/**
 * Creates the library item for a table.
 *
 * **The item-layer primitive, not the entry point.** This imports the
 * attachment and writes `table.json`; it knows nothing about versions, so a
 * table created through it directly has a version 1 with no log entry and no
 * `beaver/v1.json` — a state nobody can revert to. `tableStore.createTable` is
 * its only caller and seeds that; go through the store.
 *
 * ## Two steps, on purpose
 *
 * `TableSpec.key` holds the **Zotero item key** of this attachment: there is no
 * separate artifact id, so a table's identity is the identity of the item that
 * holds it. The key does not exist until the item does, so:
 *
 * 1. Import a snapshot rendered from the caller's spec. Zotero assigns the key
 *    here, and not before.
 * 2. Stamp `key` (and `version: 1`) into the spec and write `table.json`. That
 *    write is the commit point of the creation; the store's renderer then
 *    replaces the imported snapshot with one rendered from the stamped spec.
 */
export async function createTableItem(
    options: CreateTableItemOptions
): Promise<CreatedTableItem> {
    const { spec, collectionID } = options;
    // Before anything is imported: a refused spec must leave no item behind.
    const specVersion = storedSpecVersion(spec);

    const resolved = resolveTableLibrary(options.libraryID);
    if ('error' in resolved) {
        throw new TableItemError(TABLE_LIBRARY_REFUSALS[resolved.error], resolved.error);
    }
    const libraryID = resolved.libraryID;

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

    const creation = options.creationOperation;
    const first = buildTableDocument(named, {
        linksFor,
        citationScopeFor: zoteroLinkScope,
    });
    if (first.cssRuleCount > CSS_RULE_BUDGET) {
        // Above the reader's threshold the snapshot loses its palette in dark mode.
        logger(
            `createTableItem: stylesheet has ${first.cssRuleCount} top-level rules, over the ${CSS_RULE_BUDGET} budget`,
            2
        );
    }

    requireTableLibrary(libraryID);
    options.accessGuard?.(named);

    const importOptions: Record<string, unknown> = {
        url: creation?.url ?? buildTableUrl(title),
        snapshotContent: first.html,
        title,
    };
    if (collectionID) importOptions.collections = [collectionID];

    let imported = false;
    try {
        const item = libraryID === Zotero.Libraries.userLibraryID
            ? await Zotero.Attachments.importFromSnapshotContent(importOptions)
            : await importGroupSnapshot({
                libraryID,
                collectionID,
                title,
                url: creation?.url ?? buildTableUrl(title),
                html: first.html,
                beforeImport: () => options.accessGuard?.(named),
            });
        imported = true;
        if (!item?.key) {
            throw new TableItemError(
                'Zotero returned no attachment for the table snapshot.',
                'import_failed'
            );
        }

        // --- step 2: the table, which knows which item it is
        const stored: TableSpec = {
            ...named,
            spec_version: specVersion,
            key: item.key,
            // A fresh item is revision 1 whatever the incoming spec claimed; a spec
            // copied from an existing table starts its own history here.
            version: 1,
        };
        const file: TableFile = creation
            ? {
                  spec: stored,
                  receipts: [
                      {
                          operation_id: creation.operation_id,
                          request_sha256: creation.request_sha256,
                          version: 1,
                          sha256: await tableSpecHash(stored),
                      },
                  ],
                  creation: {
                      operation_id: creation.operation_id,
                      request_sha256: creation.request_sha256,
                      complete: true,
                      meta: creation.meta,
                  },
              }
            : { spec: stored };

        const path = tableFilePath(item);
        if (!path) {
            throw new TableItemError(
                `Table ${item.key} has no storage directory.`,
                'file_missing'
            );
        }
        const tempPath = `${path}.beaver-tmp`;
        await IOUtils.writeUTF8(tempPath, JSON.stringify(file));
        requireTableLibrary(libraryID);
        options.accessGuard?.(stored);
        await IOUtils.move(tempPath, path);

        // The table is committed; bookkeeping failures cannot undo it.
        let saved = true;
        try {
            item.addTag(TABLE_TAG, 1);
            item.addTag(TABLE_EMOJI_TAG, 1);
            await item.saveTx();
        } catch (error) {
            saved = false;
            logger(`createTableItem: committed content needs local repair: ${String(error)}`, 1);
        }
        return { ...describeTableItem(item, stored, first.html, first.cssRuleCount), saved };

    } catch (error) {
        if (!imported && error instanceof TableItemError &&
            ['library_excluded', 'no_writable_library', 'unsupported_library'].includes(error.code)) {
            throw error;
        }
        if (creation) throw new TableItemError(
            'The import may exist but its table is not confirmed complete. Inspect it before creating another table.',
            'operation_pending',
        );
        throw error;
    }

}

/** Recheck access immediately before an import or document replacement. */
function requireTableLibrary(libraryID: number): void {
    const checked = checkTableLibrary(libraryID);
    if ('error' in checked)
        throw new TableItemError(TABLE_LIBRARY_REFUSALS[checked.error], checked.error);
}

/** The snapshot-content importer defaults top-level items to the personal library. */
async function importGroupSnapshot(options: {
    libraryID: number;
    collectionID?: number | null;
    title: string;
    url: string;
    html: string;
    beforeImport: () => void;
}): Promise<Zotero.Item> {
    const directory = (await Zotero.Attachments.createTemporaryStorageDirectory()).path;
    try {
        const filename = `${buildTableUrl(options.title).split('/').pop()}.html`;
        await IOUtils.writeUTF8(PathUtils.join(directory, filename), options.html);
        requireTableLibrary(options.libraryID);
        options.beforeImport();
        return await Zotero.Attachments.createURLAttachmentFromTemporaryStorageDirectory({
            directory,
            libraryID: options.libraryID,
            filename,
            url: options.url,
            title: options.title,
            contentType: 'text/html',
            ...(options.collectionID ? { collections: [options.collectionID] } : {}),
        });
    } finally {
        // Zotero moves this directory on success. Never remove the destination:
        // an import that threw late may already contain the operation marker.
        try {
            await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
        } catch (error) {
            logger(`importGroupSnapshot: temporary directory cleanup failed: ${String(error)}`, 2);
        }
    }
}

/** Describe the stored attachment consistently for imports and replays. */
export function describeTableItem(
    item: Zotero.Item,
    spec: TableSpec,
    html: string,
    cssRuleCount = Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi))
        .reduce((total, match) => total + countTopLevelCssRules(match[1]), 0)
): CreatedTableItem {
    return {
        item,
        itemID: item.id,
        key: item.key,
        libraryID: item.libraryID,
        title: spec.title ?? 'Table',
        filename: safeAttachmentFilename(item),
        storageDirectory: tableStorageDirectory(item),
        byteLength: new TextEncoder().encode(html).length,
        cssRuleCount,
        spec,
        selectUri: getZoteroSelectURI(item.libraryID, item.key),
        openUri: getZoteroOpenURI(item.libraryID, item.key),
    };
}

/** Retriable creation uses strict indexing; other callers retain best-effort behavior. */
export async function queueTableFullText(item: Zotero.Item, strict = false): Promise<void> {
    try {
        await Zotero.FullText?.queueItem?.(item);
    } catch (error) {
        if (strict) throw error;
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
