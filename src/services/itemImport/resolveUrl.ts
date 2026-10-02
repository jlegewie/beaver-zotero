/**
 * URL resolution: a web-translation dry run in a hidden browser.
 *
 * Mirrors the `libraryID: false` branch of `Zotero.FeedItem.prototype.translate`:
 * load the page in a `HiddenBrowser`, detect translators with
 * `RemoteTranslate`, translate without saving. A page no site translator
 * handles is covered by Zotero's generic *Embedded Metadata* translator, which
 * yields a `webpage` item — the same result as saving the page in Zotero.
 *
 * Guards:
 * - http(s) only; loopback, link-local and private-network hosts are refused
 *   before the page is loaded with the user's cookies (SSRF guard);
 * - a dead host, a non-2xx status or a missing HTTP channel fails with
 *   `unreachable` / `not_found`;
 * - a bot-challenge page fails with `blocked` instead of becoming a junk
 *   `webpage` item;
 * - no visible window is ever opened.
 */

import type { AttachmentUrl } from '@beaver/agent-core/types/itemImport';
import { logger } from '@beaver/agent-core/platform/logger';
import { translatorAttachments } from './resolveIdentifier';
import { systemDelay } from '../../utils/systemTimers';
import { loadWebTranslationModules, pluginTimers, withTimeout } from './zoteroApis';

export type UrlTranslation =
    | {
        ok: true;
        json: Record<string, any>;
        translator?: string;
        attachments: AttachmentUrl[];
        /** The page Zotero would snapshot for this item. */
        pageUrl: string;
    }
    | { ok: false; code: 'unreachable' | 'not_found' | 'blocked' | 'timeout' | 'no_translator' | 'url_not_allowed' | 'unsupported_pdf_url' | 'multiple_items'; message: string };

const CHALLENGE_TITLES = /just a moment|attention required|access denied|verify(ing)? you are (a )?human|are you a robot|security check|captcha|ddos-guard|request unsuccessful|checking your browser|please enable cookies/i;

/** Hosts that must never be loaded in a hidden browser with the user's cookies. */
export function isBlockedHost(host: string): boolean {
    // A terminal dot is the fully qualified spelling of the same name ("localhost.").
    const h = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
    if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (!h.includes('.') && !h.includes(':')) return true; // single-label intranet names
    return isPrivateAddress(h);
}

/** Private, loopback, link-local, CGNAT, multicast or unspecified IPv4/IPv6 literal. */
export function isPrivateAddress(address: string): boolean {
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 100 && b >= 64 && b <= 127);
    }
    if (address.includes(':')) {
        const v6 = address.toLowerCase();
        if (v6 === '::' || v6 === '::1') return true;
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
        if (mapped) return isPrivateAddress(mapped[1]);
        // The hex spelling URL parsing produces, e.g. ::ffff:7f00:1 for 127.0.0.1.
        const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
        if (mappedHex) {
            const high = parseInt(mappedHex[1], 16);
            const low = parseInt(mappedHex[2], 16);
            return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
        }
        return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
    }
    return false;
}

type HostLookup = 'private' | 'public' | 'unresolved';

/**
 * Resolve a host name and report whether any address is private. A lookup that
 * fails or times out is `unresolved`, and callers treat it as not loadable.
 */
async function lookupHost(host: string, timeoutMs: number): Promise<HostLookup> {
    if (/^[\d.]+$/.test(host) || host.includes(':')) return isPrivateAddress(host) ? 'private' : 'public';
    try {
        const dns = (Components as any).classes['@mozilla.org/network/dns-service;1']
            .getService((Components as any).interfaces.nsIDNSService);
        const thread = (Services as any).tm.currentThread;
        const addresses = await withTimeout(new Promise<string[]>((resolve, reject) => {
            const listener = {
                onLookupComplete(_request: unknown, record: any, status: number) {
                    if (status !== 0 || !record) {
                        reject(new Error(`DNS lookup failed (${status})`));
                        return;
                    }
                    const out: string[] = [];
                    try {
                        record.QueryInterface((Components as any).interfaces.nsIDNSAddrRecord);
                        while (record.hasMore()) out.push(record.getNextAddrAsString());
                    } catch (error) {
                        reject(error);
                        return;
                    }
                    resolve(out);
                },
            };
            dns.asyncResolve(host, (Components as any).interfaces.nsIDNSService.RESOLVE_TYPE_DEFAULT, 0, null, listener, thread, {});
        }), timeoutMs, 'DNS lookup');
        if (!addresses.length) return 'unresolved';
        return addresses.some(isPrivateAddress) ? 'private' : 'public';
    } catch (error) {
        logger(`itemImport/resolveUrl: DNS check failed for ${host}: ${error}`, 2);
        return 'unresolved';
    }
}

/**
 * A hidden browser whose traffic to private networks is cut off, including
 * redirects and subresources of an allowed page:
 * - a request is held until its host is known not to be private (a private
 *   name or literal, or a public name resolving to a private address) and
 *   cancelled before it is sent otherwise;
 * - a response whose server address is private (a public name resolving to a
 *   private address) is cancelled before its content reaches the page.
 * `blocked()` reports whether the page's document was cut off; `release` must be called
 * before the browser is destroyed.
 */
export async function createGuardedBrowser(HiddenBrowser: any): Promise<{ browser: any; release: () => void; blocked: () => boolean }> {
    const browser = new HiddenBrowser();
    await browser._createdPromise;
    const browserId: number = browser.browserId;
    const Ci = (Components as any).interfaces;
    const Cr = (Components as any).results;
    let blockedRequest = false;
    // Host name → resolves to a private address (resolved once per browser).
    const hostVerdicts = new Map<string, Promise<boolean>>();
    const verdictFor = (host: string): Promise<boolean> => {
        let verdict = hostVerdicts.get(host);
        if (!verdict) {
            // An unverified destination is never loaded.
            verdict = isBlockedHost(host)
                ? Promise.resolve(true)
                : lookupHost(host, 5000).then((lookup) => lookup !== 'public');
            hostVerdicts.set(host, verdict);
        }
        return verdict;
    };
    const block = (channel: any) => {
        // Subresources are dropped silently; the page fails only when its
        // document itself was cut off.
        let mainDocument = true;
        try { mainDocument = !!channel.isMainDocumentChannel; } catch { /* treat as the document */ }
        if (mainDocument) blockedRequest = true;
        try { channel.cancel(Cr.NS_BINDING_ABORTED); } catch { /* already finished */ }
    };
    const observer = {
        observe(subject: any, topic: string) {
            let channel: any;
            try {
                channel = subject.QueryInterface(Ci.nsIHttpChannel);
            } catch {
                return;
            }
            if (!browserId || channel.browserId !== browserId) return;
            if (topic === 'http-on-modify-request') {
                let host: string;
                try {
                    host = channel.URI.host;
                } catch {
                    return;
                }
                if (isBlockedHost(host)) {
                    block(channel);
                    return;
                }
                // Hold the request until its host name is known not to resolve
                // to a private address, so nothing reaches a private service.
                channel.suspend();
                verdictFor(host).then(
                    (isPrivate) => {
                        if (isPrivate) block(channel);
                        try { channel.resume(); } catch { /* already finished */ }
                    },
                    () => {
                        try { channel.resume(); } catch { /* already finished */ }
                    },
                );
                return;
            }
            // Response: the address actually connected to (DNS can change
            // between the check above and the connection).
            let privateTarget = false;
            try {
                const address = channel.QueryInterface(Ci.nsIHttpChannelInternal).remoteAddress;
                privateTarget = !!address && isPrivateAddress(String(address));
            } catch {
                privateTarget = false;
            }
            if (privateTarget) block(channel);
        },
    };
    const topics = ['http-on-modify-request', 'http-on-examine-response', 'http-on-examine-cached-response'];
    for (const topic of topics) (Services as any).obs.addObserver(observer, topic);
    let released = false;
    return {
        browser,
        blocked: () => blockedRequest,
        release: () => {
            if (released) return;
            released = true;
            for (const topic of topics) {
                try { (Services as any).obs.removeObserver(observer, topic); } catch { /* already removed */ }
            }
        },
    };
}

/** True when a browser ended up on a private-network page (belt and braces after the guard). */
export function landedOnBlockedHost(browser: any): boolean {
    try {
        const uri = browser.currentURI;
        return !!uri && (uri.scheme === 'http' || uri.scheme === 'https') && isBlockedHost(uri.host);
    } catch {
        return false;
    }
}

/** Refuse non-http(s) URLs and private-network targets. */
export async function checkUrlAllowed(url: string, dnsTimeoutMs = 5000): Promise<{ ok: true; parsed: URL } | { ok: false; code: 'url_not_allowed' | 'unreachable'; message: string }> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, code: 'url_not_allowed', message: `'${url}' is not a valid URL.` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, code: 'url_not_allowed', message: 'Only http(s) URLs can be imported.' };
    }
    const lookup = isBlockedHost(parsed.hostname) ? 'private' : await lookupHost(parsed.hostname, dnsTimeoutMs);
    if (lookup === 'private') {
        return { ok: false, code: 'url_not_allowed', message: 'Local and private-network addresses cannot be imported.' };
    }
    if (lookup === 'unresolved') {
        return { ok: false, code: 'unreachable', message: `Could not look up ${parsed.hostname}.` };
    }
    return { ok: true, parsed };
}

function statusFailure(status: number): UrlTranslation {
    if (status === 401 || status === 403 || status === 429 || status === 503) {
        return { ok: false, code: 'blocked', message: `The site refused automated access (HTTP ${status}).` };
    }
    if (status === 404 || status === 410) {
        return { ok: false, code: 'not_found', message: `The page does not exist (HTTP ${status}).` };
    }
    return { ok: false, code: 'unreachable', message: `The page could not be loaded (HTTP ${status}).` };
}

function looksLikePdfUrl(url: string): boolean {
    try {
        const path = new URL(url).pathname.toLowerCase();
        return path.endsWith('.pdf') || path.includes('/pdf/');
    } catch {
        return false;
    }
}

/** A minimal `webpage` item, used when no translator returns anything. */
export function minimalWebpageJson(url: string, title: string | undefined): Record<string, any> {
    let site: string | undefined;
    try {
        site = new URL(url).hostname.replace(/^www\./, '');
    } catch {
        site = undefined;
    }
    return {
        itemType: 'webpage',
        title: title?.trim() || site || url,
        url,
        ...(site ? { websiteTitle: site } : {}),
    };
}

/** Translate the page at `url` to item JSON within `timeoutMs`. Never writes. */
export async function translateUrl(url: string, budgetMs: number): Promise<UrlTranslation> {
    // The DNS check counts against the same budget as loading the page.
    const deadline = Date.now() + budgetMs;
    const allowed = await checkUrlAllowed(url, Math.min(5000, Math.max(0, budgetMs)));
    if (!allowed.ok) return { ok: false, code: allowed.code, message: allowed.message };
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) return { ok: false, code: 'timeout', message: 'Ran out of time before loading the page.' };

    const modules = loadWebTranslationModules();
    if (!modules) {
        return { ok: false, code: 'no_translator', message: 'Web page translation is unavailable in this Zotero version.' };
    }

    let browser: any = null;
    let release: () => void = () => {};
    let blocked: () => boolean = () => false;
    let translate: any = null;
    let destroyed = false;
    const cleanup = () => {
        if (destroyed) return;
        destroyed = true;
        try { translate?.dispose(); } catch { /* already disposed */ }
        release();
        try { browser?.destroy(); } catch { /* already destroyed */ }
    };
    // The hidden browser must not outlive the deadline even if a Zotero call hangs.
    const timers = pluginTimers();
    const guard = timers.setTimeout(cleanup, timeoutMs + 1000);

    try {
        return await withTimeout((async (): Promise<UrlTranslation> => {
            const guarded = await createGuardedBrowser(modules.HiddenBrowser);
            if (destroyed) {
                // The deadline passed while the browser was starting: nothing owns it anymore.
                guarded.release();
                try { guarded.browser.destroy(); } catch { /* already destroyed */ }
                throw Object.assign(new Error('Loading the page timed out'), { code: 'timeout' });
            }
            ({ browser, release, blocked } = guarded);
            let loaded: boolean;
            try {
                loaded = await browser.load(url, { requireSuccessfulStatus: true });
            } catch (error: any) {
                if (blocked()) {
                    return { ok: false, code: 'url_not_allowed', message: 'The page redirected to a local or private-network address.' };
                }
                const status = Number(error?.status ?? error?.xmlhttp?.status);
                if (Number.isFinite(status) && status > 0) return statusFailure(status);
                return { ok: false, code: 'unreachable', message: `The page could not be loaded: ${error?.message ?? error}` };
            }
            if (blocked()) {
                return { ok: false, code: 'url_not_allowed', message: 'The page redirected to a local or private-network address.' };
            }
            if (!loaded) {
                return looksLikePdfUrl(url)
                    ? { ok: false, code: 'unsupported_pdf_url', message: 'The link is a file download, not a web page. Pass the article DOI or landing page instead.' }
                    : { ok: false, code: 'unreachable', message: 'The page could not be loaded (it may be a file download rather than a web page).' };
            }

            if (blocked() || landedOnBlockedHost(browser)) {
                return { ok: false, code: 'url_not_allowed', message: 'The page redirected to a local or private-network address.' };
            }
            const pageData = await browser.getPageData(['channelInfo', 'title'], { timeout: Math.min(10000, timeoutMs) });
            const channelInfo = pageData.channelInfo;
            // A title that is just the host name is an interstitial (NCBI's
            // client-side check, for one), not the page.
            const meaningfulTitle = (value: unknown): string | undefined => {
                const text = typeof value === 'string' ? value.trim() : '';
                if (!text) return undefined;
                const bare = (host: string) => host.toLowerCase().replace(/^www\./, '');
                let host = '';
                try { host = bare(String(browser.currentURI?.host ?? new URL(url).hostname)); } catch { host = ''; }
                return bare(text) === host ? undefined : text;
            };
            let title: string | undefined = meaningfulTitle(pageData.title);
            if (!channelInfo) {
                return { ok: false, code: 'unreachable', message: 'The server could not be reached.' };
            }
            if (channelInfo.responseStatus < 200 || channelInfo.responseStatus >= 300) {
                return statusFailure(channelInfo.responseStatus);
            }
            if (typeof title === 'string' && CHALLENGE_TITLES.test(title)) {
                return { ok: false, code: 'blocked', message: 'The site showed a bot-check page instead of the content.' };
            }
            if (!title) {
                // Script-built pages and interstitials (e.g. NCBI's) settle after
                // the load event; give the page one more moment before deciding.
                await systemDelay(2000);
                const settled = await browser.getPageData(['title'], { timeout: 5000 }).catch(() => ({ title: undefined }));
                title = meaningfulTitle(settled.title);
                if (title && CHALLENGE_TITLES.test(title)) {
                    return { ok: false, code: 'blocked', message: 'The site showed a bot-check page instead of the content.' };
                }
            }
            // Without a title and a translator, the page is not one Zotero can
            // describe (an interstitial or a script-only shell): a "webpage" item
            // named after the host would be junk.
            const unreadable: UrlTranslation = {
                ok: false,
                code: 'blocked',
                message: 'The page returned no readable content (it may be a bot check). Pass the work\'s DOI or PubMed id instead.',
            };

            const attempt = async (): Promise<UrlTranslation> => {
                const pageUrl: string = browser.currentURI?.spec || url;
                try { translate?.dispose(); } catch { /* already disposed */ }
                translate = new modules.RemoteTranslate({ disableErrorReporting: true });
                await translate.setBrowser(browser);
                let multiple = false;
                translate.setHandler('select', (_t: unknown, _items: unknown, callback: (selected: Record<string, unknown>) => void) => {
                    multiple = true;
                    callback({});
                });
                const translators = await translate.detect();
                if (!translators?.length) {
                    return title ? { ok: true, json: minimalWebpageJson(pageUrl, title), attachments: [], pageUrl } : unreadable;
                }
                const items = await translate.translate({ libraryID: false, saveAttachments: false });
                const json = items?.[0];
                if (!json) {
                    if (multiple) {
                        return {
                            ok: false,
                            code: 'multiple_items',
                            message: 'The page lists several works (search results or a table of contents). Pass the URL of one work, or its DOI.',
                        };
                    }
                    return title ? { ok: true, json: minimalWebpageJson(pageUrl, title), attachments: [], pageUrl } : unreadable;
                }
                const label = translators[0]?.label;
                return { ok: true, json, translator: typeof label === 'string' ? label : undefined, attachments: translatorAttachments(json), pageUrl };
            };

            try {
                return await attempt();
            } catch (error: any) {
                // A page that reloads itself after a client-side check (e.g. NCBI)
                // tears down the translation actor mid-query. Let it settle and
                // try once more against the reloaded document.
                if (!/destroyed/i.test(String(error?.message ?? error))) throw error;
                await systemDelay(2500);
                const settled = await browser.getPageData(['title'], { timeout: 5000 }).catch(() => ({ title: undefined }));
                title = meaningfulTitle(settled.title) ?? title;
                return await attempt();
            }
        })(), timeoutMs, 'Loading the page');
    } catch (error: any) {
        if (error?.code === 'timeout') {
            return { ok: false, code: 'timeout', message: 'The page took too long to load.' };
        }
        return { ok: false, code: 'unreachable', message: `The page could not be translated: ${error?.message ?? error}` };
    } finally {
        timers.clearTimeout(guard);
        cleanup();
    }
}
