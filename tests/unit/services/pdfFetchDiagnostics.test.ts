import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MAX_PDF_FETCH_ATTEMPTS,
    PDF_FAILURE_PRIORITY,
    PDF_FETCH_CANCELLED_MESSAGE,
    classifyRequestError,
    createPdfFetchDiagnostics,
} from '../../../src/services/pdfFetchDiagnostics';
import { ChallengeUrlSkipped } from '../../../src/utils/pdfChallengeUrls';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

/** Mimics Zotero.HTTP.UnexpectedStatusException with an XHR-style `xmlhttp`. */
function xhrStatusError(status: number, headers: Record<string, string> = {}) {
    return {
        message: `HTTP ${status}`,
        status,
        xmlhttp: { status, getResponseHeader: (name: string) => headers[name.toLowerCase()] ?? null },
    };
}

/** Same exception as thrown by `HTTP.download`, where `xmlhttp` is a fetch Response. */
function responseStatusError(status: number, headers: Record<string, string> = {}) {
    return { message: `HTTP ${status}`, status, xmlhttp: { status, headers: new Headers(headers) } };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('Zotero', {});
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('classifyRequestError', () => {
    it.each([
        ['an XHR response with cf-mitigated: challenge', xhrStatusError(403, { 'cf-mitigated': 'challenge' }), 'bot_challenge', 403],
        ['a fetch response with cf-mitigated: challenge', responseStatusError(403, { 'cf-mitigated': 'challenge' }), 'bot_challenge', 403],
        ['a 503 with cf-mitigated: challenge', xhrStatusError(503, { 'cf-mitigated': 'challenge' }), 'bot_challenge', 503],
        ['a 403 served by cloudflare', xhrStatusError(403, { server: 'cloudflare' }), 'bot_challenge', 403],
        ['a 503 served by cloudflare', responseStatusError(503, { server: 'cloudflare' }), 'bot_challenge', 503],
        ['a plain 403', xhrStatusError(403, { server: 'nginx' }), 'forbidden', 403],
        ['a 401', xhrStatusError(401), 'forbidden', 401],
        ['a 404', xhrStatusError(404), 'not_found', 404],
        ['a 410', responseStatusError(410), 'not_found', 410],
        ['a 429', xhrStatusError(429), 'rate_limited', 429],
        ['a 500', xhrStatusError(500), 'server_error', 500],
        ['a 503 that is not cloudflare', xhrStatusError(503), 'server_error', 503],
        ['a 418', xhrStatusError(418), 'http_error', 418],
    ])('classifies %s', (_label, error, outcome, status) => {
        expect(classifyRequestError(error)).toEqual({ outcome, status });
    });

    it('classifies an error without a response object by status alone', () => {
        expect(classifyRequestError({ message: 'x', status: 403 })).toEqual({ outcome: 'forbidden', status: 403 });
    });

    it('classifies a downloaded body that is not a PDF', () => {
        const error = new Error('Downloaded file was not a supported type (PDF or EPUB)');
        expect(classifyRequestError(error)).toEqual({ outcome: 'not_pdf' });
    });

    it('recognizes Zotero exception classes by instance when they exist', () => {
        function InvalidPDFException(this: any) { this.message = ''; }
        InvalidPDFException.prototype = Object.create(Error.prototype);
        function TimeoutException(this: any) { this.message = ''; }
        TimeoutException.prototype = Object.create(Error.prototype);
        vi.stubGlobal('Zotero', {
            Attachments: { InvalidPDFException },
            HTTP: { TimeoutException },
        });
        expect(classifyRequestError(new (InvalidPDFException as any)())).toEqual({ outcome: 'not_pdf' });
        expect(classifyRequestError(new (TimeoutException as any)())).toEqual({ outcome: 'network_error' });
    });

    it('classifies a skipped CAPTCHA URL', () => {
        expect(classifyRequestError(new ChallengeUrlSkipped('https://x.org/a'))).toEqual({ outcome: 'captcha_skipped' });
    });

    it('classifies a hidden-browser fallback failure as a bot challenge', () => {
        expect(classifyRequestError(new Error('BrowserRequest: page did not load'))).toEqual({ outcome: 'bot_challenge' });
    });

    it.each([
        ['a timeout', 'Request timed out after 30000 ms'],
        ['an offline browser', 'Request could not be completed because Zotero is offline'],
        ['a failed fetch', 'NS_ERROR_NET_RESET'],
    ])('classifies %s as a network error', (_label, message) => {
        expect(classifyRequestError(new Error(message))).toEqual({ outcome: 'network_error' });
    });

    it('classifies the budget and abort error as cancelled', () => {
        expect(classifyRequestError(new Error(PDF_FETCH_CANCELLED_MESSAGE))).toEqual({ outcome: 'cancelled' });
    });

    it.each([[new Error('boom')], [undefined], ['text']])('classifies the unknown error %s as error', (error) => {
        expect(classifyRequestError(error)).toEqual({ outcome: 'error' });
    });
});

describe('classifyRequestError for failed connections', () => {
    it('reports a status-0 exception as a network error, not a generic error', () => {
        expect(classifyRequestError(xhrStatusError(0))).toEqual({ outcome: 'network_error' });
    });
});

describe('attempt tracking', () => {
    it('reports a page that loads without yielding a file as no_pdf_found', () => {
        const diagnostics = createPdfFetchDiagnostics();
        diagnostics.onAccessMethodStart('doi');
        diagnostics.onBeforeRequest('https://doi.org/10.1/x');
        diagnostics.onBeforeRequest('https://Publisher.example/article?token=secret');
        expect(diagnostics.attempts()).toEqual([{ accessMethod: 'doi', host: 'publisher.example', outcome: 'no_pdf_found' }]);
    });

    it('attributes a DOI walk to the publisher host that refused the file, not doi.org', () => {
        const diagnostics = createPdfFetchDiagnostics();
        diagnostics.onAccessMethodStart('doi');
        diagnostics.onBeforeRequest('https://doi.org/10.1080/x');
        diagnostics.onBeforeRequest('https://www.tandfonline.com/doi/full/10.1080/x');
        diagnostics.onBeforeRequest('https://www.tandfonline.com/doi/pdf/10.1080/x');
        diagnostics.onRequestError(responseStatusError(403, { 'cf-mitigated': 'challenge' }));
        expect(diagnostics.attempts()).toEqual([
            { accessMethod: 'doi', host: 'www.tandfonline.com', outcome: 'bot_challenge', status: 403 },
        ]);
    });

    it('reports the refused download when the page loads but its file link is refused', () => {
        const diagnostics = createPdfFetchDiagnostics();
        diagnostics.onAccessMethodStart('url');
        diagnostics.onBeforeRequest('https://pub.example/article');
        diagnostics.onBeforeRequest('https://pub.example/file.pdf');
        diagnostics.onRequestError(xhrStatusError(403, { server: 'nginx' }));
        expect(diagnostics.attempts()).toEqual([
            { accessMethod: 'url', host: 'pub.example', outcome: 'forbidden', status: 403 },
        ]);
    });

    it('attributes a redirected download error to the host that answered', () => {
        const diagnostics = createPdfFetchDiagnostics();
        diagnostics.onAccessMethodStart('oa');
        diagnostics.onBeforeRequest('https://repository.example/file.pdf');
        diagnostics.onRequestError({
            ...responseStatusError(403, { server: 'nginx' }),
            url: 'https://repository.example/file.pdf',
            xmlhttp: { status: 403, headers: new Headers({ server: 'nginx' }), url: 'https://CDN.Publisher.example/x.pdf?sig=secret' },
        });
        expect(diagnostics.attempts()).toEqual([
            { accessMethod: 'oa', host: 'cdn.publisher.example', outcome: 'forbidden', status: 403 },
        ]);
    });

    it('attributes a redirected XHR error to its responseURL host', () => {
        const diagnostics = createPdfFetchDiagnostics();
        diagnostics.onAccessMethodStart('doi');
        diagnostics.onBeforeRequest('https://doi.org/10.1/x');
        diagnostics.onRequestError({
            ...xhrStatusError(404),
            xmlhttp: { status: 404, getResponseHeader: () => null, responseURL: 'https://pub.example/article' },
        });
        expect(diagnostics.attempts()).toEqual([
            { accessMethod: 'doi', host: 'pub.example', outcome: 'not_found', status: 404 },
        ]);
    });

    it('reports the most informative of several errors, with that error\'s own status', () => {
        const diagnostics = createPdfFetchDiagnostics();
        diagnostics.onAccessMethodStart('oa');
        diagnostics.onBeforeRequest('https://a.example/p');
        diagnostics.onRequestError(xhrStatusError(404));
        diagnostics.onBeforeRequest('https://a.example/f.pdf');
        diagnostics.onRequestError(new Error('Downloaded file was not a supported type (PDF or EPUB)'));
        expect(diagnostics.attempts()).toEqual([{ accessMethod: 'oa', host: 'a.example', outcome: 'not_pdf' }]);
    });

    it('does not let a later weaker error hide a bot challenge in the same entry', () => {
        const diagnostics = createPdfFetchDiagnostics();
        diagnostics.onAccessMethodStart('doi');
        diagnostics.onBeforeRequest('https://doi.org/10.1080/x');
        diagnostics.onBeforeRequest('https://www.tandfonline.com/doi/full/10.1080/x');
        diagnostics.onRequestError(xhrStatusError(403, { 'cf-mitigated': 'challenge' }));
        diagnostics.onBeforeRequest('https://cdn.example/x.pdf');
        diagnostics.onRequestError(new Error('Downloaded file was not a supported type (PDF or EPUB)'));
        expect(diagnostics.attempts()).toEqual([
            { accessMethod: 'doi', host: 'www.tandfonline.com', outcome: 'bot_challenge', status: 403 },
        ]);
    });

    it('does not ask Zotero to retry a failed request', () => {
        expect(createPdfFetchDiagnostics().onRequestError(new Error('x'))).toBe(false);
    });

    it('marks the winning entry ok after earlier entries failed', () => {
        const diagnostics = createPdfFetchDiagnostics();
        diagnostics.onAccessMethodStart('doi');
        diagnostics.onBeforeRequest('https://doi.org/x');
        diagnostics.onRequestError(xhrStatusError(403, { 'cf-mitigated': 'challenge' }));
        diagnostics.onAccessMethodStart('openalex');
        diagnostics.onBeforeRequest('https://oa.example/x.pdf');
        diagnostics.markSucceeded();
        expect(diagnostics.attempts()).toEqual([
            { accessMethod: 'doi', host: 'doi.org', outcome: 'bot_challenge', status: 403 },
            { accessMethod: 'openalex', host: 'oa.example', outcome: 'ok' },
        ]);
    });

    it('reports a downloaded file of an unsupported type as not_pdf', () => {
        const diagnostics = createPdfFetchDiagnostics();
        diagnostics.onAccessMethodStart('url');
        diagnostics.onBeforeRequest('https://a.example/x.zip');
        diagnostics.markSucceeded();
        diagnostics.markUnsupportedType();
        expect(diagnostics.attempts()).toEqual([{ accessMethod: 'url', host: 'a.example', outcome: 'not_pdf' }]);
    });

    it('omits the host for an unparseable URL', () => {
        const diagnostics = createPdfFetchDiagnostics();
        diagnostics.onAccessMethodStart('url');
        diagnostics.onBeforeRequest('not a url');
        diagnostics.onRequestError(new Error('x'));
        expect(diagnostics.attempts()).toEqual([{ accessMethod: 'url', outcome: 'error' }]);
    });

    it('never reports a full URL or query string', () => {
        const diagnostics = createPdfFetchDiagnostics();
        diagnostics.onAccessMethodStart('url');
        diagnostics.onBeforeRequest('https://Host.Example:8080/path/file.pdf?key=secret');
        const serialized = JSON.stringify(diagnostics.attempts());
        expect(serialized).toContain('host.example:8080');
        expect(serialized).not.toMatch(/secret|path|file\.pdf/);
    });

    it('ignores entries that never made a request', () => {
        const diagnostics = createPdfFetchDiagnostics();
        diagnostics.onAccessMethodStart('doi');
        expect(diagnostics.attempts()).toEqual([]);
    });

    it('caps the trail at the maximum number of attempts', () => {
        const diagnostics = createPdfFetchDiagnostics();
        for (let i = 0; i < MAX_PDF_FETCH_ATTEMPTS + 5; i++) {
            diagnostics.onAccessMethodStart(`m${i}`);
            diagnostics.onBeforeRequest(`https://h${i}.example/x`);
            diagnostics.onRequestError(xhrStatusError(404));
        }
        const attempts = diagnostics.attempts();
        expect(MAX_PDF_FETCH_ATTEMPTS).toBe(12);
        expect(attempts).toHaveLength(12);
        expect(attempts[0].accessMethod).toBe('m0');
    });

    it('reports the entry in flight at cancellation as cancelled and ignores later callbacks', () => {
        const diagnostics = createPdfFetchDiagnostics();
        diagnostics.onAccessMethodStart('doi');
        diagnostics.onBeforeRequest('https://doi.org/x');
        diagnostics.stop();
        diagnostics.onAccessMethodStart('oa');
        diagnostics.onBeforeRequest('https://oa.example/x');
        diagnostics.onRequestError(new Error(PDF_FETCH_CANCELLED_MESSAGE));
        expect(diagnostics.attempts()).toEqual([{ accessMethod: 'doi', host: 'doi.org', outcome: 'cancelled' }]);
    });
});

describe('failureReason', () => {
    const failed = (outcomes: Array<Error | object>) => {
        const diagnostics = createPdfFetchDiagnostics();
        outcomes.forEach((error, index) => {
            diagnostics.onAccessMethodStart(`m${index}`);
            diagnostics.onBeforeRequest(`https://h${index}.example/x`);
            diagnostics.onRequestError(error);
        });
        return diagnostics;
    };

    it('exposes the priority list with bot_challenge first and error last', () => {
        expect(PDF_FAILURE_PRIORITY[0]).toBe('bot_challenge');
        expect(PDF_FAILURE_PRIORITY[PDF_FAILURE_PRIORITY.length - 1]).toBe('error');
        expect(PDF_FAILURE_PRIORITY.indexOf('rate_limited')).toBeLessThan(PDF_FAILURE_PRIORITY.indexOf('forbidden'));
        expect(PDF_FAILURE_PRIORITY.indexOf('no_pdf_found')).toBeLessThan(PDF_FAILURE_PRIORITY.indexOf('not_found'));
    });

    it('reports no_sources when no resolvers were built', () => {
        expect(createPdfFetchDiagnostics().failureReason({ resolverCount: 0, threw: false })).toBe('no_sources');
    });

    it('does not report no_sources when the task failed before resolvers were built', () => {
        expect(createPdfFetchDiagnostics().failureReason({ threw: true })).toBe('error');
    });

    it('reports timeout over any attempt outcome', () => {
        const diagnostics = failed([xhrStatusError(403)]);
        diagnostics.markTimeout();
        expect(diagnostics.failureReason({ resolverCount: 2, threw: true })).toBe('timeout');
    });

    it('reports unsupported_type when the downloaded file cannot be attached', () => {
        const diagnostics = createPdfFetchDiagnostics();
        diagnostics.onAccessMethodStart('url');
        diagnostics.onBeforeRequest('https://a.example/x');
        diagnostics.markSucceeded();
        diagnostics.markUnsupportedType();
        expect(diagnostics.failureReason({ resolverCount: 1, threw: true })).toBe('unsupported_type');
    });

    it('reports error when a step after a successful download fails', () => {
        const diagnostics = failed([xhrStatusError(404)]);
        diagnostics.onAccessMethodStart('oa');
        diagnostics.onBeforeRequest('https://oa.example/x.pdf');
        diagnostics.markSucceeded();
        expect(diagnostics.failureReason({ resolverCount: 2, threw: true })).toBe('error');
    });

    it('reports no_attempts when Zotero tried nothing', () => {
        expect(createPdfFetchDiagnostics().failureReason({ resolverCount: 2, threw: false })).toBe('no_attempts');
    });

    it('reports error when the task threw without any attempt', () => {
        expect(createPdfFetchDiagnostics().failureReason({ resolverCount: 2, threw: true })).toBe('error');
    });

    it('prefers a bot challenge over a skipped CAPTCHA URL regardless of order', () => {
        const skipped = new ChallengeUrlSkipped('https://x.org');
        expect(failed([skipped, xhrStatusError(403, { 'cf-mitigated': 'challenge' })])
            .failureReason({ resolverCount: 2, threw: false })).toBe('bot_challenge');
        expect(failed([skipped, xhrStatusError(404)])
            .failureReason({ resolverCount: 2, threw: false })).toBe('captcha_skipped');
    });

    it.each([
        [[xhrStatusError(404), xhrStatusError(429), xhrStatusError(403)], 'rate_limited'],
        [[xhrStatusError(404), xhrStatusError(403)], 'forbidden'],
        [[xhrStatusError(500), new Error('Downloaded file was not a supported type (PDF or EPUB)')], 'not_pdf'],
        [[xhrStatusError(404), xhrStatusError(500)], 'not_found'],
        [[xhrStatusError(418), xhrStatusError(500)], 'server_error'],
        [[new Error('Request timed out'), xhrStatusError(418)], 'http_error'],
        [[new Error('boom'), new Error('Request timed out')], 'network_error'],
        [[new Error('boom')], 'error'],
    ])('reports the highest-priority outcome %#', (errors, expected) => {
        expect(failed(errors as any).failureReason({ resolverCount: 3, threw: false })).toBe(expected);
    });

    it('ranks a page without a PDF link above a 404', () => {
        const diagnostics = failed([xhrStatusError(404)]);
        diagnostics.onAccessMethodStart('doi');
        diagnostics.onBeforeRequest('https://doi.org/x');
        expect(diagnostics.failureReason({ resolverCount: 2, threw: false })).toBe('no_pdf_found');
    });
});
