/**
 * Zotero implementation of client identity for auth handshakes.
 *
 * Supplies the plugin version, client type/features, the searchable Zotero
 * instance wire, and the extraction schema versions it serves documents in,
 * which `providerConnection.ts` sends as `WSAuthMessage` fields, and registers
 * itself as the default via `setClientIdentityProvider`.
 */

import { CLIENT_FEATURES, ZOTERO_PLUGIN_CLIENT_TYPE, ZOTERO_PLUGIN_FEATURES } from '@beaver/agent-core/protocol/agentProtocol';
import { ClientIdentity, setClientIdentityProvider } from '@beaver/agent-core/transport/clientIdentity';
import { buildZoteroInstanceWire } from './zoteroInstanceWire';
import { isExternalRecordsEnabled } from './externalRecordsCapability';
import { extractSchemaVersionsDeclaration } from './documentExtraction/shared/extractionSchemaVersions';

/**
 * Features this build implements but withholds from the handshake until the
 * release opt-in. Withholding the declaration is the whole gate: the backend
 * offers the matching capabilities only to a client that declares them.
 */
const WITHHELD_FEATURES: string[] = isExternalRecordsEnabled() ? [] : [CLIENT_FEATURES.EXTERNAL_RECORDS];

function resolveZoteroClientIdentity(): ClientIdentity {
    const clientFeatures = ZOTERO_PLUGIN_FEATURES.filter((feature) => !WITHHELD_FEATURES.includes(feature));
    return {
        frontendVersion: Zotero.Beaver?.pluginVersion || '',
        clientType: ZOTERO_PLUGIN_CLIENT_TYPE,
        clientFeatures,
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
