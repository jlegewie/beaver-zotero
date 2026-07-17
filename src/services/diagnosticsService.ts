/**
 * Diagnostics service
 *
 * Reports client-side connection failures to the backend via a plain
 * HTTPS POST. Dual purpose:
 *  1. Backend learns about connection-failure patterns in the wild
 *     (close codes, phase, platform) without needing WebSocket to
 *     succeed first.
 *  2. The success/failure of *this* HTTPS call itself is a diagnostic
 *     signal — it tells us whether the network is blocking Beaver
 *     entirely, or only blocking WebSocket traffic specifically. The
 *     result is used to refine the error message shown to the user.
 *
 * ---------------------------------------------------------------------------
 * Backend endpoint contract
 * ---------------------------------------------------------------------------
 * Method: POST
 * Path:   /api/v1/diagnostics/connection-failure
 * Auth:   OPTIONAL Bearer token. If provided and valid, associate the
 *         report with the user. If missing/invalid, accept anonymously —
 *         connection failures may prevent Supabase from issuing a fresh
 *         token, so requiring auth would drop the reports we most want.
 * Rate:   Recommend server-side rate-limiting by (IP + close_code) to
 *         cap volume from a single misconfigured network. Do not gate
 *         the response on the rate limit — clients should still see a
 *         2xx so the client can conclude "HTTPS works". Silent drops
 *         on the server side are fine; the client only needs to know
 *         that the HTTP request round-tripped.
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
 * Response body (JSON):
 *   { "received": true }
 *
 * Any 2xx response counts as "HTTPS succeeded" for the client's
 * subsequent message refinement. Any network error, timeout, or
 * non-2xx status counts as "HTTPS failed".
 *
 * Privacy: intentionally omits everything user-identifying beyond what
 * the optional bearer token conveys. No chat content, no library data,
 * no message text, no URLs. IP is already implicit in the request.
 * ---------------------------------------------------------------------------
 */

import API_BASE_URL from '../utils/getAPIBaseURL';
import { supabase } from './supabaseClient';
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

export interface ConnectionFailureReportResult {
    /**
     * Whether the HTTPS POST itself succeeded. Signals that the network
     * is not blocking Beaver globally; only WebSocket traffic is
     * blocked. Used to refine the user-facing error message.
     */
    httpsReachable: boolean;
    /** HTTP status if we got a response, undefined on network error. */
    status?: number;
}

/**
 * Attempt to grab an auth token synchronously from the Supabase
 * session cache. Never triggers a refresh — a network issue that
 * caused the WebSocket to fail could hang a refresh call.
 */
async function getBestEffortAuthToken(): Promise<string | undefined> {
    try {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Fire the connection-failure report to the backend. Never throws.
 * Always resolves within REPORT_TIMEOUT_MS with a result the caller
 * can use to refine the message shown to the user.
 */
export async function reportConnectionFailure(
    report: ConnectionFailureReport,
): Promise<ConnectionFailureReportResult> {
    if (!API_BASE_URL) {
        return { httpsReachable: false };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);

    try {
        const token = await getBestEffortAuthToken();

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
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await fetch(`${API_BASE_URL}${DIAGNOSTICS_ENDPOINT}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        return { httpsReachable: response.ok, status: response.status };
    } catch (error) {
        logger(`DiagnosticsService: connection-failure report failed: ${error}`, 1);
        return { httpsReachable: false };
    } finally {
        clearTimeout(timeoutId);
    }
}
