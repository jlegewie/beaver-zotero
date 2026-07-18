/**
 * Diagnostics service
 *
 * Reports client-side WebSocket connection failures to the backend via
 * a plain HTTPS POST. Fire-and-forget — nothing on the client depends
 * on the result. Users who reach this code path are already
 * authenticated (they've been using the app), so plain HTTPS is known
 * to work and the failure is inherently WebSocket-specific.
 *
 * Reports are anonymous by design: no auth token is attached, so this
 * path never touches the Supabase session (whose lookups can block on a
 * token refresh — exactly what must not happen right after a network
 * failure). The `run_id` allows correlation with a user's support
 * request when they share it.
 *
 * ---------------------------------------------------------------------------
 * Backend endpoint contract
 * ---------------------------------------------------------------------------
 * Method: POST
 * Path:   /api/v1/diagnostics/connection-failure
 * Auth:   None. Reports are accepted anonymously.
 * Rate:   Rate-limit server-side by (IP + close_code) at your discretion.
 *
 * Request body (JSON):
 *   {
 *     "phase":            "connect" | "mid_run",   // where in the run lifecycle
 *     "close_code":       number | null,           // WebSocket close code (RFC 6455)
 *     "close_reason":     string,                  // may be empty
 *     "was_clean":        boolean | null,          // WebSocket close event `wasClean`
 *     "run_id":           string | null,           // UUID for correlation, non-PII
 *     "plugin_version":   string,                  // e.g. "0.22.1"
 *     "zotero_version":   string,                  // e.g. "7.0.14" (may be empty)
 *     "platform":         string,                  // navigator.platform (may be empty)
 *     "user_agent":       string,                  // navigator.userAgent (may be empty)
 *     "navigator_online": boolean,                 // navigator.onLine at report time
 *     "client_time":      string                   // ISO-8601 UTC
 *   }
 *
 * Response body: anything 2xx. The client does not read it.
 *
 * Privacy: intentionally omits everything user-identifying. No chat
 * content, no library data, no message text, no URLs. IP is already
 * implicit in the request.
 * ---------------------------------------------------------------------------
 */

import API_BASE_URL from '../utils/getAPIBaseURL';
import { logger } from '../utils/logger';

const DIAGNOSTICS_ENDPOINT = '/api/v1/diagnostics/connection-failure';

/** How long to wait for the diagnostics POST before giving up. */
const REPORT_TIMEOUT_MS = 8_000;

export interface ConnectionFailureReport {
    /** Where in the run lifecycle the failure occurred. */
    phase: 'connect' | 'mid_run';
    /** WebSocket close code (RFC 6455) or null if unknown. */
    close_code: number | null;
    /** WebSocket close reason (may be empty). */
    close_reason: string;
    /** WebSocket close event `wasClean`. */
    was_clean: boolean | null;
    /** UUID of the run this failure relates to (non-PII). */
    run_id?: string | null;
}

/**
 * Fire the connection-failure report to the backend. Never throws.
 * Fire-and-forget: callers should not await for correctness — the UI
 * has already surfaced the error by the time this runs.
 */
export async function reportConnectionFailure(report: ConnectionFailureReport): Promise<void> {
    if (!API_BASE_URL) return;

    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const pluginVersion =
        (typeof Zotero !== 'undefined' && Zotero.Beaver?.pluginVersion) || '';
    const zoteroVersion =
        (typeof Zotero !== 'undefined' && typeof Zotero.version === 'string' && Zotero.version) ||
        '';

    const body: Record<string, unknown> = {
        phase: report.phase,
        close_code: report.close_code,
        close_reason: report.close_reason ?? '',
        was_clean: report.was_clean,
        run_id: report.run_id ?? null,
        plugin_version: pluginVersion,
        zotero_version: zoteroVersion,
        platform: nav?.platform ?? '',
        user_agent: nav?.userAgent ?? '',
        navigator_online: nav?.onLine ?? true,
        client_time: new Date().toISOString(),
    };

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (pluginVersion) headers['X-Beaver-Version'] = pluginVersion;
    if (zoteroVersion) headers['X-Zotero-Version'] = zoteroVersion;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);

    try {
        await fetch(`${API_BASE_URL}${DIAGNOSTICS_ENDPOINT}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (error) {
        logger(`DiagnosticsService: connection-failure report failed: ${error}`, 1);
    } finally {
        clearTimeout(timeoutId);
    }
}
