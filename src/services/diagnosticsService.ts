/**
 * Reports client-side WebSocket failures through a fresh HTTPS POST.
 * The POST both records structured backend telemetry and tells the caller
 * whether Beaver's regular API is reachable at failure time.
 *
 * The report is authenticated best-effort: a cached session token is attached
 * when one is available so the backend can associate the report with a user,
 * but a missing or stale token never blocks or delays the report — the backend
 * accepts it anonymously.
 */

import API_BASE_URL from '../utils/getAPIBaseURL';
import { logger } from '../utils/logger';
import { supabase } from './supabaseClient';
import { getZoteroUserIdentifier } from '../utils/zoteroUtils';
import { getLastBackendHttpSuccess, recordBackendHttpSuccess } from './backendReachability';
import {
    ConnectionDiagnosticResult,
    ConnectionFailureEvidence,
} from './connectionFailure';

const DIAGNOSTICS_ENDPOINT = '/api/v1/diagnostics/connection-failure';
const REPORT_TIMEOUT_MS = 8_000;
const AUTH_TOKEN_TIMEOUT_MS = 3_000;

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
    try {
        const timeout = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), AUTH_TOKEN_TIMEOUT_MS),
        );
        const result = await Promise.race([supabase.auth.getSession(), timeout]);
        return result?.data.session?.access_token ?? null;
    } catch {
        return null;
    }
}

export async function reportConnectionFailure(
    report: ConnectionFailureReport,
): Promise<ConnectionDiagnosticResult> {
    const startedAt = Date.now();
    if (!API_BASE_URL) {
        return { apiReachable: false, receivedHttpResponse: false, durationMs: 0 };
    }

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
