/**
 * A short, in-memory record of what happened to the saved sign-in: storage
 * reads and removals, refresh failures and how each startup restore ended.
 *
 * It answers "why was I signed out?" from an error report without asking the
 * user for debug output. Owned by the plugin realm; renderers read it through
 * `Zotero.Beaver.account.getAuthDiagnostics()` rather than importing this
 * module, which would give each window bundle its own empty copy.
 *
 * Entries must never contain tokens or other credentials.
 */

import { logger } from '@beaver/agent-core/platform/logger';

export interface AuthDiagnosticEntry {
    /** When the event first happened (ISO 8601). */
    at: string;
    event: string;
    detail?: string;
    /** How many consecutive times the same event and detail were recorded. */
    count: number;
    /** When it last repeated, for entries with `count > 1`. */
    lastAt?: string;
}

const MAX_ENTRIES = 50;
const MAX_DETAIL_LENGTH = 300;

let entries: AuthDiagnosticEntry[] = [];

/**
 * Record an auth event. A repeat of the previous event with the same detail
 * increments its count instead of adding an entry, so a periodic read of an
 * empty store cannot push out the events that explain it.
 */
export function recordAuthDiagnostic(event: string, detail?: string): void {
    const trimmed = detail === undefined ? undefined : detail.slice(0, MAX_DETAIL_LENGTH);
    const now = new Date().toISOString();
    const last = entries[entries.length - 1];
    if (last && last.event === event && last.detail === trimmed) {
        last.count++;
        last.lastAt = now;
        return;
    }
    try {
        logger(`Auth diagnostics: ${event}${trimmed ? ` (${trimmed})` : ''}`);
    } catch {
        // Recording runs inside auth and storage callbacks; logging must not break them.
    }
    entries.push({ at: now, event, ...(trimmed === undefined ? {} : { detail: trimmed }), count: 1 });
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
}

/** A copy of the recorded events, oldest first. */
export function getAuthDiagnostics(): AuthDiagnosticEntry[] {
    return entries.map((entry) => ({ ...entry }));
}

/** Describe an auth error by class, status and message, without credentials. */
export function describeAuthError(error: unknown): string {
    if (!error || typeof error !== 'object') return String(error);
    const e = error as { name?: unknown; status?: unknown; code?: unknown; message?: unknown };
    const name = typeof e.name === 'string' ? e.name : 'Error';
    const status = typeof e.status === 'number' && e.status > 0 ? ` ${e.status}` : '';
    const code = typeof e.code === 'string' ? ` [${e.code}]` : '';
    const message = typeof e.message === 'string' ? `: ${e.message}` : '';
    return `${name}${status}${code}${message}`;
}

/**
 * The function names at the top of a stack, joined, so a removal can be traced
 * to the code that asked for it without recording file paths.
 */
export function summarizeStack(stack: string | undefined, frames = 8): string {
    if (!stack) return '';
    return stack
        .split('\n')
        .map((line) => {
            const frame = line.trim();
            // V8: `at name (url:line:col)`; `at url:line:col` is anonymous.
            if (/^at\s/.test(frame)) {
                const v8 = /^at\s+(?:async\s+)?([^\s(]+)\s+\(/.exec(frame);
                return v8 ? v8[1] : '';
            }
            // SpiderMonkey: `name@url:line:col`; anonymous frames have no name.
            // The name may itself contain `@` and `/`: bundlers name closures
            // after their module path (`node_modules/@scope/pkg/file.js/fn/<`),
            // so split at the `@` that starts the URL and keep the last segment.
            const url = /@(?:[a-z][a-z0-9+.-]*:|\/)[^@]*$/i.exec(frame);
            if (!url) return '';
            const segments = frame
                .slice(0, url.index)
                .split('/')
                .map((segment) => segment.replace(/^<\.?/, ''))
                .filter(Boolean);
            return segments[segments.length - 1] ?? '';
        })
        .filter(Boolean)
        .slice(0, frames)
        .join(' < ');
}

/** Clear the log. Tests only. */
export function resetAuthDiagnosticsForTesting(): void {
    entries = [];
}
