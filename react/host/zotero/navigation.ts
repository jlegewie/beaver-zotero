import type { NavigationHost, AttachmentMatchNavigation } from '@beaver/agent-ui/host/types';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type { AttachmentMatchTarget } from '@beaver/agent-core/run-state/toolResultTypes';
import type { BatchOutcomeTarget } from '@beaver/agent-core/run-state/batchProgress';
import { revealSource, openSource as openZoteroSource } from '../../utils/sourceUtils';
import { selectCollection, selectLibrary, selectTagFilter } from '../../../src/utils/selectItem';
import { activateCitation } from './citationActivation';
import { launchExternalFile, notifyReferenceUnavailable, notifyTagAmbiguous } from './sourceActions';
import { navigateToAnnotation } from '../../utils/readerUtils';
import { navigateToAttachmentMatch as navigateToAttachmentMatchImpl } from '../../utils/attachmentMatchNavigation';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';
import { getMergedActions } from '../../types/actionStorage';
import { resolveItemReference, resolveLibraryRef } from '../../../src/utils/libraryIdentity';
import { logger } from '@beaver/agent-core/platform/logger';

/**
 * Whether a referenced item still exists in the Zotero library. History-rendered
 * surfaces (request chips, tool-result views) hold persisted refs that may have
 * been deleted since the run was saved. Sync; tolerant of a missing library.
 */
function resolveItemID(ref: ZoteroItemReference): { itemID: number; libraryID: number } | null | 'library_unavailable' {
    try {
        const libraryID = resolveLibraryRef(ref);
        if (!libraryID) return 'library_unavailable';
        const itemID = Zotero.Items.getIDFromLibraryAndKey(libraryID, ref.zotero_key);
        return itemID ? { itemID, libraryID } : null;
    } catch {
        return null;
    }
}

/**
 * The batch's library as a local id: `null` when it named none, `'unavailable'`
 * when it named one this computer does not have.
 */
function batchLibraryID(libraryRef?: string): number | null | 'unavailable' {
    if (!libraryRef) return null;
    return resolveLibraryRef({ library_ref: libraryRef }) ?? 'unavailable';
}

/**
 * Find a collection by key, in one library or across all of them.
 *
 * Scanning is safe where the batch named no library: keys are per-library but
 * random 8-character strings, so a collision is not a practical concern.
 */
function findCollectionByKey(key: string, libraryID: number | null): Zotero.Collection | null {
    const libraryIDs = libraryID
        ? [libraryID]
        : Zotero.Libraries.getAll().map((library) => library.libraryID);
    for (const id of libraryIDs) {
        // Returns false when this library holds no such collection.
        const found = Zotero.Collections.getByLibraryAndKey(id, key);
        if (found) return found as Zotero.Collection;
    }
    return null;
}

/**
 * Zotero implementation of {@link NavigationHost}.
 *
 * Thin wrappers over the existing Zotero navigation helpers (`sourceUtils`,
 * `Zotero.*`); this façade is what client-agnostic render components depend on.
 * The richer `activateCitation` flow lives in `./citationActivation`.
 */
export const zoteroNavigation: NavigationHost = {
    revealInLibrary(ref: ZoteroItemReference): void {
        const resolved = resolveItemID(ref);
        if (!resolved || resolved === 'library_unavailable') {
            notifyReferenceUnavailable('item', resolved === 'library_unavailable' ? 'library_unavailable' : 'missing');
            return;
        }
        revealSource({ ...ref, library_id: resolved.libraryID });
    },
    revealLibrary(libraryId: number): void {
        const library = Zotero.Libraries.get(libraryId);
        if (library) void selectLibrary(library as Zotero.Library);
    },
    revealCollection(ref: ZoteroItemReference): void {
        const libraryID = resolveLibraryRef(ref);
        if (!libraryID) {
            notifyReferenceUnavailable('collection', 'library_unavailable');
            return;
        }
        const found = Zotero.Collections.getByLibraryAndKey(libraryID, ref.zotero_key);
        if (found) selectCollection(found);
        else notifyReferenceUnavailable('collection');
    },
    async revealObject(ref: ZoteroItemReference): Promise<void> {
        // Click handler: an uncaught throw here is a silent dead link.
        try {
            const libraryID = resolveLibraryRef(ref);
            if (!libraryID) {
                notifyReferenceUnavailable('link', 'library_unavailable');
                return;
            }
            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, ref.zotero_key);
            if (item) {
                // Annotations have no row in the items tree; the reader is
                // the only place they can be shown.
                if (item.isAnnotation()) await navigateToAnnotation(item);
                else revealSource({ ...ref, library_id: libraryID });
                return;
            }
            // Items and collections have separate key spaces, so a key that
            // is not an item may still be a collection.
            const collection = Zotero.Collections.getByLibraryAndKey(libraryID, ref.zotero_key);
            // Trashed collections still resolve but cannot be selected.
            if (collection && (await selectCollection(collection as Zotero.Collection))) return;
            notifyReferenceUnavailable('link');
        } catch (error) {
            logger(`revealObject: failed to reveal ${ref.zotero_key}: ${error}`, 2);
            notifyReferenceUnavailable('link');
        }
    },
    launchFile(filePath: string): void {
        Zotero.launchFile(filePath);
    },
    openExternalUrl(url: string): void {
        // Route through ZoteroPane.loadURI: it dispatches `zotero://` URLs to
        // their registered protocol extension in-process (including Beaver's
        // own thread links) and hands everything else to the OS browser.
        // Never navigate the window itself — the UI lives in a chrome document.
        const pane = Zotero.getMainWindow()?.ZoteroPane;
        if (pane) {
            pane.loadURI(url);
            return;
        }
        try {
            Zotero.launchURL(url);
        } catch (error) {
            Zotero.logError(error as Error);
        }
    },
    activateCitation,
    openSource(ref: ZoteroItemReference): Promise<void> {
        const resolved = resolveItemID(ref);
        if (!resolved || resolved === 'library_unavailable') {
            notifyReferenceUnavailable('item', resolved === 'library_unavailable' ? 'library_unavailable' : 'missing');
            return Promise.resolve();
        }
        return openZoteroSource({ ...ref, library_id: resolved.libraryID });
    },
    async openAnnotation(ref: ZoteroItemReference): Promise<void> {
        const resolved = await resolveItemReference(ref);
        if (resolved.status === 'found' && resolved.item.isAnnotation()) await navigateToAnnotation(resolved.item);
        else notifyReferenceUnavailable('annotation', resolved.status === 'library_unavailable' ? 'library_unavailable' : 'missing');
    },
    navigateToAttachmentMatch(match: AttachmentMatchNavigation): Promise<void> {
        return navigateToAttachmentMatchImpl({
            library_id: match.library_id,
            zotero_key: match.zotero_key,
            library_ref: match.library_ref,
            content_kind: match.content_kind,
            page_number: match.page_number ?? undefined,
            page_label: match.page_label ?? undefined,
            target: (match.target ?? undefined) as AttachmentMatchTarget | undefined,
            snippet: match.snippet,
            ownerDocument: match.ownerDocument,
        });
    },
    launchExternalFile,
    async revealBatchOutcome(target: BatchOutcomeTarget): Promise<void> {
        // Click handler: an uncaught throw here is a silent dead row.
        try {
            const library = batchLibraryID(target.libraryRef);
            if (target.kind === 'collection') {
                if (library === 'unavailable') {
                    notifyReferenceUnavailable('collection', 'library_unavailable');
                    return;
                }
                const collection = findCollectionByKey(target.key, library);
                // Trashed collections still resolve but cannot be selected.
                if (collection && (await selectCollection(collection))) return;
                notifyReferenceUnavailable('collection');
                return;
            }
            if (library === 'unavailable') {
                notifyReferenceUnavailable('tag', 'library_unavailable');
                return;
            }
            // A batch that resolved to one library says which, and a tag name means nothing without one.
            const outcome = await selectTagFilter(target.name, library ?? undefined);
            if (outcome === 'filtered') return;
            if (outcome === 'ambiguous') notifyTagAmbiguous(target.name);
            else notifyReferenceUnavailable('tag');
        } catch (error) {
            logger(`revealBatchOutcome: failed to reveal ${target.kind}: ${error}`, 2);
            notifyReferenceUnavailable(target.kind);
        }
    },
    openActionSettings(actionId: string): void {
        // Pills in chat history carry send-time action ids that may not exist
        // here: the action can be deleted, or it was a custom action created
        // on another computer (custom ids live in the local profile's prefs).
        // Same visibility check the preferences Actions tab uses for reveal.
        if (!getMergedActions().some((a) => a.id === actionId)) {
            notifyReferenceUnavailable('action');
            return;
        }
        openPreferencesWindow('actions', undefined, actionId);
    },
};
