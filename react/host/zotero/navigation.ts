import type { NavigationHost } from '../types';
import type { ZoteroItemReference } from '../../types/zotero';
import { revealSource, openSource as openZoteroSource } from '../../utils/sourceUtils';
import { selectCollection } from '../../../src/utils/selectItem';
import { activateCitation } from './citationActivation';
import { launchExternalFile } from './sourceActions';
import { navigateToAnnotation } from '../../utils/readerUtils';

/**
 * Zotero implementation of {@link NavigationHost}.
 *
 * Thin wrappers over the existing Zotero navigation helpers (`sourceUtils`,
 * `Zotero.*`); this façade is what client-agnostic render components depend on.
 * The richer `activateCitation` flow lives in `./citationActivation`.
 */
export const zoteroNavigation: NavigationHost = {
    revealInLibrary(ref: ZoteroItemReference): void {
        revealSource(ref);
    },
    revealCollection(ref: ZoteroItemReference): void {
        const found = Zotero.Collections.getByLibraryAndKey(ref.library_id, ref.zotero_key);
        if (found) selectCollection(found);
    },
    launchFile(filePath: string): void {
        Zotero.launchFile(filePath);
    },
    openExternalUrl(url: string): void {
        Zotero.getMainWindow().location.href = url;
    },
    activateCitation,
    openSource(ref: ZoteroItemReference): Promise<void> {
        return openZoteroSource(ref);
    },
    async openAnnotation(ref: ZoteroItemReference): Promise<void> {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(ref.library_id, ref.zotero_key);
        if (item && item.isAnnotation()) await navigateToAnnotation(item);
    },
    launchExternalFile,
};
