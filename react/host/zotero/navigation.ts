import type { NavigationHost } from '../types';
import type { ZoteroItemReference } from '../../types/zotero';
import { revealSource } from '../../utils/sourceUtils';

/**
 * Zotero implementation of {@link NavigationHost}.
 *
 * Thin wrappers over the existing Zotero navigation helpers (`sourceUtils`,
 * `Zotero.*`); this façade is what client-agnostic render components depend on.
 */
export const zoteroNavigation: NavigationHost = {
    revealInLibrary(ref: ZoteroItemReference): void {
        revealSource(ref);
    },
    launchFile(filePath: string): void {
        Zotero.launchFile(filePath);
    },
    openExternalUrl(url: string): void {
        Zotero.getMainWindow().location.href = url;
    },
};
