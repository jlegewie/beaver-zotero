/**
 * Usage telemetry for file exports: what was exported, from where, and how it
 * went — never the content. Best-effort and fire-and-forget: a report that
 * cannot be sent (offline, signed out) is dropped and never affects the export.
 */

import { ApiService } from '@beaver/agent-core/transport/apiService';
import { logger } from '@beaver/agent-core/platform/logger';
import type { ExportSourceKind, ExportWarning } from '@beaver/agent-export/types';
import { parseCreatedFooter, parseEditFooter } from '../../utils/noteEditFooter';

/** Where an export was started. */
export type ExportSurface =
    | 'run_artifacts'
    | 'note_card'
    | 'note_editor'
    | 'item_menu'
    | 'message_menu'
    | 'thread_menu';

/** Whether Beaver created a note, only edited it, or neither. */
export type NoteOrigin = 'created' | 'edited' | 'user';

export interface ExportReport {
    kind: ExportSourceKind;
    format: string;
    outcome: 'saved' | 'failed';
    surface?: ExportSurface;
    note_origin?: NoteOrigin;
    /** The note was gone, so the version Beaver wrote was exported. */
    note_fallback?: boolean;
    citation_count?: number;
    bibliography_entries?: number;
    warning_codes?: string[];
    error_code?: string;
    duration_ms?: number;
}

const EXPORT_ENDPOINT = '/api/v1/diagnostics/export';
const REPORT_TIMEOUT_MS = 8_000;
/** The backend accepts lowercase identifiers only. */
const LABEL = /^[a-z][a-z0-9_]{0,31}$/;

class ExportTelemetryClient extends ApiService {
    send(report: ExportReport): Promise<unknown> {
        return this.post(EXPORT_ENDPOINT, report, { timeoutMs: REPORT_TIMEOUT_MS });
    }
}

let client: ExportTelemetryClient | null = null;

/** Who wrote a note, read from Beaver's provenance lines in its HTML. */
export function noteOriginFromHtml(html: string): NoteOrigin {
    if (parseCreatedFooter(html)) return 'created';
    if (parseEditFooter(html)) return 'edited';
    return 'user';
}

/** Distinct warning codes, in the form the backend accepts. */
export function exportWarningCodes(warnings: ExportWarning[]): string[] {
    return [...new Set(warnings.map(warning => warning.code))].filter(code => LABEL.test(code)).slice(0, 16);
}

/** An error's code when it carries one the backend accepts. */
export function exportErrorCode(error: unknown): string | undefined {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && LABEL.test(code) ? code : undefined;
}

/** Send an export report in the background. */
export function reportExport(report: ExportReport): void {
    try {
        client ??= new ExportTelemetryClient();
        client.send(report).catch((error: unknown) => {
            logger(`ExportTelemetry: report not sent: ${error}`, 4);
        });
    } catch (error) {
        logger(`ExportTelemetry: report not sent: ${error}`, 4);
    }
}
