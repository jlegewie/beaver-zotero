/**
 * Reports client-side WebSocket failures through a fresh anonymous HTTPS POST.
 * The POST both records structured backend telemetry and tells the caller
 * whether Beaver's regular API is reachable at failure time.
 */

import API_BASE_URL from '../utils/getAPIBaseURL';
import { logger } from '../utils/logger';
import { getLastBackendHttpSuccess, recordBackendHttpSuccess } from './backendReachability';
import {
    ConnectionDiagnosticResult,
    ConnectionFailureEvidence,
} from './connectionFailure';

const DIAGNOSTICS_ENDPOINT = '/api/v1/diagnostics/connection-failure';
const REPORT_TIMEOUT_MS = 8_000;

export interface ConnectionFailureReport {
    evidence: ConnectionFailureEvidence;
    run_id?: string | null;
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
        run_id: report.run_id ?? null,
        plugin_version: pluginVersion,
        zotero_version: zoteroVersion,
        platform: nav?.platform ?? '',
        user_agent: nav?.userAgent ?? '',
        navigator_online: evidence.navigatorOnline,
        prior_backend_http_success_at: priorSuccess
            ? new Date(priorSuccess.at).toISOString()
            : null,
        prior_backend_http_success_source: priorSuccess?.source ?? null,
        prior_backend_http_success_age_ms: priorSuccess
            ? Math.max(0, startedAt - priorSuccess.at)
            : null,
        client_time: new Date().toISOString(),
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (pluginVersion) headers['X-Beaver-Version'] = pluginVersion;
    if (zoteroVersion) headers['X-Zotero-Version'] = zoteroVersion;

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
