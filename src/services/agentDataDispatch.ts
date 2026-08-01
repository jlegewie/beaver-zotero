/**
 * Agent data-request dispatch: client-agnostic interface + registry.
 *
 * Maps each backend data-request event to a handler plus the error-fallback
 * response sent when the handler throws (so the backend never times out).
 * `AgentService` looks requests up here instead of hardcoding a switch case per
 * request type, which makes the data layer injectable: the Zotero plugin
 * registers `createZoteroDataProvider()` (see `zoteroDataProvider.ts`) as the
 * default; a different host (e.g. a Word add-in) can register its own map
 * (e.g. forwarding requests to a local Zotero HTTP server) without touching
 * the WebSocket/streaming logic.
 *
 * This module must stay free of Zotero-specific imports so the transport
 * layer (`agentService.ts`, `providerConnection.ts`) can be used without
 * pulling in the full handler tree. The Zotero implementation lives in
 * `zoteroDataProvider.ts` and registers itself via `setDefaultAgentDataProvider`.
 *
 * Behavior note: entries marked `serialize` are chained onto the action
 * execution queue so concurrent mutating actions don't race.
 *
 * This module also owns the sync-pause owner tokens and resume seam
 * (`notifySyncPauseOwnerSettled`) that `providerConnection.ts` calls when a
 * mutating request settles — kept here rather than in the Zotero-only
 * `syncPause.ts` so the transport layer never has to import that module.
 */

import type { PreparedJsonMessage } from './preparedJsonMessage';

/** A single data-request handler plus its error-fallback response. */
export interface AgentDataRequestEntry {
    /** Run the request and resolve with the response object to send back. */
    handle: (event: any) => Promise<Record<string, any> | PreparedJsonMessage>;
    /** Build the response to send when `handle` rejects (keeps the backend from timing out). */
    errorResponse: (event: any, err: unknown) => Record<string, any>;
    /**
     * When true, the request is chained onto the serialized action-execution
     * queue (prevents concurrent mutating actions from racing).
     */
    serialize?: boolean;
    /**
     * Sync pause owner to release when this mutating request settles. An
     * opaque string token — typed as `string` here so this module doesn't need
     * to import the Zotero-only sync-pause implementation. See
     * `notifySyncPauseOwnerSettled` below for how a settled request reaches it.
     */
    syncPauseOwner?: string;
}

// =============================================================================
// Sync-pause owner tokens
// =============================================================================

/** Owner token used when a mutating run is dispatched by this client's own AgentService connection. */
export const LOCAL_MUTATING_RUN_SYNC_PAUSE_OWNER = 'local-mutating-run';
/** Owner token used when a mutating run is dispatched over a ProviderConnection (another client's run). */
export const PROVIDER_MUTATING_RUN_SYNC_PAUSE_OWNER = 'provider-mutating-run';

// =============================================================================
// Sync-pause resume seam
// =============================================================================

/**
 * Notified when a mutating data request settles, so a host can resume
 * whatever it paused (e.g. Zotero auto-sync) around the run.
 */
export type SyncPauseResumeHandler = (owner: string) => void;

let syncPauseResumeHandler: SyncPauseResumeHandler | null = null;

/**
 * Register the handler invoked when a mutating request's `syncPauseOwner`
 * settles. Call once at bundle init (e.g. `registerZoteroSyncPause()` from
 * `react/index.tsx`).
 *
 * Unlike `setDefaultAgentDataProvider`, leaving this unregistered is not a
 * wiring bug: sync suppression is a Zotero-only nicety, not something a
 * correct agent run depends on. A non-Zotero host that never registers one
 * simply has nothing to resume — `notifySyncPauseOwnerSettled` is then a
 * no-op instead of throwing.
 */
export function setSyncPauseResumeHandler(handler: SyncPauseResumeHandler): void {
    syncPauseResumeHandler = handler;
}

/**
 * Notify the registered handler that the mutating request owning `owner` has
 * settled. No-op when nothing is registered.
 */
export function notifySyncPauseOwnerSettled(owner: string): void {
    syncPauseResumeHandler?.(owner);
}

/** Map from backend request event name to its handler entry. */
export type AgentDataProviderMap = Record<string, AgentDataRequestEntry>;

/** Options accepted by a data-provider factory. */
export interface AgentDataProviderOptions {
    /** Owner token used for sync suppression around mutating actions. */
    syncPauseOwner?: string;
}

/** Builds a data-provider map for a host (e.g. the Zotero plugin). */
export type AgentDataProviderFactory = (options?: AgentDataProviderOptions) => AgentDataProviderMap;

let defaultAgentDataProviderFactory: AgentDataProviderFactory | null = null;

/**
 * Register the factory used to build the default data-provider map. Call once
 * at bundle init (e.g. `registerZoteroDataProvider()` from `react/index.tsx`),
 * before any `AgentService`/`ProviderConnection` singleton serves its first
 * data request. A non-Zotero host registers its own factory instead.
 */
export function setDefaultAgentDataProvider(factory: AgentDataProviderFactory): void {
    defaultAgentDataProviderFactory = factory;
}

/**
 * Resolve the default data-provider map via the registered factory.
 *
 * Throws if nothing has been registered yet — a caller reaching this without
 * registration is a wiring bug (the host forgot to call
 * `setDefaultAgentDataProvider` before the transport layer's first use), not a
 * recoverable runtime condition.
 */
export function resolveDefaultAgentDataProvider(options?: AgentDataProviderOptions): AgentDataProviderMap {
    if (!defaultAgentDataProviderFactory) {
        throw new Error(
            'No default agent data provider registered. Call setDefaultAgentDataProvider() ' +
            '(e.g. registerZoteroDataProvider() in react/index.tsx) before the first agent data request.'
        );
    }
    return defaultAgentDataProviderFactory(options);
}
