import { setHost } from '../index';
import { zoteroNavigation } from './navigation';
import { zoteroItemData } from './itemData';
import { zoteroDocumentExport } from './citationExport';
import { zoteroConfig } from './config';
import { zoteroComponents } from './components';

/**
 * Assemble and register the Zotero client host. Call once at webpack bundle
 * init (from `react/index.tsx`) so rendered chat-history components can resolve
 * host-specific navigation, data lookups, document export, display config, and
 * client-specific UI components.
 */
export function registerZoteroHost(): void {
    setHost({
        navigation: zoteroNavigation,
        itemData: zoteroItemData,
        documentExport: zoteroDocumentExport,
        config: zoteroConfig,
        components: zoteroComponents,
    });
}
