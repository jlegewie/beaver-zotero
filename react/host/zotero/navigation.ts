import type { NavigationHost, AttachmentMatchNavigation } from '../types';
import type { ZoteroItemReference } from '../../types/zotero';
import type { AttachmentMatchTarget } from '../../agents/toolResultTypes';
import { revealSource, openSource as openZoteroSource } from '../../utils/sourceUtils';
import { selectCollection, selectLibrary } from '../../../src/utils/selectItem';
import { activateCitation } from './citationActivation';
import { launchExternalFile, notifyReferenceUnavailable } from './sourceActions';
import { navigateToAnnotation } from '../../utils/readerUtils';
import { navigateToAttachmentMatch as navigateToAttachmentMatchImpl } from '../../utils/attachmentMatchNavigation';

/**
 * Whether a referenced item still exists in the Zotero library. History-rendered
 * surfaces (request chips, tool-result views) hold persisted refs that may have
 * been deleted since the run was saved. Sync; tolerant of a missing library.
 */
function itemExists(ref: ZoteroItemReference): boolean {
    try {
        return !!Zotero.Items.getIDFromLibraryAndKey(ref.library_id, ref.zotero_key);
    } catch {
        return false;
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
        if (!itemExists(ref)) {
            notifyReferenceUnavailable('item');
            return;
        }
        revealSource(ref);
    },
    revealLibrary(libraryId: number): void {
        const library = Zotero.Libraries.get(libraryId);
        if (library) void selectLibrary(library as Zotero.Library);
    },
    revealCollection(ref: ZoteroItemReference): void {
        const found = Zotero.Collections.getByLibraryAndKey(ref.library_id, ref.zotero_key);
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
        if (!itemExists(ref)) {
            notifyReferenceUnavailable('item');
            return Promise.resolve();
        }
        return openZoteroSource(ref);
    },
    async openAnnotation(ref: ZoteroItemReference): Promise<void> {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(ref.library_id, ref.zotero_key);
        if (item && item.isAnnotation()) await navigateToAnnotation(item);
        else notifyReferenceUnavailable('annotation');
    },
    navigateToAttachmentMatch(match: AttachmentMatchNavigation): Promise<void> {
        return navigateToAttachmentMatchImpl({
            library_id: match.library_id,
            zotero_key: match.zotero_key,
            content_kind: match.content_kind,
            page_number: match.page_number ?? undefined,
            page_label: match.page_label ?? undefined,
            target: (match.target ?? undefined) as AttachmentMatchTarget | undefined,
            snippet: match.snippet,
            ownerDocument: match.ownerDocument,
        });
    },
    launchExternalFile,
};
