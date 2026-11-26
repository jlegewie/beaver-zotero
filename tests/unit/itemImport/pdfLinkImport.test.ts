import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const mocks = vi.hoisted(() => ({
    checkUrlAllowed: vi.fn(),
    isLoadableHost: vi.fn(),
    discardDownloadedFile: vi.fn(),
}));

vi.mock('../../../src/services/itemImport/resolveUrl', () => ({
    checkUrlAllowed: mocks.checkUrlAllowed,
    isLoadableHost: mocks.isLoadableHost,
    isPrivateAddress: (address: string) => /^(10\.|127\.|192\.168\.)/.test(address),
}));
vi.mock('../../../src/services/pdfAttachmentFetch', () => ({ discardDownloadedFile: mocks.discardDownloadedFile }));
vi.mock('../../../src/services/itemImport/zoteroApis', () => ({
    pluginTimers: () => ({ setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) }),
}));

import {
    downloadPdfLink,
    looksLikePdfBytes,
    pdfFilename,
    PDF_LINK_MAX_BYTES,
    ResolvedPdfStore,
} from '../../../src/services/itemImport/pdfLinkImport';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n...');

/** A fake XHR the mocked `Zotero.HTTP.request` hands to its observer. */
function fakeRequest(options: { status?: number; body?: Uint8Array; headers?: Record<string, string>; remoteAddress?: string; responseURL?: string }) {
    const listeners: Record<string, Array<(event?: any) => void>> = {};
    return {
        readyState: 0,
        status: options.status ?? 200,
        response: (options.body ?? PDF_BYTES).buffer,
        responseURL: options.responseURL ?? '',
        channel: { QueryInterface: () => ({ remoteAddress: options.remoteAddress ?? '93.184.216.34' }) },
        getResponseHeader: (name: string) => options.headers?.[name] ?? null,
        addEventListener: (type: string, listener: (event?: any) => void) => {
            (listeners[type] ??= []).push(listener);
        },
        fire(type: string, event?: any) {
            for (const listener of listeners[type] ?? []) listener(event);
        },
    };
}

type RequestOptions = Record<string, any>;

function mockHttp(behave: (options: RequestOptions, request: ReturnType<typeof fakeRequest>) => Promise<unknown> | unknown, request = fakeRequest({})) {
    (Zotero as any).HTTP = {
        TimeoutException: class extends Error {},
        request: vi.fn(async (_method: string, _url: string, options: RequestOptions) => {
            options.requestObserver?.(request);
            return behave(options, request);
        }),
    };
    return request;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkUrlAllowed.mockResolvedValue({ ok: true, parsed: new URL('https://example.org/a.pdf') });
    mocks.isLoadableHost.mockResolvedValue(true);
    (Zotero as any).Attachments = { createTemporaryStorageDirectory: vi.fn(async () => ({ path: '/tmp/beaver-pdf' })) };
    (globalThis as any).PathUtils = { join: (...parts: string[]) => parts.join('/') };
    (globalThis as any).IOUtils = { write: vi.fn(async () => undefined) };
    (globalThis as any).Components = {
        interfaces: { nsIHttpChannelInternal: {} },
        results: { NS_OK: 0, NS_BINDING_ABORTED: 0x804b0002 },
    };
});

describe('pdfFilename', () => {
    it('prefers Content-Disposition, then the URL path, and always ends in .pdf', () => {
        expect(pdfFilename('https://x.org/a/report.pdf', 'attachment; filename="WHO report.pdf"')).toBe('WHO report.pdf');
        expect(pdfFilename('https://x.org/a/report.pdf', "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")).toBe('résumé.pdf');
        expect(pdfFilename('https://x.org/bitstreams/123/content', null)).toBe('content.pdf');
        expect(pdfFilename('https://x.org/', null)).toBe('document.pdf');
    });
});

describe('looksLikePdfBytes', () => {
    it('accepts a PDF header, also after leading junk, and rejects a page', () => {
        expect(looksLikePdfBytes(PDF_BYTES)).toBe(true);
        expect(looksLikePdfBytes(new TextEncoder().encode('\n\n%PDF-1.4'))).toBe(true);
        expect(looksLikePdfBytes(new TextEncoder().encode('<!doctype html><title>x</title>'))).toBe(false);
    });
});

describe('downloadPdfLink', () => {
    it('saves a PDF into a private temporary directory', async () => {
        mockHttp((_options, request) => request, fakeRequest({ headers: { 'Content-Disposition': 'inline; filename="w31161.pdf"' } }));

        const result = await downloadPdfLink('https://example.org/a.pdf', 30_000);

        expect(result).toMatchObject({
            ok: true,
            filename: 'w31161.pdf',
            size: PDF_BYTES.byteLength,
            file: { directory: '/tmp/beaver-pdf', path: '/tmp/beaver-pdf/file.pdf', mimeType: 'application/pdf' },
        });
        expect((globalThis as any).IOUtils.write).toHaveBeenCalledWith('/tmp/beaver-pdf/file.pdf', expect.any(Uint8Array));
    });

    it('refuses a private link before downloading', async () => {
        mocks.checkUrlAllowed.mockResolvedValue({ ok: false, code: 'url_not_allowed', message: 'Local and private-network addresses cannot be imported.' });
        mockHttp(() => { throw new Error('must not download'); });

        expect(await downloadPdfLink('http://10.0.0.1/a.pdf', 30_000)).toMatchObject({ ok: false, code: 'url_not_allowed' });
        expect((Zotero as any).HTTP.request).not.toHaveBeenCalled();
    });

    it('vetoes a redirect to a private host', async () => {
        mocks.isLoadableHost.mockResolvedValue(false);
        mockHttp(async (options) => {
            const verdict = await new Promise<number>((resolve) => {
                options.notificationCallbacks.asyncOnChannelRedirect(
                    {}, { URI: { host: 'intranet.local', scheme: 'https' } }, 0, { onRedirectVerifyCallback: resolve },
                );
            });
            throw Object.assign(new Error('redirect aborted'), { verdict });
        });

        const result = await downloadPdfLink('https://example.org/a.pdf', 30_000);

        expect(result).toMatchObject({ ok: false, code: 'url_not_allowed', message: expect.stringContaining('redirected') });
    });

    it('vetoes a redirect to another scheme without a lookup', async () => {
        let verdict: number | undefined;
        mockHttp((options) => {
            options.notificationCallbacks.asyncOnChannelRedirect(
                {}, { URI: { host: '', scheme: 'file' } }, 0, { onRedirectVerifyCallback: (value: number) => { verdict = value; } },
            );
            throw new Error('redirect aborted');
        });

        expect(await downloadPdfLink('https://example.org/a.pdf', 30_000)).toMatchObject({ ok: false, code: 'url_not_allowed' });
        expect(verdict).toBe(0x804b0002);
        expect(mocks.isLoadableHost).not.toHaveBeenCalled();
    });

    it('cuts off a response from a private address', async () => {
        const request = fakeRequest({ remoteAddress: '192.168.1.5' });
        mockHttp((options, req) => {
            req.readyState = 2;
            req.fire('readystatechange');
            return req;
        }, request);

        expect(await downloadPdfLink('https://example.org/a.pdf', 30_000)).toMatchObject({ ok: false, code: 'url_not_allowed' });
    });

    it('stops a file over the size limit', async () => {
        mockHttp((_options, req) => {
            req.fire('progress', { loaded: PDF_LINK_MAX_BYTES + 1 });
            return req;
        });

        expect(await downloadPdfLink('https://example.org/a.pdf', 30_000)).toMatchObject({ ok: false, code: 'too_large' });
    });

    it('reports a page as not_pdf and an HTTP error by its status', async () => {
        mockHttp((_options, req) => req, fakeRequest({ body: new TextEncoder().encode('<html></html>') }));
        expect(await downloadPdfLink('https://example.org/a.pdf', 30_000)).toMatchObject({ ok: false, code: 'not_pdf' });

        mockHttp((_options, req) => req, fakeRequest({ status: 403 }));
        expect(await downloadPdfLink('https://example.org/a.pdf', 30_000)).toMatchObject({ ok: false, code: 'blocked' });
    });
});

describe('ResolvedPdfStore', () => {
    const file = (name: string) => ({ directory: `/tmp/${name}`, path: `/tmp/${name}/file.pdf`, url: 'https://x.org/a.pdf', mimeType: 'application/pdf' });

    afterEach(() => vi.useRealTimers());

    it('hands a kept download to the write once, under any spelling of the link', () => {
        const store = new ResolvedPdfStore();
        store.keep('https://X.org/a.pdf?utm_source=feed', file('one'));

        expect(store.take('https://x.org/a.pdf')).toMatchObject({ directory: '/tmp/one' });
        expect(store.take('https://x.org/a.pdf')).toBeNull();
        expect(mocks.discardDownloadedFile).not.toHaveBeenCalled();
    });

    it('replaces an earlier download of the same link and discards it', () => {
        const store = new ResolvedPdfStore();
        store.keep('https://x.org/a.pdf', file('one'));
        store.keep('https://x.org/a.pdf', file('two'));

        expect(mocks.discardDownloadedFile).toHaveBeenCalledWith(expect.objectContaining({ directory: '/tmp/one' }));
        expect(store.take('https://x.org/a.pdf')).toMatchObject({ directory: '/tmp/two' });
    });

    it('discards a download nobody claimed once it expires, and all of them on shutdown', async () => {
        vi.useFakeTimers();
        const store = new ResolvedPdfStore();
        store.keep('https://x.org/a.pdf', file('one'));
        vi.advanceTimersByTime(31 * 60 * 1000);
        expect(mocks.discardDownloadedFile).toHaveBeenCalledWith(expect.objectContaining({ directory: '/tmp/one' }));
        expect(store.take('https://x.org/a.pdf')).toBeNull();

        store.keep('https://x.org/b.pdf', file('two'));
        await store.discardAll();
        expect(mocks.discardDownloadedFile).toHaveBeenCalledWith(expect.objectContaining({ directory: '/tmp/two' }));
    });
});
