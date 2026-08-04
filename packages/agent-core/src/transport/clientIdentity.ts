/**
 * Client identity for WebSocket auth handshakes: the frontend version, client
 * type/features, and (for Zotero clients) the Zotero instance wire that
 * `providerConnection.ts` sends as the first message on every connection.
 *
 * A host registers a resolver via `setClientIdentityProvider()` at bundle init
 * (e.g. `registerZoteroClientIdentity()` from `react/index.tsx`), before the
 * transport layer opens its first connection. The resolver is called fresh on
 * every connect attempt rather than once — a Zotero install's searchable-
 * library set can change between an initial attempt and a later reconnect, so
 * the identity must reflect state at handshake-build time, not at connection
 * construction time.
 *
 * This module must stay free of Zotero-specific imports so the transport
 * layer can be used without pulling in the full Zotero app tree. The Zotero
 * implementation lives in `zoteroClientIdentity.ts` and registers itself via
 * `setClientIdentityProvider`.
 */

import type { ZoteroInstanceWire } from '../protocol/agentProtocol';

/** Handshake identity fields resolved fresh for each connect attempt. */
export interface ClientIdentity {
    /** Sent as `WSAuthMessage.frontend_version`. */
    frontendVersion: string;
    /** Sent as `WSAuthMessage.client_type` (e.g. 'zotero-plugin'). */
    clientType: string;
    /** Sent as `WSAuthMessage.client_features`. */
    clientFeatures: string[];
    /**
     * Sent as `WSAuthMessage.zotero_instance`. Optional because non-Zotero
     * clients (e.g. the Word add-in) have no Zotero install to identify.
     */
    zoteroInstance?: ZoteroInstanceWire;
}

/** Resolves the current client identity. Called fresh on every connect attempt. */
export type ClientIdentityProvider = () => ClientIdentity;

let clientIdentityProvider: ClientIdentityProvider | null = null;

/**
 * Register the provider used to resolve client identity for auth handshakes.
 * Call once at bundle init (e.g. `registerZoteroClientIdentity()` from
 * `react/index.tsx`), before the `ProviderConnection` singleton opens its
 * first connection. A non-Zotero host registers its own provider.
 */
export function setClientIdentityProvider(provider: ClientIdentityProvider): void {
    clientIdentityProvider = provider;
}

/**
 * Resolve the current client identity via the registered provider.
 *
 * Throws if nothing has been registered yet — a caller reaching this without
 * registration is a wiring bug (the host forgot to call
 * `setClientIdentityProvider` before the transport layer's first connect
 * attempt), not a recoverable runtime condition. Degrading to an empty/default
 * identity instead would let a misconfigured handshake reach the backend and
 * be silently accepted with the wrong client scope (e.g. treated as an
 * anonymous or wrongly-typed client) rather than failing loudly at the source.
 */
export function resolveClientIdentity(): ClientIdentity {
    if (!clientIdentityProvider) {
        throw new Error(
            'No client identity provider registered. Call setClientIdentityProvider() ' +
            '(e.g. registerZoteroClientIdentity() in react/index.tsx) before the first connect attempt.'
        );
    }
    return clientIdentityProvider();
}
