/**
 * The snapshot renderer: turns `table.json` into the attachment's HTML.
 *
 * `table.json` is the table and the store's write of it is the commit point;
 * the HTML is its rendering, for readers without Beaver and for Zotero's
 * full-text index. The store renders inside every write, right after the
 * commit and under the same lock and admitted mutation, so a render never
 * overlaps another operation and a snapshot is never behind a write that has
 * returned. A failed render never fails the write: the store reports it as
 * bookkeeping, and opening the table notices the stale HTML and renders again.
 *
 * The render is also what makes a change sync. Zotero notices a modified
 * attachment by its main file, so a change that touched only `table.json`
 * would never leave the device; the HTML carries the digests of the spec and
 * of the whole `table.json` as root attributes, so every commit changes the
 * main file. After writing it the renderer queues full-text indexing, marks
 * the attachment for upload and saves the item, then records both digests in
 * `bookkeeping.json`.
 */

import { logger } from "@beaver/agent-core/platform/logger";
import { checkLibraryExcluded } from "../agentDataProvider/utils";
import { sha256Hex } from "../../utils/hash";
import { tableSpecHash } from "./recoveryShadow";
import { tableFilesEditable } from "./tableItemIdentity";
import {
    buildTableDocument,
    renderedFileHash,
    renderedSpecHash,
} from "./tableDocument";
import {
    queueTableFullText,
    readTableItemSpec,
    resolveTableItem,
    tableSidecarDirectory,
    TABLE_EMOJI_TAG,
    TABLE_TAG,
    type TableRef,
} from "./tableItem";
import { zoteroLinkScope, zoteroLinksFor } from "./view/tableLinks";

/** The file the renderer records the digests of the last completed render in. */
export const TABLE_BOOKKEEPING_FILE = "bookkeeping.json";

/** Writes `text` to a renderer-owned temporary and renames it into place. */
async function writeAtomic(
    path: string,
    text: string,
    temp: string,
): Promise<void> {
    await IOUtils.writeUTF8(temp, text);
    await IOUtils.move(temp, path);
}

/** Whether Beaver may replace the table's files: not excluded, and editable now. */
function mayRender(ref: TableRef): boolean {
    if (checkLibraryExcluded(ref.libraryID)) return false;
    return tableFilesEditable(Zotero.Libraries.get(ref.libraryID));
}

/**
 * Renders the table now: the snapshot from `table.json`, then indexing, the
 * upload mark, the item save and the bookkeeping record. Returns false when
 * there was nothing to render (trashed, unreadable, or in a library Beaver
 * does not write to). Call only from the store, inside an admitted operation
 * holding the table's lock.
 */
export async function renderTable(ref: TableRef): Promise<boolean> {
    if (!mayRender(ref)) return false;
    let item: Zotero.Item;
    try {
        item = await resolveTableItem(ref);
    } catch {
        return false;
    }
    const read = await readTableItemSpec(item);
    if (!read.ok) {
        logger(
            `tableRenderer: ${ref.key} has no readable table (${read.code})`,
            2,
        );
        return false;
    }
    const sha256 = await tableSpecHash(read.spec);
    const fileSha256 = await tableFileHash(read.file);
    const document = buildTableDocument(read.spec, {
        specSha256: sha256,
        fileSha256,
        linksFor: zoteroLinksFor,
        citationScopeFor: zoteroLinkScope,
    });
    // Not `getFilePathAsync`, which answers false for a file that is missing —
    // the very snapshot this may be restoring.
    const path = item.getFilePath();
    const sidecar = tableSidecarDirectory(item);
    if (!path || !sidecar)
        throw new Error(`Table ${ref.key} has no file on disk.`);
    await IOUtils.makeDirectory(sidecar, {
        createAncestors: true,
        ignoreExisting: true,
    });
    const temp = PathUtils.join(sidecar, ".render.tmp");
    // Exclusions and permissions change outside the mutation queue, so they
    // are checked again before every file and item change.
    if (!mayRender(ref)) return false;
    await writeAtomic(path, document.html, temp);

    await queueTableFullText(item, true);
    if ((await readBookkeeping(item))?.tags_pending) {
        item.addTag(TABLE_TAG, 1);
        item.addTag(TABLE_EMOJI_TAG, 1);
    }
    if (!mayRender(ref)) return false;
    // One name: the item's title is the table's, so a rename reaches the
    // library row with the snapshot that shows it.
    const title = read.spec.title || 'Table';
    if (item.getField('title') !== title) item.setField('title', title);
    item.attachmentSyncState = Zotero.Sync.Storage.Local.SYNC_STATE_TO_UPLOAD;
    await item.saveTx();
    await writeAtomic(
        PathUtils.join(sidecar, TABLE_BOOKKEEPING_FILE),
        JSON.stringify({
            sha256,
            file_sha256: fileSha256,
        } satisfies Bookkeeping),
        temp,
    );
    return true;
}

/** The digest of a committed `table.json`, receipts included. */
function tableFileHash(file: unknown): Promise<string> {
    return sha256Hex(JSON.stringify(file));
}

/**
 * Whether the snapshot on disk renders the spec with this hash: false when it
 * is missing, unreadable, or one render behind.
 */
export async function snapshotIsCurrent(
    item: Zotero.Item,
    sha256: string,
): Promise<boolean> {
    const head = await snapshotHead(item);
    return head !== null && renderedSpecHash(head) === sha256;
}

interface Bookkeeping {
    /** The spec hash the last completed render covered. */
    sha256?: string;
    /** The `table.json` digest it covered: a receipt-only commit changes only this. */
    file_sha256?: string;
    /** The item's tags were never saved; the next render adds them. */
    tags_pending?: true;
}

async function readBookkeeping(item: Zotero.Item): Promise<Bookkeeping | null> {
    const sidecar = tableSidecarDirectory(item);
    if (!sidecar) return null;
    try {
        const path = PathUtils.join(sidecar, TABLE_BOOKKEEPING_FILE);
        if (!(await IOUtils.exists(path))) return null;
        const parsed = JSON.parse(await IOUtils.readUTF8(path)) as Bookkeeping;
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Whether the snapshot is complete for `table.json` as committed now — its
 * spec and its receipts: the last completed render recorded both digests, and
 * the HTML on disk names them. False when the table cannot be read, so a
 * caller renders and learns why.
 */
export async function renderIsCurrent(item: Zotero.Item): Promise<boolean> {
    const done = await readBookkeeping(item);
    if (!done?.sha256 || !done.file_sha256) return false;
    const read = await readTableItemSpec(item);
    if (!read.ok) return false;
    const sha256 = await tableSpecHash(read.spec);
    const fileSha256 = await tableFileHash(read.file);
    if (done.sha256 !== sha256 || done.file_sha256 !== fileSha256) return false;
    const head = await snapshotHead(item);
    return (
        head !== null &&
        renderedSpecHash(head) === sha256 &&
        renderedFileHash(head) === fileSha256
    );
}

/** The snapshot's first bytes, which hold its root element, or null when unreadable. */
async function snapshotHead(item: Zotero.Item): Promise<string | null> {
    try {
        const path = await item.getFilePathAsync();
        if (!path || !(await IOUtils.exists(path))) return null;
        const bytes = await IOUtils.read(path, { maxBytes: 4096 });
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

/**
 * Records that a committed table's item marks (its tags) did not save, so the
 * next render restores them. Best effort: a failure leaves the repair to an
 * open of the table.
 */
export async function markTablePending(item: Zotero.Item): Promise<void> {
    const sidecar = tableSidecarDirectory(item);
    if (!sidecar) return;
    try {
        await IOUtils.makeDirectory(sidecar, {
            createAncestors: true,
            ignoreExisting: true,
        });
        await writeAtomic(
            PathUtils.join(sidecar, TABLE_BOOKKEEPING_FILE),
            JSON.stringify({ tags_pending: true } satisfies Bookkeeping),
            PathUtils.join(sidecar, ".render.tmp"),
        );
    } catch (error) {
        logger(
            `tableRenderer: could not record pending bookkeeping for ${item.key}: ${String(error)}`,
            2,
        );
    }
}
