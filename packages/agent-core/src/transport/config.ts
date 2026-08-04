/**
 * Backend endpoint configuration seam.
 *
 * Every host supplies its own values: some substitute them at build time, some
 * only know them at runtime (e.g. an add-in that derives the Supabase URL from
 * the page it is hosted in). The core therefore never reads build-time
 * configuration itself — it reads through this seam, and always at the point of
 * use rather than at module evaluation, so a host has until its first backend
 * request or Supabase client creation to register.
 *
 * That lazy read is what lets the module-level client singletons
 * (`agentService`, `threadService`, …) be constructed before registration:
 * construction captures no URL, each request resolves one.
 */

import { logger } from '../platform/logger';

export interface TransportConfig {
    /**
     * Absolute base URL of the backend, e.g. `https://api.example.com`. A host
     * served from the same origin as its backend registers that origin rather
     * than an empty string: the agent and provider sockets derive their address
     * from this value, and an empty one carries no host to connect to.
     */
    apiBaseUrl: string;
    supabaseUrl: string;
    supabaseAnonKey: string;
}

let config: TransportConfig | null = null;
let warnedUnregistered = false;
/** The Supabase values a client was created with, once one exists. */
let supabaseConfigInUse: { url: string; anonKey: string } | null = null;

/**
 * Register the backend configuration. Call once at host bundle init, before
 * the first backend request or Supabase client creation.
 *
 * Re-registering is last-wins and is normal: reloading a bundle creates a
 * fresh module instance, and the base URL is resolved per request so a host
 * may repoint it at any time. Changing the Supabase project after a client
 * exists is rejected instead — that client keeps the values it was created
 * with, so requests would go to one project carrying tokens minted for
 * another, and the resulting 401s are indistinguishable from an expired
 * session.
 */
export function setTransportConfig(next: TransportConfig): void {
    if (
        supabaseConfigInUse &&
        (next.supabaseUrl !== supabaseConfigInUse.url || next.supabaseAnonKey !== supabaseConfigInUse.anonKey)
    ) {
        throw new Error(
            'Supabase configuration cannot change once the Supabase client has been created.'
        );
    }
    config = next;
}

/** Whether a host has registered configuration. */
export function isTransportConfigRegistered(): boolean {
    return config !== null;
}

/**
 * Record the values a Supabase client was created with, so a later
 * registration that would strand it is rejected.
 */
export function markSupabaseConfigInUse(values: { url: string; anonKey: string }): void {
    supabaseConfigInUse = { ...values };
}

/**
 * The backend base URL, or '' when no host has registered one. Never throws:
 * the connection diagnostics path reads it precisely when the backend is
 * already unreachable.
 *
 * A host can also register an empty base URL, so a caller that needs to tell an
 * unconfigured backend from a configured one must ask
 * `isTransportConfigRegistered()` rather than test for emptiness.
 *
 * Only a missing registration warns, and only once.
 */
export function getApiBaseUrl(): string {
    if (!config) {
        if (!warnedUnregistered) {
            warnedUnregistered = true;
            logger(
                'No transport config registered; backend requests have no base URL. ' +
                'Call setTransportConfig() at bundle init.',
                2
            );
        }
        return '';
    }
    return config.apiBaseUrl || '';
}

/**
 * The Supabase project URL and anon key. Throws when unregistered or
 * incomplete: an auth client pointed at nothing fails in ways that surface far
 * from the missing wiring, so fail at the source instead.
 */
export function getSupabaseConfig(): { url: string; anonKey: string } {
    if (!config?.supabaseUrl || !config.supabaseAnonKey) {
        throw new Error(
            'No Supabase URL or anon key configured. Call setTransportConfig() ' +
            '(e.g. in react/index.tsx) before the Supabase client is first used.'
        );
    }
    return { url: config.supabaseUrl, anonKey: config.supabaseAnonKey };
}
