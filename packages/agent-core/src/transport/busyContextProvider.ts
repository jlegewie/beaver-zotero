/**
 * Busy-context provider seam for outgoing WS request diagnostics.
 *
 * `agentService.ts` and `providerConnection.ts` attach a busy-context snapshot
 * to `timing` metadata and `request_received` acks so the backend can
 * attribute slow or timed-out requests to a busy client. This module only
 * knows the wire shape — a flat record of numbers, matching
 * `FrontendTimingMetadata`'s index signature and `WSRequestReceivedAck.busy`
 * (see `agentProtocol.ts`) — not the concrete field set, which is
 * Zotero/MuPDF-specific and lives with the implementation in `busyContext.ts`.
 *
 * A host registers a provider via `setBusyContextProvider()` at bundle init
 * (e.g. `registerZoteroBusyContext()` from `react/index.tsx`). Unlike
 * `clientIdentity.ts` / `agentDataDispatch.ts`, leaving this unregistered is
 * not a wiring bug: busy context is diagnostics, not something a correct
 * agent run depends on. A non-Zotero host that never registers one simply
 * sends no busy-context fields — `resolveBusyContext()` returns `{}` instead
 * of throwing.
 */

/** Resolves a busy-context snapshot. Called on every outgoing request/ack. */
export type BusyContextProvider = () => Record<string, number>;

let busyContextProvider: BusyContextProvider | null = null;

/**
 * Register the provider used to snapshot busy-context diagnostics. Call once
 * at bundle init (e.g. `registerZoteroBusyContext()` from `react/index.tsx`).
 * A non-Zotero host may skip registration entirely.
 */
export function setBusyContextProvider(provider: BusyContextProvider): void {
    busyContextProvider = provider;
}

/**
 * Resolve the current busy-context snapshot via the registered provider, or
 * `{}` when nothing is registered.
 */
export function resolveBusyContext(): Record<string, number> {
    return busyContextProvider ? busyContextProvider() : {};
}
