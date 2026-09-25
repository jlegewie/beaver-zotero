/**
 * Zotero implementation of client identity for auth handshakes.
 *
 * Supplies the plugin version, client type/features, the searchable Zotero
 * instance wire, and the extraction schema versions it serves documents in,
 * which `providerConnection.ts` sends as `WSAuthMessage` fields, and registers
 * itself as the default via `setClientIdentityProvider`.
 */

import { ZOTERO_PLUGIN_CLIENT_TYPE, ZOTERO_PLUGIN_FEATURES } from '@beaver/agent-core/protocol/agentProtocol';
import { ClientIdentity, setClientIdentityProvider } from '@beaver/agent-core/transport/clientIdentity';
import { buildZoteroInstanceWire } from './zoteroInstanceWire';
import { isTableChatEnabled } from './tableCapability';
import { extractSchemaVersionsDeclaration } from './documentExtraction/shared/extractionSchemaVersions';

function resolveZoteroClientIdentity(): ClientIdentity {
    return {
        frontendVersion: Zotero.Beaver?.pluginVersion || '',
        clientType: ZOTERO_PLUGIN_CLIENT_TYPE,
        clientFeatures: isTableChatEnabled() ? [...ZOTERO_PLUGIN_FEATURES, 'tables'] : ZOTERO_PLUGIN_FEATURES,
        zoteroInstance: buildZoteroInstanceWire(Zotero.Beaver?.searchableLibraryIds ?? []),
        extractSchemaVersions: extractSchemaVersionsDeclaration(),
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
