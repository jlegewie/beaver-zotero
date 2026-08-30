/**
 * Recognising and reading a stored table.
 *
 * The half of the stored-table surface that only needs Zotero: the marks that
 * identify one of ours, where its files live, and how to read the spec back out
 * of the document. Creation and every other write live in `tableItem.ts`, which
 * re-exports everything here so a caller that wants both has one import.
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

import { logger } from '@beaver/agent-core/platform/logger';
import type { TableSpec } from '@beaver/agent-core/layouts/table';
import { parseTableDocument } from './tableDocument';

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
