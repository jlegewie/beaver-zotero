/**
 * Writing an approved `import_item` action to the library.
 *
 * The item JSON was resolved before approval; execution writes exactly that.
 * The only network work here is the background attachment (PDF fetch or page
 * snapshot), which never opens a visible window: downloads go through
 * `pdfAttachmentFetch` (`shouldDisplayCaptcha: false`), never `ItemSaver`
 * download mode, `importFromURL` or `addAvailableFile`.
 *
 * Citation-derived actions carry no item yet (`pending_resolution`): they are
 * resolved here, at the user's click, and fail with `already_in_library` if
 * the work is already there — nothing is adopted, so undo can never erase a
 * pre-existing item.
 *
 * Must run in the plugin realm (through `addon.libraryOperations`).
 */

import type {
    ImportItemProposedData,
    ImportItemResultData,
    ImportItemSpec,
    ZoteroItemJson,
} from '@beaver/agent-core/types/itemImport';
import { logger } from '@beaver/agent-core/platform/logger';
import { cancelTasksForItem, generateTaskId, scheduleBackgroundTask } from '../../utils/backgroundTasks';
import { libraryRefForLibraryID, resolveItemReference, resolveLibraryRef, resolveWriteTargetLibrary } from '../../utils/libraryIdentity';
import { createProvenanceNote } from '../../utils/noteProvenance';
import { getPref } from '../../utils/prefs';
import type { TimingAccumulator } from '../../utils/timing';
import type { AttachmentResolvedPayload } from '../attachmentResolved';
import { assertLibraryWritable, recheckExistingCollections } from '../collections/collectionMutations';
import { coordinateLibraryMutation } from '../libraryMutations';
import { runCommittedTransaction } from '../committedTransaction';
import { isPdfDocument } from '../../utils/attachmentFiles';
import { WEB_CONTENT_ITEM_TYPES } from './duplicates';
import { filterPdfAttachments, schedulePdfFetchTask } from './pdfFetch';
import { BEAVER_PROVENANCE_MARKER, stampBeaverProvenanceExtra } from './provenance';
import { locateImportFile, type LocatedFile } from './recognizeFile';
import { resolveImportItems } from './resolve';
import { checkUrlAllowed, createGuardedBrowser, landedOnBlockedHost } from './resolveUrl';
import { isApiAvailable, loadWebTranslationModules, looksLikeApiDrift, markApiUnavailable, withTimeout } from './zoteroApis';

export interface WriteImportOptions {
    /** Explicit target library (citation clicks use the UI context). Overrides the action's library. */
    libraryId?: number;
    /** Extra collection from the UI context (citation clicks). */
    collectionId?: number | null;
    actionId?: string;
    runId?: string;
    threadId?: string | null;
    onAttachmentResolved?: (payload: AttachmentResolvedPayload) => void;
    /** Checkpoint before irreversible work (execute deadline, account change). */
    assertCurrent?: () => void;
    timing?: TimingAccumulator;
}

/** A write failure with a stable code; `details` carries e.g. the existing item. */
export class ImportItemError extends Error {
    constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
        super(message);
        this.name = 'ImportItemError';
    }
}

const SNAPSHOT_BUDGET_MS = 60_000;
const BEAVER_METADATA_LINE: Record<string, string> = {
    model_metadata: 'Beaver Metadata: written by Beaver from the conversation',
    fallback_metadata: 'Beaver Metadata: search-result metadata (identifier lookup failed)',
};

function track<T>(timing: TimingAccumulator | undefined, name: string, fn: () => Promise<T>): Promise<T> {
    return timing ? timing.track(name, fn) : fn();
}

function assertWriteAccess(libraryId: number): void {
    if (!Zotero.Beaver?.libraryScopeInitialized || !Zotero.Beaver.searchableLibraryIds?.includes(libraryId)) {
        throw new ImportItemError('library_not_searchable', 'The target library is excluded from Beaver or unavailable.');
    }
    const library = Zotero.Libraries.get(libraryId);
    if (!library || !library.editable) {
        throw new ImportItemError('library_not_editable', 'The target library is read-only.');
    }
}

function targetLibrary(data: ImportItemProposedData, options: WriteImportOptions): number {
    if (options.libraryId !== undefined) return options.libraryId;
    const resolution = resolveWriteTargetLibrary(data);
    if (!resolution.ok) throw new ImportItemError(resolution.code, resolution.message);
    return resolution.libraryID;
}

/** Resolve a citation-derived action at apply time. */
async function resolvePending(data: ImportItemProposedData, libraryID: number, threadId?: string | null) {
    const pending = data.pending_resolution;
    const spec: ImportItemSpec = {
        key: data.source?.input || 'citation',
        source: data.source,
        identifier: pending?.identifier,
        url: pending?.url,
        fallback_item: pending?.fallback_item,
    };
    const [resolved] = await resolveImportItems([spec], { libraryID, deadlineMs: 20_000, threadId });
    // The library may have been excluded during resolution; a duplicate match
    // from it must not be reported.
    assertWriteAccess(libraryID);
    if (!resolved) throw new ImportItemError('resolution_failed', 'The reference could not be resolved.');
    if (resolved.status === 'already_in_library') {
        throw new ImportItemError('already_in_library', 'This work is already in your library.', {
            existing_item: resolved.existing_item,
        });
    }
    if (resolved.status === 'failed' || !resolved.item) {
        throw new ImportItemError(resolved.error?.code ?? 'resolution_failed', resolved.error?.message ?? 'The reference could not be resolved.');
    }
    return resolved;
}

/** Fields an import never sets: Zotero assigns them, or they are saved separately. */
const IMPORT_IGNORED_FIELDS = ['attachments', 'notes', 'dateAdded', 'dateModified', 'seeAlso', 'version', 'id', 'itemID', 'key', 'path'];

/**
 * Tags for the saved JSON. Resolved tags become automatic, as Zotero's
 * translator import makes them (and are dropped when the user turned automatic
 * tags off); the action's tags are manual and replace an automatic tag of the
 * same name, as `item.addTag(name, 0)` would.
 *
 * Names are compared as Zotero stores them (trimmed, NFC-normalized): two
 * entries that differ only before that cleanup would otherwise both reach the
 * save, where the automatic one would overwrite the manual one.
 */
function tagsForSave(resolved: ZoteroItemJson['tags'], manual: string[] | undefined): Array<{ tag: string; type: 0 | 1 }> {
    const tags = new Map<string, 0 | 1>();
    const add = (name: unknown, type: 0 | 1) => {
        if (typeof name !== 'string') return;
        const cleaned = name.trim().normalize();
        if (cleaned) tags.set(cleaned, type);
    };
    if (Zotero.Prefs.get('automaticTags')) {
        for (const entry of resolved ?? []) add(typeof entry === 'string' ? entry : entry?.tag, 1);
    }
    for (const name of manual ?? []) add(name, 0);
    return [...tags].map(([tag, type]) => ({ tag, type }));
}

/**
 * Save item JSON the way Zotero saves a translator result (creators, child
 * notes, automatic tags), attachments ignored, in one transaction that also
 * carries the action's manual tags.
 *
 * The save returns once it has committed, without waiting long for other
 * plugins' Notifier observers (see `runCommittedTransaction`).
 */
async function saveItemJson(
    json: ZoteroItemJson,
    libraryID: number,
    collectionIDs: number[],
    manualTags: string[] | undefined,
    timing: TimingAccumulator | undefined,
): Promise<Zotero.Item> {
    if (json.itemType === 'note' || json.itemType === 'attachment') {
        throw new ImportItemError('invalid_item_type', `Cannot import a standalone ${json.itemType}.`);
    }
    const fields = JSON.parse(JSON.stringify(json)) as ZoteroItemJson;
    const notes = Array.isArray(fields.notes) ? fields.notes : [];
    for (const name of IMPORT_IGNORED_FIELDS) delete fields[name];
    for (const creator of fields.creators ?? []) {
        if (!creator.creatorType) creator.creatorType = 'author';
    }
    if (fields.accessDate === 'CURRENT_TIMESTAMP') fields.accessDate = (Zotero.Date as any).dateToISO(new Date());
    const tags = tagsForSave(fields.tags, manualTags);
    if (tags.length) fields.tags = tags;
    else delete fields.tags;

    return runCommittedTransaction(async () => {
        const item = new Zotero.Item(fields.itemType as any);
        item.libraryID = libraryID;
        item.fromJSON(fields);
        if (collectionIDs.length) item.setCollections(collectionIDs);
        await item.save();
        for (const note of notes) {
            const text = typeof note === 'string' ? note : note?.note;
            if (typeof text !== 'string') continue;
            const child = new Zotero.Item('note');
            child.libraryID = libraryID;
            child.parentID = item.id;
            child.setNote(text);
            const noteTags = typeof note === 'object' ? tagsForSave((note as { tags?: ZoteroItemJson['tags'] }).tags, undefined) : [];
            if (noteTags.length) child.setTags(noteTags);
            await child.save();
        }
        return item;
    }, { timing, label: 'import_item save' });
}

/** Attach the input file as a child of `parent`, renamed the way Zotero renames on import. */
async function attachFile(parent: Zotero.Item, file: LocatedFile): Promise<Zotero.Item> {
    const attachments = Zotero.Attachments as any;
    const link = file.ref.mode === 'link';
    let fileBaseName: string | false | undefined;
    // Linked originals are never renamed: Beaver does not modify the user's files.
    if (!link && isApiAvailable('attachmentRename')) {
        try {
            if (attachments.shouldAutoRenameFile(false, parent.libraryID) && !parent.numNonHTMLFileAttachments()) {
                fileBaseName = await attachments.getRenamedFileBaseNameIfAllowedType(parent, file.path);
            }
        } catch (error) {
            if (looksLikeApiDrift(error)) markApiUnavailable('attachmentRename', error);
            fileBaseName = undefined;
        }
    }
    if (link) {
        return attachments.linkFromFile({ file: file.path, parentItemID: parent.id });
    }
    return attachments.importFromFile({
        file: file.path,
        libraryID: parent.libraryID,
        parentItemID: parent.id,
        ...(fileBaseName ? { fileBaseName } : {}),
    });
}

/** Erase an item created by an import that failed afterwards. */
async function cleanupFailedImport(item: Zotero.Item | null): Promise<void> {
    if (!item) return;
    try {
        await item.eraseTx();
    } catch (error) {
        logger(`itemImport/write: failed to clean up ${item.libraryID}-${item.key}: ${error}`, 1);
    }
}

/** Capture a snapshot of `url` as a child attachment, in the background. */
function scheduleSnapshotTask(libraryId: number, itemKey: string, url: string, options: WriteImportOptions): void {
    const generation = Zotero.Beaver.account?.getGeneration();
    const assertAccess = () => {
        const library = Zotero.Libraries.get(libraryId);
        if (generation !== Zotero.Beaver.account?.getGeneration()) throw new Error('Account changed');
        if (!Zotero.Beaver.libraryScopeInitialized || !Zotero.Beaver.searchableLibraryIds?.includes(libraryId)
            || !library || !library.editable || library.filesEditable === false) {
            throw new Error('Library is excluded or unavailable');
        }
    };

    scheduleBackgroundTask(generateTaskId('snapshot', libraryId, itemKey), 'snapshot', async (signal: AbortSignal) => {
        const startedAt = Date.now();
        let snapshot: Zotero.Item | null = null;
        let browser: any = null;
        let release: () => void = () => {};
        let blocked: () => boolean = () => false;
        try {
            assertAccess();
            const allowed = await checkUrlAllowed(url);
            if (!allowed.ok) throw new Error(allowed.message);
            const modules = loadWebTranslationModules();
            if (!modules) throw new Error('Hidden browser unavailable');
            // Only loading is bounded: once the capture is saving, it settles on its own.
            let abandoned = false;
            await withTimeout((async () => {
                const guarded = await createGuardedBrowser(modules.HiddenBrowser);
                if (abandoned) {
                    guarded.release();
                    try { guarded.browser.destroy(); } catch { /* already destroyed */ }
                    return;
                }
                ({ browser, release, blocked } = guarded);
                const loaded = await browser.load(url, { requireSuccessfulStatus: true });
                if (!loaded) throw new Error('Page did not load');
                if (blocked() || landedOnBlockedHost(browser)) throw new Error('The page reached a private-network address');
            })(), SNAPSHOT_BUDGET_MS, 'Loading the page for its snapshot').catch((error) => {
                abandoned = true;
                throw error;
            });
            if (!signal.aborted) {
                snapshot = await coordinateLibraryMutation(async () => {
                    assertAccess();
                    if (signal.aborted) return null;
                    const parent = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, itemKey);
                    if (!parent || parent.deleted) throw new Error('Snapshot parent item is unavailable');
                    return (Zotero.Attachments as any).importFromDocument({ browser, parentItemID: parent.id });
                }, { signal, assertCurrent: assertAccess });
            }
        } catch (error) {
            if (looksLikeApiDrift(error)) markApiUnavailable('importFromDocument', error);
            logger(`itemImport/write: snapshot of ${url} for ${itemKey} failed: ${error}`, 1);
        } finally {
            release();
            try { browser?.destroy(); } catch { /* already destroyed */ }
            if (!signal.aborted && generation === Zotero.Beaver.account?.getGeneration()
                && Zotero.Beaver.searchableLibraryIds?.includes(libraryId)) {
                const captured = snapshot as Zotero.Item | null;
                options.onAttachmentResolved?.({
                    threadId: options.threadId ?? undefined,
                    actionId: options.actionId,
                    libraryId,
                    zoteroKey: itemKey,
                    attachmentStatus: captured ? 'available' : 'failed',
                    attachmentKey: captured ? `${libraryId}-${captured.key}` : undefined,
                    accessMethod: captured ? 'snapshot' : undefined,
                    elapsedMs: Date.now() - startedAt,
                });
            }
        }
    }, { itemKey, libraryId, progressMessage: 'Saving snapshot...' });
}

function resultFor(
    item: Zotero.Item,
    collections: { memberships: ReturnType<typeof recheckExistingCollections>; skipped: string[] },
    status: ImportItemResultData['attachment_status'],
    attachment?: Zotero.Item | null,
    fileAttachment?: Zotero.Item | null,
): ImportItemResultData {
    const libraryId = item.libraryID;
    const { memberships, skipped } = collections;
    return {
        library_id: libraryId,
        zotero_key: item.key,
        library_ref: libraryRefForLibraryID(libraryId) ?? undefined,
        collection_ids: memberships.map((entry) => entry.collectionId),
        collection_keys: memberships.map((entry) => entry.key),
        ...(skipped.length ? { skipped_collections: skipped } : {}),
        attachment_status: status,
        ...(attachment ? { attachment_key: `${libraryId}-${attachment.key}` } : {}),
        ...(fileAttachment ? { file_attachment_key: `${libraryId}-${fileAttachment.key}` } : {}),
    };
}

/** Extra with Beaver's provenance line and, for unchecked metadata, its source line. */
function withProvenanceLines(extra: string, method: string | undefined): string {
    const lines = extra ? [extra] : [];
    if (!extra.includes(BEAVER_PROVENANCE_MARKER)) lines.push(`${BEAVER_PROVENANCE_MARKER}: ${new Date().toISOString().slice(0, 10)}`);
    const sourceLine = method ? BEAVER_METADATA_LINE[method] : undefined;
    if (sourceLine && !extra.includes(sourceLine)) lines.push(sourceLine);
    return lines.join('\n');
}

/**
 * Restore Beaver's provenance and metadata-source stamp if the saved item lacks
 * them, and add the optional provenance note. Both are already in the first
 * save, so the stamp normally saves nothing.
 */
async function finishItem(item: Zotero.Item, method: string | undefined, options: WriteImportOptions): Promise<void> {
    if (item.isAttachment()) return;
    let needsSave = stampBeaverProvenanceExtra(item);
    const sourceLine = method ? BEAVER_METADATA_LINE[method] : undefined;
    const extra = (item.getField('extra') as string) || '';
    if (sourceLine && !extra.includes(sourceLine)) {
        item.setField('extra', extra ? `${extra}\n${sourceLine}` : sourceLine);
        needsSave = true;
    }
    if (needsSave) {
        await runCommittedTransaction(() => item.save(), { timing: options.timing, label: 'import_item stamp' });
    }
    if (getPref('addBeaverProvenanceNote') === true) {
        await createProvenanceNote(
            { library_id: item.libraryID, zotero_key: item.key, library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined },
            { threadId: options.threadId ?? undefined, runId: options.runId },
            (note) => runCommittedTransaction(() => note.save(), { timing: options.timing, label: 'import_item provenance note' }),
        );
    }
}

/** Write one approved `import_item` action. */
export async function writeImportItem(data: ImportItemProposedData, options: WriteImportOptions = {}): Promise<ImportItemResultData> {
    if (!data || !data.source) throw new ImportItemError('missing_item_data', 'No item data provided.');
    const libraryID = targetLibrary(data, options);
    assertWriteAccess(libraryID);
    assertLibraryWritable(libraryID);
    const requested = data.collection_ids ?? data.collection_keys ?? [];
    // A collection deleted after approval is skipped and reported; the item is still created.
    const memberships = recheckExistingCollections(requested, libraryID);
    const skipped = requested.filter((input) => !memberships.some((entry) => entry.collectionId === input || entry.key === input));
    const collections = { memberships, skipped };
    const collectionIDs = memberships.map((entry) => entry.collection.id);
    if (options.collectionId != null && !collectionIDs.includes(options.collectionId)) {
        const contextCollection = Zotero.Collections.get(options.collectionId);
        if (contextCollection && contextCollection.libraryID === libraryID) collectionIDs.push(options.collectionId);
    }

    let file: LocatedFile | undefined;
    if (data.file) {
        const location = await locateImportFile(data.file, { threadId: options.threadId, recheck: true });
        if (!location.ok) throw new ImportItemError(location.code, location.message);
        file = location.file;
        // Zotero supports linked files only in the personal library.
        if (file.ref.mode === 'link' && libraryID !== Zotero.Libraries.userLibraryID) {
            throw new ImportItemError('link_not_supported', 'Linked files can only be added to My Library.');
        }
    }

    let json = data.item;
    let method = data.resolution?.method;
    let snapshotUrl = data.snapshot_url;
    if (!json && data.pending_resolution) {
        const resolved = await track(options.timing, 'resolve_ms', () => resolvePending(data, libraryID, options.threadId));
        json = resolved.item;
        method = resolved.method;
        snapshotUrl = resolved.snapshot_url;
    }

    options.assertCurrent?.();
    // Resolution can take seconds: the library may have been excluded or made
    // read-only meanwhile, so check again right before anything is written.
    assertWriteAccess(libraryID);

    if (!json) throw new ImportItemError('missing_item_data', 'No item data provided.');

    const toSave: ZoteroItemJson = { ...json };
    // An access date the user gave is kept; otherwise web content records when it was saved.
    if ((WEB_CONTENT_ITEM_TYPES.has(json.itemType) || !!snapshotUrl) && !(typeof json.accessDate === 'string' && json.accessDate.trim())) {
        toSave.accessDate = (Zotero.Date as any).dateToISO(new Date());
    }
    // Provenance goes into the first save: other plugins that react to new items
    // (title linters, arXiv helpers) may re-save the item from their own copy,
    // which would drop a stamp added in a second save.
    toSave.extra = withProvenanceLines(typeof json.extra === 'string' ? json.extra : '', method);

    const item = await track(options.timing, 'save_ms', () => saveItemJson(toSave, libraryID, collectionIDs, data.tags, options.timing));
    try {
        await finishItem(item, method, options);

        let fileAttachment: Zotero.Item | null = null;
        if (file) fileAttachment = await track(options.timing, 'attach_file_ms', () => attachFile(item, file!));

        const pdfs = await filterPdfAttachments(item.getAttachments());
        if (fileAttachment) {
            const primary = pdfs[0] ?? fileAttachment;
            return resultFor(item, collections, 'available', primary, fileAttachment);
        }
        if (pdfs.length) return resultFor(item, collections, 'available', pdfs[0]);

        // Web content gets a snapshot, following Zotero's own "Take automatic snapshots" setting.
        const snapshotEnabled = !!snapshotUrl && Zotero.Prefs.get('automaticSnapshots') !== false
            && isApiAvailable('importFromDocument') && isApiAvailable('remoteTranslate');
        if (snapshotEnabled) {
            scheduleSnapshotTask(libraryID, item.key, snapshotUrl!, options);
            return resultFor(item, collections, 'pending');
        }
        const filesEditable = (Zotero.Libraries.get(libraryID) as any)?.filesEditable !== false;
        // Zotero's own resolvers work from a DOI or URL; with neither and no
        // candidates there is nowhere to look.
        const hasPdfSource = (data.pdf_candidates?.length ?? 0) > 0
            || (typeof json.DOI === 'string' && !!json.DOI.trim())
            || (typeof json.url === 'string' && !!json.url.trim())
            || /(^|\n)\s*DOI:/i.test(typeof json.extra === 'string' ? json.extra : '');
        if (!WEB_CONTENT_ITEM_TYPES.has(json.itemType) && filesEditable && hasPdfSource) {
            schedulePdfFetchTask(libraryID, item.key, {
                pdfCandidates: data.pdf_candidates,
                actionId: options.actionId,
                runId: options.runId,
                threadId: options.threadId ?? undefined,
                onAttachmentResolved: options.onAttachmentResolved,
            });
            return resultFor(item, collections, 'pending');
        }
        return resultFor(item, collections, 'none');
    } catch (error) {
        await cleanupFailedImport(item);
        throw error;
    }
}

/** Undo an applied `import_item` action: erase the created item (and children). Linked files stay on disk. */
export async function undoImportItem(result: Pick<ImportItemResultData, 'library_id' | 'library_ref' | 'zotero_key'> | undefined): Promise<void> {
    if (!result?.zotero_key) throw new ImportItemError('not_applied', 'Cannot undo: the item was not created.');
    const taskLibraryId = resolveLibraryRef(result);
    if (taskLibraryId) cancelTasksForItem(taskLibraryId, result.zotero_key);
    const resolved = await resolveItemReference(result);
    if (resolved.status !== 'found') {
        logger(`itemImport/write: undo found no item for ${result.library_ref ?? result.library_id}-${result.zotero_key} (${resolved.status})`, 1);
        return;
    }
    assertLibraryWritable(resolved.item.libraryID);
    await resolved.item.eraseTx();
}
