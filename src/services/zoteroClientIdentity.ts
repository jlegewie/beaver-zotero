/**
 * Zotero implementation of client identity for auth handshakes.
 *
 * Supplies the plugin version, client type/features, and the searchable
 * Zotero instance wire that `providerConnection.ts` sends as `WSAuthMessage`
 * fields, and registers itself as the default via `setClientIdentityProvider`.
 */

import { store } from '../../react/store';
import { searchableLibraryIdsAtom } from '../../react/atoms/profile';
import { buildZoteroInstanceWire } from './zoteroInstanceWire';
import { ZOTERO_PLUGIN_CLIENT_TYPE, ZOTERO_PLUGIN_FEATURES } from './agentProtocol';
import { ClientIdentity, setClientIdentityProvider } from './clientIdentity';

function resolveZoteroClientIdentity(): ClientIdentity {
    return {
        frontendVersion: Zotero.Beaver?.pluginVersion || '',
        clientType: ZOTERO_PLUGIN_CLIENT_TYPE,
        clientFeatures: ZOTERO_PLUGIN_FEATURES,
        zoteroInstance: buildZoteroInstanceWire(store.get(searchableLibraryIdsAtom)),
    };
}

/**
 * Register the Zotero client identity provider as the default. Call once at
 * webpack bundle init (from `react/index.tsx`), alongside
 * `registerZoteroDataProvider()`.
 */
export function registerZoteroClientIdentity(): void {
    setClientIdentityProvider(resolveZoteroClientIdentity);
}
