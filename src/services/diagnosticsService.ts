/**
 * Reports client-side WebSocket failures through a fresh HTTPS POST.
 * The POST both records structured backend telemetry and tells the caller
 * whether Beaver's regular API is reachable at failure time.
 *
 * The report is authenticated best-effort: a cached session token is attached
 * when one is available so the backend can associate the report with a user,
 * but a missing or stale token never blocks or delays the report — the backend
 * accepts it anonymously.
 *
 * Reports are coalesced and throttled: repeated failures within the same
 * outage add no new diagnostic information, so a call made while a report is
 * already in flight reuses that in-flight result, and a call made shortly
 * after the last report completed reuses its result instead of firing a new
 * POST plus auth lookup.
 */

import API_BASE_URL from '../utils/getAPIBaseURL';
import { logger } from '../utils/logger';
import { supabase } from './supabaseClient';
import { getZoteroUserIdentifier } from '../utils/zoteroUtils';
import { getLastBackendHttpSuccess, recordBackendHttpSuccess } from './backendReachability';
import {
    ConnectionDiagnosticResult,
    ConnectionFailureEvidence,
    presentConnectionFailure,
} from './connectionFailure';

const DIAGNOSTICS_ENDPOINT = '/api/v1/diagnostics/connection-failure';
const REPORT_TIMEOUT_MS = 8_000;
const AUTH_TOKEN_TIMEOUT_MS = 3_000;

/** Minimum time between two real reports; calls within this window of the last completed report reuse its result. */
const REPORT_COOLDOWN_MS = 30_000;

/** The currently running report, shared by any calls that arrive while it is in flight. */
let inFlightReport: Promise<ConnectionDiagnosticResult> | null = null;
/** The most recently completed report, reused while still within REPORT_COOLDOWN_MS. */
let lastReport: { at: number; result: ConnectionDiagnosticResult } | null = null;

export interface ConnectionFailureReport {
    evidence: ConnectionFailureEvidence;
    run_id?: string | null;
}

/**
 * Read the cached session token without letting a hung auth stack delay the
 * report. getSession() is normally a local read; the race guards against the
 * auto-refresh path stalling on the same broken network we are reporting on.
 */
async function getAuthTokenBestEffort(): Promise<string | null> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
        const timeout = new Promise<null>((resolve) => {
            timeoutId = setTimeout(() => resolve(null), AUTH_TOKEN_TIMEOUT_MS);
        });
        const result = await Promise.race([supabase.auth.getSession(), timeout]);
        return result?.data.session?.access_token ?? null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Builds and sends the diagnostic POST. Always resolves — network and auth
 * failures are caught and turned into an unreachable result rather than a
 * rejection — so `reportConnectionFailure` can safely share and cache it.
 */
async function executeReport(
    report: ConnectionFailureReport,
): Promise<ConnectionDiagnosticResult> {
    const startedAt = Date.now();
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const pluginVersion =
        (typeof Zotero !== 'undefined' && Zotero.Beaver?.pluginVersion) || '';
    const zoteroVersion =
        (typeof Zotero !== 'undefined' && typeof Zotero.version === 'string' && Zotero.version) ||
        '';
    const priorSuccess = getLastBackendHttpSuccess();
    const { evidence } = report;

    // Zotero instance identity (per-install local key, plus the Zotero account
    // id when sync is enabled) so repeated failures from the same install can
    // be grouped even when the report arrives anonymously.
    let zoteroLocalId: string | null = null;
    let zoteroUserId: string | null = null;
    try {
        const identity = getZoteroUserIdentifier();
        zoteroLocalId = identity.localUserKey || null;
        zoteroUserId = identity.userID != null ? String(identity.userID) : null;
    } catch {
        // Identity lookup must never block a failure report.
    }

    // What the user was shown when the failure surfaced. This is the initial
    // presentation, computed without a reachability diagnostic — the refined
    // message depends on this report's own outcome, so it cannot be included.
    // Details are flattened to plain text: the renderer-facing markup (the
    // troubleshooting link) carries no telemetry value.
    const presentation = presentConnectionFailure(evidence);
    const userDetails = presentation.details
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const body: Record<string, unknown> = {
        // Preserve the original coarse fields for older backend deployments.
        phase: evidence.stage === 'mid_run' ? 'mid_run' : 'connect',
        stage: evidence.stage,
        close_code: evidence.closeCode,
        close_reason: evidence.closeReason,
        was_clean: evidence.wasClean,
        socket_opened: evidence.socketOpened,
        ready_received: evidence.readyReceived,
        timed_out: evidence.timedOut,
        error_name: evidence.errorName ?? null,
        ws_uptime_ms: evidence.wsUptimeMs ?? null,
        ms_since_last_ws_message_ms: evidence.msSinceLastWsMessageMs ?? null,
        run_id: report.run_id ?? null,
        plugin_version: pluginVersion,
        zotero_version: zoteroVersion,
        platform: nav?.platform ?? '',
        user_agent: nav?.userAgent ?? '',
        navigator_online: evidence.navigatorOnline,
        zotero_local_id: zoteroLocalId,
        zotero_user_id: zoteroUserId,
        prior_backend_http_success_at: priorSuccess
            ? new Date(priorSuccess.at).toISOString()
            : null,
        prior_backend_http_success_source: priorSuccess?.source.slice(0, 64) ?? null,
        prior_backend_http_success_age_ms: priorSuccess
            ? Math.max(0, startedAt - priorSuccess.at)
            : null,
        client_time: new Date().toISOString(),
        user_message: presentation.message.slice(0, 200),
        user_details: userDetails.slice(0, 600),
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (pluginVersion) headers['X-Beaver-Version'] = pluginVersion;
    if (zoteroVersion) headers['X-Zotero-Version'] = zoteroVersion;
    const token = await getAuthTokenBestEffort();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);

    try {
        const response = await fetch(`${API_BASE_URL}${DIAGNOSTICS_ENDPOINT}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (response.ok) recordBackendHttpSuccess('connection_diagnostic');
        return {
            apiReachable: response.ok,
            receivedHttpResponse: true,
            status: response.status,
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        logger(`DiagnosticsService: connection-failure report failed: ${error}`, 1);
        return {
            apiReachable: false,
            receivedHttpResponse: false,
            durationMs: Date.now() - startedAt,
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

export async function reportConnectionFailure(
    report: ConnectionFailureReport,
): Promise<ConnectionDiagnosticResult> {
    if (!API_BASE_URL) {
        return { apiReachable: false, receivedHttpResponse: false, durationMs: 0 };
    }

    // Offline is a known, immediate cause: skip the auth lookup and POST
    // entirely, and don't cache the result, so the next call (e.g. once the
    // OS reports back online) runs a real report rather than reusing this one.
    if (report.evidence.navigatorOnline === false) {
        return { apiReachable: false, receivedHttpResponse: false, durationMs: 0 };
    }

    if (inFlightReport) return inFlightReport;
    // Only an unreachable verdict is reused during the cooldown: it covers the
    // persistent-outage case where repeated probes would spam identical
    // reports. A cached reachable verdict is never reused — the network may
    // have degraded since, and presenting a stale "API is reachable" for a
    // new failure would misdirect the user — so a fresh probe runs instead.
    if (
        lastReport &&
        !lastReport.result.apiReachable &&
        Date.now() - lastReport.at < REPORT_COOLDOWN_MS
    ) {
        return lastReport.result;
    }

    const promise = executeReport(report)
        .then((result) => {
            lastReport = { at: Date.now(), result };
            return result;
        })
        .finally(() => {
            // Cleared unconditionally so a promise that rejects unexpectedly
            // (executeReport is not expected to) can never wedge the guard.
            inFlightReport = null;
        });
    inFlightReport = promise;
    return promise;
}

/**
 * Test-only: clears the in-flight and cooldown state tracked by
 * `reportConnectionFailure` so each test starts from a clean slate.
 */
export function clearConnectionFailureReportState(): void {
    inFlightReport = null;
    lastReport = null;
}
