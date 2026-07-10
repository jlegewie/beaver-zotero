import type { NavigationHost, AttachmentMatchNavigation } from '../types';
import type { ZoteroItemReference } from '../../types/zotero';
import type { AttachmentMatchTarget } from '../../agents/toolResultTypes';
import { revealSource, openSource as openZoteroSource } from '../../utils/sourceUtils';
import { selectCollection, selectLibrary } from '../../../src/utils/selectItem';
import { activateCitation } from './citationActivation';
import { launchExternalFile, notifyReferenceUnavailable } from './sourceActions';
import { navigateToAnnotation } from '../../utils/readerUtils';
import { navigateToAttachmentMatch as navigateToAttachmentMatchImpl } from '../../utils/attachmentMatchNavigation';
import { openPreferencesWindow } from '../../../src/ui/openPreferencesWindow';
import { getMergedActions } from '../../types/actionStorage';
import { resolveItemReference, resolveLibraryRef } from '../../../src/utils/libraryIdentity';

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
    launchFile(filePath: string): void {
        Zotero.launchFile(filePath);
    },
    openExternalUrl(url: string): void {
        Zotero.getMainWindow().location.href = url;
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
