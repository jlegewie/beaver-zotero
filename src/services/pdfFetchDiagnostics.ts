/**
 * Records why a background PDF fetch failed.
 *
 * `Zotero.Attachments.downloadFirstAvailableFile` walks resolver entries and
 * reports progress only through callbacks. The tracker turns those callbacks
 * into one attempt per entry (the access method, the host where the outcome was
 * decided, and an outcome) plus a single failure reason for the whole task.
 *
 * Esbuild-safe: no `react/*` imports, no bare `addon`.
 */

/** Message of the error raised when the fetch budget elapses or the task is aborted. */
export const PDF_FETCH_CANCELLED_MESSAGE = 'PDF fetch cancelled or timed out';

/** Most attempts reported for one fetch. */
export const MAX_PDF_FETCH_ATTEMPTS = 12;

/**
 * Failure outcomes, most informative first. When several entries failed in
 * different ways the earliest item here is reported as the task's reason.
 * `bot_challenge` outranks `captcha_skipped`, so a host that served a challenge
 * is never reported as merely skipped.
 *
 * - `not_pdf`: an HTML page came back instead of the file, usually a paywall or
 *   access page.
 * - `no_pdf_found`: a page loaded but had no PDF link.
 * - `already_tried`: a DOI redirected to a page an earlier entry already tried,
 *   so Zotero skipped it. It is last so it never stands in for a real failure.
 *   Only a skip on the first hop from doi.org is detected; a skip further along
 *   a redirect chain still reads `no_pdf_found`.
 */
export const PDF_FAILURE_PRIORITY = [
    'bot_challenge',
    'captcha_skipped',
    'rate_limited',
    'forbidden',
    'not_pdf',
    'no_pdf_found',
    'not_found',
    'server_error',
    'http_error',
    'network_error',
    'cancelled',
    'error',
    'already_tried',
] as const;

export type PdfFailureOutcome = (typeof PDF_FAILURE_PRIORITY)[number];

/** What happened to one resolver entry. */
export type PdfFetchOutcome = 'ok' | PdfFailureOutcome;

/** One resolver entry Zotero tried. Never carries a full URL. */
export interface PdfFetchAttempt {
    accessMethod?: string;
    /**
     * Lowercase host of the entry's last request, where its outcome was decided:
     * usually the publisher after redirects; `doi.org` when the DOI itself failed
     * or its redirect was skipped.
     */
    host?: string;
    outcome: PdfFetchOutcome;
    /** HTTP status of the error that decided the outcome, when it had one. */
    status?: number;
}

/** Why the task failed: an attempt outcome or one of the task-level reasons. */
export type PdfFetchFailureReason =
    | PdfFailureOutcome
    | 'no_sources'
    | 'timeout'
    | 'unsupported_type'
    | 'no_attempts';

interface ClassifiedError {
    outcome: PdfFailureOutcome;
    status?: number;
}

/** The highest-priority error in `errors`, earliest first on ties. */
function mostInformative<T extends ClassifiedError>(errors: T[]): T | undefined {
    let best: T | undefined;
    for (const error of errors) {
        if (!best || PDF_FAILURE_PRIORITY.indexOf(error.outcome) < PDF_FAILURE_PRIORITY.indexOf(best.outcome)) {
            best = error;
        }
    }
    return best;
}

/** Read a response header from an XHR (`getResponseHeader`) or a fetch `Response` (`headers.get`). */
function readHeader(response: any, name: string): string {
    try {
        const value = typeof response?.getResponseHeader === 'function'
            ? response.getResponseHeader(name)
            : response?.headers?.get?.(name);
        return typeof value === 'string' ? value.toLowerCase() : '';
    } catch {
        return '';
    }
}

function isInstance(error: unknown, ctor: unknown): boolean {
    return typeof ctor === 'function' && error instanceof (ctor as new () => unknown);
}

/**
 * Map an error from a Zotero download or page request to an outcome.
 *
 * Matches by shape and message so it works without Zotero's exception classes:
 * those carry no `name`, and the hidden-browser fallback throws plain errors.
 */
export function classifyRequestError(error: unknown): ClassifiedError {
    const e = error as any;
    const message = String(e?.message ?? '');

    if (e?.name === 'ChallengeUrlSkipped') return { outcome: 'captcha_skipped' };
    if (message.startsWith('BrowserRequest:')) return { outcome: 'bot_challenge' };
    if (message === PDF_FETCH_CANCELLED_MESSAGE) return { outcome: 'cancelled' };

    const zotero = (globalThis as any).Zotero;
    if (isInstance(e, zotero?.Attachments?.InvalidPDFException)
        || /not a supported type/i.test(message)) {
        return { outcome: 'not_pdf' };
    }

    // Zotero reports a connection that never got a response (DNS, TLS, reset) as status 0.
    if (e?.status === 0 && e?.xmlhttp) return { outcome: 'network_error' };

    const status = typeof e?.status === 'number' && e.status > 0 ? e.status : undefined;
    if (status !== undefined) {
        const challenged = readHeader(e.xmlhttp, 'cf-mitigated').includes('challenge')
            || ((status === 403 || status === 503) && readHeader(e.xmlhttp, 'server').includes('cloudflare'));
        if (challenged) return { outcome: 'bot_challenge', status };
        if (status === 429) return { outcome: 'rate_limited', status };
        if (status === 401 || status === 403) return { outcome: 'forbidden', status };
        if (status === 404 || status === 410) return { outcome: 'not_found', status };
        if (status >= 500) return { outcome: 'server_error', status };
        return { outcome: 'http_error', status };
    }

    if (isInstance(e, zotero?.HTTP?.TimeoutException)
        || isInstance(e, zotero?.HTTP?.BrowserOfflineException)
        || /timed out|offline|NS_ERROR_|NetworkError|Failed to fetch/i.test(message)) {
        return { outcome: 'network_error' };
    }
    return { outcome: 'error' };
}

function hostOf(url: string): string | undefined {
    try {
        return new URL(url).host.toLowerCase() || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Host of the response an error carries: a fetch `Response` (`url`) or an XHR
 * (`responseURL`). Both are the final URL after redirects, which Zotero follows
 * without another `onBeforeRequest`.
 */
function responseHostOf(error: unknown): string | undefined {
    const response = (error as any)?.xmlhttp;
    try {
        const url = response?.responseURL || response?.url;
        return typeof url === 'string' && url ? hostOf(url) : undefined;
    } catch {
        return undefined;
    }
}

function isDoiResolverHost(host?: string): boolean {
    return host === 'doi.org' || host === 'dx.doi.org';
}

interface Entry {
    accessMethod?: string;
    host?: string;
    requests: number;
    /** Each error with the host of the request it belongs to. */
    errors: Array<ClassifiedError & { host?: string }>;
    /** Set once the entry's outcome is known beyond what its errors say. */
    final?: PdfFetchOutcome;
}

export interface PdfFetchDiagnostics {
    /** Hooks for `downloadFirstAvailableFile`; compose them with other hooks. */
    onAccessMethodStart(accessMethod?: string): void;
    onBeforeRequest(url: string): void;
    /** Records the error and returns false, so Zotero skips the URL rather than retrying. */
    onRequestError(error: unknown): false;
    /** The fetch budget elapsed. Later callbacks are ignored. */
    markTimeout(): void;
    /** The fetch was cancelled or abandoned. Later callbacks are ignored. */
    stop(): void;
    /** A file was downloaded by the latest entry. */
    markSucceeded(): void;
    /** The downloaded file's type cannot be attached. */
    markUnsupportedType(): void;
    /** Wire-ready attempts in order, capped at {@link MAX_PDF_FETCH_ATTEMPTS}. */
    attempts(): PdfFetchAttempt[];
    /**
     * Why the task failed.
     *
     * Checked in order: no resolvers (`resolverCount === 0`), budget timeout,
     * unsupported file type, a failure after the file was downloaded (`error`),
     * the highest-priority attempt outcome, then `error` if the task threw or
     * `no_attempts` if Zotero tried nothing. A throw before or after the
     * download therefore never borrows an attempt's reason. Leave
     * `resolverCount` undefined when resolvers were never built.
     */
    failureReason(state: { resolverCount?: number; threw: boolean }): PdfFetchFailureReason;
}

/** Create a tracker for one `downloadFirstAvailableFile` run. */
export function createPdfFetchDiagnostics(): PdfFetchDiagnostics {
    const entries: Entry[] = [];
    let timedOut = false;
    let stopped = false;
    let succeeded = false;
    let unsupportedType = false;

    const latest = (): Entry | undefined => entries[entries.length - 1];
    const startEntry = (accessMethod?: string): Entry => {
        const entry: Entry = { accessMethod, requests: 0, errors: [] };
        entries.push(entry);
        return entry;
    };

    // An entry can fail more than once (a page hop, then its file link; Zotero
    // also re-requests a refused redirect target), so it reports its most
    // informative error, with that error's status and host. An entry that made
    // requests without error and produced nothing is a page with no PDF link,
    // unless the run was cut off while it was in flight, or its last request
    // was the DOI resolver: doi.org almost always redirects or errors, so
    // ending there means Zotero skipped the redirect target as already tried.
    // Zotero gives no signal when it skips, so a skip after a second redirect
    // or a meta refresh ends on another host and still reads `no_pdf_found`,
    // and a DOI that doi.org answers with a page of its own (several registered
    // destinations) reads `already_tried`. Both are rare.
    const resolve = (): PdfFetchAttempt[] => entries
        .filter(entry => entry.requests > 0)
        .map((entry, index, tried) => {
            const worst = entry.final ? undefined : mostInformative(entry.errors);
            const outcome: PdfFetchOutcome = entry.final
                ?? worst?.outcome
                ?? (stopped && index === tried.length - 1 ? 'cancelled'
                    : isDoiResolverHost(entry.host) ? 'already_tried' : 'no_pdf_found');
            const host = worst?.host ?? entry.host;
            return {
                ...(entry.accessMethod ? { accessMethod: entry.accessMethod } : {}),
                ...(host ? { host } : {}),
                outcome,
                ...(worst?.status !== undefined ? { status: worst.status } : {}),
            };
        });

    return {
        onAccessMethodStart(accessMethod) {
            if (!stopped) startEntry(accessMethod);
        },
        onBeforeRequest(url) {
            if (stopped) return;
            const entry = latest() ?? startEntry();
            entry.requests++;
            // Requests within an entry are sequential, so the latest one is the
            // one an error or a missing file link belongs to.
            entry.host = hostOf(url) ?? entry.host;
        },
        onRequestError(error) {
            if (stopped) return false;
            const entry = latest() ?? startEntry();
            entry.errors.push({ ...classifyRequestError(error), host: responseHostOf(error) ?? entry.host });
            return false;
        },
        markTimeout() {
            timedOut = true;
            stopped = true;
        },
        stop() {
            stopped = true;
        },
        markSucceeded() {
            succeeded = true;
            const entry = latest();
            if (entry) entry.final = 'ok';
        },
        markUnsupportedType() {
            unsupportedType = true;
            const entry = latest();
            if (entry) entry.final = 'not_pdf';
        },
        attempts() {
            return resolve().slice(0, MAX_PDF_FETCH_ATTEMPTS);
        },
        failureReason({ resolverCount, threw }) {
            if (resolverCount === 0) return 'no_sources';
            if (timedOut) return 'timeout';
            if (unsupportedType) return 'unsupported_type';
            if (succeeded) return 'error';
            const outcomes = new Set(resolve().map(attempt => attempt.outcome));
            const reported = PDF_FAILURE_PRIORITY.find(outcome => outcomes.has(outcome));
            if (reported) return reported;
            return threw ? 'error' : 'no_attempts';
        },
    };
}
