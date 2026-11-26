/**
 * Importing a PDF link the way the Zotero Connector saves a PDF: download the
 * file, identify it like an attached file (`recognizeFile`), and attach the
 * same download to the item.
 *
 * - **Download (during resolution, before approval):** an http(s) GET under
 *   the same private-network guard as page loads — the link and every
 *   redirect must name a public host, and a response from a private address
 *   is cut off — with a size limit and within the item's time budget. Only a
 *   PDF (by its leading bytes) is kept; anything else is reported as
 *   `not_pdf`, so the caller treats the link as a page.
 * - **Hand-off to the write:** the approved item's PDF candidate is the same
 *   link, so the downloaded file is kept for a while under the link's
 *   normalized URL (`takeResolvedPdf`) and attached from there instead of
 *   being downloaded again. An entry nobody claims is removed when it expires
 *   or when the plugin shuts down.
 *
 * Esbuild-safe: no `react/*` imports, no bare `addon`.
 */

import { tryNormalizeWebUrl } from '@beaver/agent-core/identity/webPages';
import { logger } from '@beaver/agent-core/platform/logger';
import { discardDownloadedFile, type DownloadedFile } from '../pdfAttachmentFetch';
import { checkUrlAllowed, isLoadableHost, isPrivateAddress } from './resolveUrl';
import { pluginTimers } from './zoteroApis';

/** Largest PDF an import downloads. */
export const PDF_LINK_MAX_BYTES = 100 * 1024 * 1024;
/** How long a downloaded PDF waits for its approved import. */
const RESOLVED_PDF_TTL_MS = 30 * 60 * 1000;
/** Most downloads kept at once; the oldest is dropped first. */
const RESOLVED_PDF_MAX = 20;

export const PDF_MIME = 'application/pdf';

export type PdfLinkDownload =
    | { ok: true; file: DownloadedFile; filename: string; size: number }
    | {
        ok: false;
        code: 'url_not_allowed' | 'unreachable' | 'not_found' | 'blocked' | 'timeout' | 'not_pdf' | 'too_large';
        message: string;
        /** HTTP status of a refused or failed response. */
        status?: number;
    };

/** A file name from Content-Disposition, else the last path segment of the URL. */
export function pdfFilename(url: string, contentDisposition: string | null | undefined): string {
    const encoded = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(contentDisposition ?? '');
    const quoted = /filename\s*=\s*"([^"]+)"/i.exec(contentDisposition ?? '') ?? /filename\s*=\s*([^;\s]+)/i.exec(contentDisposition ?? '');
    let name = '';
    try {
        name = encoded ? decodeURIComponent(encoded[1].trim()) : quoted ? quoted[1].trim() : '';
    } catch {
        name = quoted ? quoted[1].trim() : '';
    }
    if (!name) {
        try {
            const segment = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
            name = decodeURIComponent(segment);
        } catch {
            name = '';
        }
    }
    name = Array.from(name, (char) => (char.charCodeAt(0) < 0x20 ? ' ' : char)).join('').replace(/[\\/:*?"<>|]+/g, ' ').trim();
    if (!name) return 'document.pdf';
    return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

/** Whether bytes start like a PDF (`%PDF-`, allowing leading junk some servers add). */
export function looksLikePdfBytes(bytes: Uint8Array): boolean {
    const head = String.fromCharCode(...bytes.subarray(0, 1024));
    return head.includes('%PDF-');
}

function statusFailure(status: number): PdfLinkDownload {
    if (status === 401 || status === 403 || status === 429 || status === 503) {
        return { ok: false, code: 'blocked', message: `The site refused automated access (HTTP ${status}).`, status };
    }
    if (status === 404 || status === 410) {
        return { ok: false, code: 'not_found', message: `The file does not exist (HTTP ${status}).`, status };
    }
    return { ok: false, code: 'unreachable', message: `The file could not be downloaded (HTTP ${status}).`, status };
}

/**
 * Download the PDF at `url` into a private temporary directory within
 * `budgetMs`. The caller owns the returned file: attach it, keep it with
 * `keepResolvedPdf`, or discard it.
 */
export async function downloadPdfLink(url: string, budgetMs: number): Promise<PdfLinkDownload> {
    const deadline = Date.now() + budgetMs;
    const left = () => Math.max(0, deadline - Date.now());
    const allowed = await checkUrlAllowed(url, Math.min(5000, left()));
    if (!allowed.ok) return { ok: false, code: allowed.code, message: allowed.message };
    if (left() <= 0) return { ok: false, code: 'timeout', message: 'Ran out of time before downloading the file.' };

    const Ci = (Components as any).interfaces;
    const Cr = (Components as any).results;
    // Why the download was stopped, when we stopped it.
    let stopped: PdfLinkDownload | null = null;
    let cancel: (() => void) | null = null;
    const stop = (reason: PdfLinkDownload) => {
        stopped ??= reason;
        try { cancel?.(); } catch { /* already finished */ }
    };
    const privateRedirect: PdfLinkDownload = { ok: false, code: 'url_not_allowed', message: 'The link redirected to a local or private-network address.' };
    const tooLarge: PdfLinkDownload = { ok: false, code: 'too_large', message: `The file is larger than ${PDF_LINK_MAX_BYTES / (1024 * 1024)} MB.` };

    let xmlhttp: any;
    try {
        xmlhttp = await (Zotero.HTTP as any).request('GET', url, {
            responseType: 'arraybuffer',
            headers: { Accept: 'application/pdf,*/*;q=0.8' },
            timeout: Math.max(1000, left()),
            errorDelayMax: 0,
            successCodes: false,
            cancellerReceiver: (canceller: () => void) => { cancel = canceller; },
            // Every redirect must name a public host; the response is checked again below.
            notificationCallbacks: {
                asyncOnChannelRedirect(_old: any, next: any, _flags: number, callback: any) {
                    let host = '';
                    let scheme = '';
                    try {
                        host = next.URI.host;
                        scheme = next.URI.scheme;
                    } catch { /* not a host-based URI */ }
                    if (scheme !== 'http' && scheme !== 'https') {
                        stopped ??= privateRedirect;
                        callback.onRedirectVerifyCallback(Cr.NS_BINDING_ABORTED);
                        return;
                    }
                    isLoadableHost(host, Math.min(5000, Math.max(1, left()))).then(
                        (loadable) => {
                            if (!loadable) stopped ??= privateRedirect;
                            callback.onRedirectVerifyCallback(loadable ? Cr.NS_OK : Cr.NS_BINDING_ABORTED);
                        },
                        () => {
                            stopped ??= privateRedirect;
                            callback.onRedirectVerifyCallback(Cr.NS_BINDING_ABORTED);
                        },
                    );
                },
            },
            requestObserver: (request: any) => {
                request.addEventListener('readystatechange', () => {
                    if (request.readyState !== 2) return; // HEADERS_RECEIVED
                    // The address actually connected to (DNS can change after the check).
                    try {
                        const address = request.channel.QueryInterface(Ci.nsIHttpChannelInternal).remoteAddress;
                        if (address && isPrivateAddress(String(address))) stop(privateRedirect);
                    } catch { /* no address for cached or non-network responses */ }
                    const length = Number(request.getResponseHeader('Content-Length'));
                    if (Number.isFinite(length) && length > PDF_LINK_MAX_BYTES) stop(tooLarge);
                });
                request.addEventListener('progress', (event: any) => {
                    if (event.loaded > PDF_LINK_MAX_BYTES) stop(tooLarge);
                });
            },
        });
    } catch (error: any) {
        if (stopped) return stopped;
        if (error instanceof (Zotero.HTTP as any).TimeoutException) {
            return { ok: false, code: 'timeout', message: 'Downloading the file took too long.' };
        }
        const status = Number(error?.status ?? error?.xmlhttp?.status);
        if (Number.isFinite(status) && status > 0) return statusFailure(status);
        return { ok: false, code: 'unreachable', message: `The file could not be downloaded: ${error?.message ?? error}` };
    }
    if (stopped) return stopped;
    if (xmlhttp.status < 200 || xmlhttp.status >= 300) return statusFailure(xmlhttp.status);

    const bytes = new Uint8Array(xmlhttp.response ?? new ArrayBuffer(0));
    if (bytes.byteLength > PDF_LINK_MAX_BYTES) return tooLarge;
    if (!looksLikePdfBytes(bytes)) {
        return { ok: false, code: 'not_pdf', message: 'The link is not a PDF.' };
    }
    const finalUrl = String(xmlhttp.responseURL || url);
    const filename = pdfFilename(finalUrl, xmlhttp.getResponseHeader?.('Content-Disposition'));
    const directory: string = (await (Zotero.Attachments as any).createTemporaryStorageDirectory()).path;
    const path = PathUtils.join(directory, 'file.pdf');
    try {
        await IOUtils.write(path, bytes);
    } catch (error) {
        await discardDownloadedFile({ directory, path, url, mimeType: PDF_MIME });
        return { ok: false, code: 'unreachable', message: `The file could not be saved: ${error}` };
    }
    return {
        ok: true,
        file: { directory, path, url, mimeType: PDF_MIME, accessMethod: 'web', title: undefined },
        filename,
        size: bytes.byteLength,
    };
}

// =============================================================================
// Downloads waiting for their approved import
// =============================================================================

interface ResolvedPdf {
    file: DownloadedFile;
    expiresAt: number;
}

/**
 * PDFs downloaded during resolution, by the normalized link, until the
 * approved import attaches them. Owned by the plugin-realm item-import service
 * (`Zotero.Beaver.itemImport.resolvedPdfs`): resolution and the write may run
 * in different bundles, and the timers must not belong to a window.
 */
export class ResolvedPdfStore {
    private readonly entries = new Map<string, ResolvedPdf>();
    private purgeTimer: ReturnType<typeof setTimeout> | undefined;

    /** Keep a downloaded PDF for the import of `url` (the link the approved item names as its PDF). */
    keep(url: string, file: DownloadedFile): void {
        const key = tryNormalizeWebUrl(url);
        if (!key) {
            void discardDownloadedFile(file);
            return;
        }
        const previous = this.entries.get(key);
        if (previous && previous.file.directory !== file.directory) void discardDownloadedFile(previous.file);
        this.entries.delete(key);
        this.entries.set(key, { file, expiresAt: Date.now() + RESOLVED_PDF_TTL_MS });
        while (this.entries.size > RESOLVED_PDF_MAX) {
            const [oldestKey, oldest] = this.entries.entries().next().value as [string, ResolvedPdf];
            this.entries.delete(oldestKey);
            void discardDownloadedFile(oldest.file);
        }
        this.schedulePurge();
    }

    /** The PDF downloaded for `url`, now owned by the caller; null when there is none. */
    take(url: string): DownloadedFile | null {
        const key = tryNormalizeWebUrl(url);
        const entry = key ? this.entries.get(key) : undefined;
        if (!key || !entry) return null;
        this.entries.delete(key);
        this.schedulePurge();
        if (entry.expiresAt <= Date.now()) {
            void discardDownloadedFile(entry.file);
            return null;
        }
        return entry.file;
    }

    /** Remove every kept download (plugin shutdown). */
    async discardAll(): Promise<void> {
        const entries = Array.from(this.entries.values());
        this.entries.clear();
        this.schedulePurge();
        await Promise.all(entries.map((entry) => discardDownloadedFile(entry.file)));
        if (entries.length) logger(`itemImport/pdfLinkImport: discarded ${entries.length} unclaimed PDF download(s)`, 3);
    }

    private schedulePurge(): void {
        const timers = pluginTimers();
        if (this.purgeTimer !== undefined) timers.clearTimeout(this.purgeTimer);
        this.purgeTimer = undefined;
        if (!this.entries.size) return;
        const next = Math.min(...Array.from(this.entries.values()).map((entry) => entry.expiresAt));
        this.purgeTimer = timers.setTimeout(() => {
            this.purgeTimer = undefined;
            this.purgeExpired();
        }, Math.max(1000, next - Date.now()));
    }

    private purgeExpired(): void {
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt > now) continue;
            this.entries.delete(key);
            void discardDownloadedFile(entry.file);
        }
        this.schedulePurge();
    }
}

/** Keep a resolved PDF in the plugin realm's store; discarded when there is none. */
export function keepResolvedPdf(url: string, file: DownloadedFile): void {
    const store = Zotero.Beaver?.itemImport?.resolvedPdfs;
    if (store) store.keep(url, file);
    else void discardDownloadedFile(file);
}

/** The PDF an import downloaded for `url` while resolving, now owned by the caller; null when there is none. */
export function takeResolvedPdf(url: string): DownloadedFile | null {
    return Zotero.Beaver?.itemImport?.resolvedPdfs?.take(url) ?? null;
}
