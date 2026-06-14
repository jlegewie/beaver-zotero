import { setHost } from '../index';
import { zoteroNavigation } from './navigation';
import { zoteroItemData } from './itemData';
import { zoteroDocumentExport } from './citationExport';

/**
 * Assemble and register the Zotero client host. Call once at webpack bundle
 * init (from `react/index.tsx`) so rendered chat-history components can resolve
 * host-specific navigation, data lookups, and document export.
 */
export function registerZoteroHost(): void {
    setHost({
        navigation: zoteroNavigation,
        itemData: zoteroItemData,
        documentExport: zoteroDocumentExport,
    });
}
