/**
 * Zotero implementation of client identity for auth handshakes.
 *
 * Supplies the plugin version, client type/features, and the searchable
 * Zotero instance wire that `providerConnection.ts` sends as `WSAuthMessage`
 * fields, and registers itself as the default via `setClientIdentityProvider`.
 */

import { getRuntimeAdapter } from '@beaver/agent-core/platform/runtime';
import { ZOTERO_PLUGIN_CLIENT_TYPE, zoteroPluginFeatures } from '@beaver/agent-core/protocol/agentProtocol';
import { ClientIdentity, setClientIdentityProvider } from '@beaver/agent-core/transport/clientIdentity';
import { searchableLibraryIdsAtom } from '../../react/atoms/profile';
import { store } from '../../react/store';
import { buildZoteroInstanceWire } from './zoteroInstanceWire';

function resolveZoteroClientIdentity(): ClientIdentity {
    return {
        frontendVersion: Zotero.Beaver?.pluginVersion || '',
        clientType: ZOTERO_PLUGIN_CLIENT_TYPE,
        clientFeatures: zoteroPluginFeatures(getRuntimeAdapter().isDevelopment()),
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
