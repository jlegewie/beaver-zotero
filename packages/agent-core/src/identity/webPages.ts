/**
 * Web pages found by web search: their URL identity, link targets and the
 * text-fragment links that open a page at a cited passage.
 *
 * A web page has one id, `web-<KEY>`: a hash of its normalized URL, computed
 * by the backend. The model writes the id in citations and as a markdown link
 * target (`[WHO fact sheet](web-K3J9Q2XA7M)`); the client looks the id up in
 * the conversation's external records to get the URL.
 *
 * `normalizeWebUrl` ports the backend's `normalize_web_url`
 * (`app/external_sources/urls.py`), including Python's `urlsplit` rules, so
 * both sides agree on which URLs name the same page. Both run the same test
 * URLs (`tests/fixtures/external_references/web_urls.json`); keep them in step.
 */

import { webPageId } from '../citations/externalRecords';

const HTTP_URL = /^https?:\/\//i;
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };
const TRACKING_PARAMS = new Set([
    'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'yclid', 'twclid', 'ttclid',
    'li_fat_id', 'mc_cid', 'mc_eid', 'igshid', '_hsenc', '_hsmi', 'mkt_tok', '_ga', '_gl', 'vero_id',
    'oly_anon_id', 'oly_enc_id', 'rb_clickid', 's_cid', 'wickedid',
]);
const TRACKING_PREFIXES = ['utm_'];

/** Whether a value is an http(s) URL (after trimming). */
export function isHttpUrl(value: unknown): value is string {
    return typeof value === 'string' && HTTP_URL.test(value.trim());
}

/** Percent-decoding that leaves malformed escapes as written (Python's `unquote`). */
function lenientUnquote(value: string): string {
    return value.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
        try {
            return decodeURIComponent(run);
        } catch {
            return run;
        }
    });
}

function isTracking(name: string): boolean {
    const lowered = lenientUnquote(name).toLowerCase();
    return TRACKING_PARAMS.has(lowered) || TRACKING_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

/** Rough IPv6 literal check (Python's `ipaddress` validation of a bracketed host). */
function isIpv6Literal(host: string): boolean {
    const zoneless = host.split('%')[0];
    if (!/^[0-9a-fA-F:.]+$/.test(zoneless) || !zoneless.includes(':')) return false;
    const halves = zoneless.split('::');
    if (halves.length > 2) return false;
    const doubleColons = halves.length === 2;
    const groupsOf = (half: string) => (half ? half.split(':') : []);
    const groups = halves.flatMap(groupsOf);
    const ipv4Tail = groups.length && groups[groups.length - 1].includes('.');
    const hexGroups = ipv4Tail ? groups.slice(0, -1) : groups;
    if (ipv4Tail && !/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(groups[groups.length - 1])) return false;
    if (!hexGroups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return false;
    const count = hexGroups.length + (ipv4Tail ? 2 : 0);
    return doubleColons ? count < 8 : count === 8;
}

/** Python's `_check_bracketed_netloc`: a bracketed host must be an IPv6 or IPvFuture literal. */
function checkBracketedNetloc(netloc: string): void {
    const hostAndPort = netloc.slice(netloc.lastIndexOf('@') + 1);
    const open = hostAndPort.indexOf('[');
    if (open < 0) return;
    if (open > 0) throw new Error('Invalid IPv6 URL');
    const bracketed = hostAndPort.slice(1);
    const close = bracketed.indexOf(']');
    const hostname = close < 0 ? bracketed : bracketed.slice(0, close);
    const port = close < 0 ? '' : bracketed.slice(close + 1);
    if (port && !port.startsWith(':')) throw new Error('Invalid IPv6 URL');
    if (hostname.startsWith('v')) {
        if (!/^v[a-fA-F0-9]+\..+$/.test(hostname)) throw new Error('IPvFuture address is invalid');
    } else if (!isIpv6Literal(hostname)) {
        throw new Error("'host' does not appear to be an IPv6 address");
    }
}

/** Python's `_checknetloc`: NFKC normalization must not introduce URL delimiters. */
function checkNetloc(netloc: string): void {
    if (Array.from(netloc).every((char) => char.charCodeAt(0) <= 0x7f)) return;
    const stripped = netloc.replace(/[@:#?]/g, '');
    const normalized = stripped.normalize('NFKC');
    if (normalized === stripped) return;
    for (const char of '/?#@:') {
        if (normalized.includes(char)) throw new Error(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
    }
}

interface SplitUrl {
    scheme: string;
    netloc: string;
    path: string;
    query: string;
}

/** Python's `urlsplit` for an http(s) URL (the caller has checked the scheme). */
function splitUrl(raw: string): SplitUrl {
    // Leading C0 controls and spaces are dropped; tabs and line breaks anywhere.
    let start = 0;
    while (start < raw.length && raw.charCodeAt(start) <= 0x20) start++;
    let url = raw.slice(start).replace(/[\t\r\n]/g, '');
    const colon = url.indexOf(':');
    const scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
    let netloc = '';
    if (url.startsWith('//')) {
        let end = url.length;
        for (const delimiter of '/?#') {
            const at = url.indexOf(delimiter, 2);
            if (at >= 0) end = Math.min(end, at);
        }
        netloc = url.slice(2, end);
        url = url.slice(end);
        if (netloc.includes('[') !== netloc.includes(']')) throw new Error('Invalid IPv6 URL');
        if (netloc.includes('[')) checkBracketedNetloc(netloc);
    }
    const hash = url.indexOf('#');
    if (hash >= 0) url = url.slice(0, hash);
    let query = '';
    const question = url.indexOf('?');
    if (question >= 0) {
        query = url.slice(question + 1);
        url = url.slice(0, question);
    }
    checkNetloc(netloc);
    return { scheme, netloc, path: url, query };
}

/** Python's `SplitResult._hostinfo`: the host and the port text, from a netloc. */
function hostInfo(netloc: string): { hostname: string; port: string | null } {
    const hostinfo = netloc.slice(netloc.lastIndexOf('@') + 1);
    const open = hostinfo.indexOf('[');
    let hostname: string;
    let port: string;
    if (open >= 0) {
        const bracketed = hostinfo.slice(open + 1);
        const close = bracketed.indexOf(']');
        hostname = close < 0 ? bracketed : bracketed.slice(0, close);
        const rest = close < 0 ? '' : bracketed.slice(close + 1);
        const portColon = rest.indexOf(':');
        port = portColon < 0 ? '' : rest.slice(portColon + 1);
    } else {
        const portColon = hostinfo.indexOf(':');
        hostname = portColon < 0 ? hostinfo : hostinfo.slice(0, portColon);
        port = portColon < 0 ? '' : hostinfo.slice(portColon + 1);
    }
    return { hostname: hostname.toLowerCase(), port: port || null };
}

/**
 * The identity form of an http(s) URL: two URLs that normalize alike are one
 * page. Removes only what never changes the page (scheme and host case, a
 * default port, the fragment, tracking parameters) and keeps everything else,
 * including `www.`, trailing slashes and the path exactly as written. Throws
 * for a value that is not an http(s) URL with a host.
 */
export function normalizeWebUrl(url: string): string {
    const value = url.trim();
    if (!HTTP_URL.test(value)) throw new Error(`Not an http(s) URL: ${url}`);
    const parts = splitUrl(value);
    let { hostname: host } = hostInfo(parts.netloc);
    if (!host) throw new Error(`URL has no host: ${url}`);
    if (host.includes(':')) host = `[${host}]`;

    const portText = hostInfo(parts.netloc).port;
    let port: number | null = null;
    if (portText !== null) {
        if (!/^[0-9]+$/.test(portText)) throw new Error(`Port could not be cast to integer value as '${portText}'`);
        port = Number(portText);
        if (port > 65535) throw new Error('Port out of range 0-65535');
    }
    let netloc = port === null || port === DEFAULT_PORTS[parts.scheme] ? host : `${host}:${port}`;

    const at = parts.netloc.lastIndexOf('@');
    if (at >= 0) {
        const userinfo = parts.netloc.slice(0, at);
        const passwordColon = userinfo.indexOf(':');
        const username = passwordColon < 0 ? userinfo : userinfo.slice(0, passwordColon);
        const password = passwordColon < 0 ? null : userinfo.slice(passwordColon + 1);
        if (username || password) netloc = `${username}${password ? `:${password}` : ''}@${netloc}`;
    }

    // Kept parameters stay exactly as written, in their order.
    const query = parts.query
        .split('&')
        .filter((segment) => segment && !isTracking(segment.split('=', 1)[0]))
        .join('&');
    const path = parts.path || '/';
    return `${parts.scheme}://${netloc}${path.startsWith('/') ? path : `/${path}`}${query ? `?${query}` : ''}`;
}

/** Normalize, or null for a value that is not an http(s) URL. */
export function tryNormalizeWebUrl(url: unknown): string | null {
    if (!isHttpUrl(url)) return null;
    try {
        return normalizeWebUrl(url);
    } catch {
        return null;
    }
}

/**
 * Recognize a markdown href as a link to a web page by its id
 * (`[WHO fact sheet](web-K3J9Q2XA7M)`). Returns the canonical id, or null for
 * every other href.
 */
export function parseWebLinkHref(href: string | null | undefined): string | null {
    return href ? webPageId(href) : null;
}

/** Whether a URL names a PDF by its path (`.pdf`, `/pdf/`, a final `/pdf`), as the backend's import classifier does. */
export function urlNamesPdf(url: string): boolean {
    if (!isHttpUrl(url)) return false;
    try {
        const path = splitUrl(url.trim()).path.toLowerCase();
        return path.endsWith('.pdf') || path.includes('/pdf/') || path.endsWith('/pdf');
    } catch {
        return false;
    }
}

// =============================================================================
// Text fragments
// =============================================================================

/** Words shown at each end of a long passage's `text=start,end` directive. */
const FRAGMENT_EDGE_WORDS = 5;
/** A passage of at most this many words is matched whole. */
const FRAGMENT_EXACT_WORDS = 10;

/** One cited sentence: its record id (`s12`, `h3`) and its text. */
export interface CitedSentence {
    partId?: string | null;
    text?: string | null;
}

/** Plain words of a sentence: whitespace collapsed, markdown emphasis and code marks dropped. */
function fragmentWords(text: string): string[] {
    return text
        .replace(/[*_`]{1,3}(?=\S)|(?<=\S)[*_`]{1,3}/g, '')
        .split(/\s+/)
        .filter(Boolean);
}

/** A text-fragment term: percent-encoded, including the `-`, `,` and `&` the syntax reserves. */
function encodeFragmentTerm(words: string[]): string {
    return encodeURIComponent(words.join(' ')).replace(/-/g, '%2D');
}

/** Record ids `s12` and `s13` (or `h3`, `h4`) follow each other. */
function followsDirectly(previous: string | null | undefined, next: string | null | undefined): boolean {
    const a = /^([a-z]+)(?:(\d+)\.)?(\d+)$/i.exec(previous ?? '');
    const b = /^([a-z]+)(?:(\d+)\.)?(\d+)$/i.exec(next ?? '');
    if (!a || !b || a[1] !== b[1]) return false;
    return (a[2] ?? '') === (b[2] ?? '') && Number(b[3]) === Number(a[3]) + 1;
}

/**
 * Open `url` at the cited passage: a `#:~:text=` fragment per run of
 * consecutive sentences, matching the first and last words of the run (or
 * the whole run when short). Browsers that support text fragments highlight
 * the passage when it is still on the page; otherwise the page simply opens.
 * Returns the URL unchanged when nothing can be matched, and for PDFs, whose
 * viewers ignore text fragments.
 */
export function textFragmentUrl(url: string, sentences: CitedSentence[], options: { isPdf?: boolean } = {}): string {
    if (options.isPdf || urlNamesPdf(url)) return url;
    const runs: string[][] = [];
    let previousId: string | null | undefined;
    for (const sentence of sentences) {
        const words = fragmentWords(sentence.text ?? '');
        if (!words.length) continue;
        const run = runs[runs.length - 1];
        if (run && followsDirectly(previousId, sentence.partId)) run.push(...words);
        else runs.push([...words]);
        previousId = sentence.partId;
    }
    const directives = runs.map((words) => {
        if (words.length <= FRAGMENT_EXACT_WORDS) return `text=${encodeFragmentTerm(words)}`;
        const start = encodeFragmentTerm(words.slice(0, FRAGMENT_EDGE_WORDS));
        const end = encodeFragmentTerm(words.slice(-FRAGMENT_EDGE_WORDS));
        return `text=${start},${end}`;
    });
    if (!directives.length) return url;
    // An existing fragment (a hash route, an anchor) is kept: `#anchor:~:text=…`.
    const joiner = url.includes('#') ? ':~:' : '#:~:';
    return `${url}${joiner}${directives.join('&')}`;
}

// =============================================================================
// Exports
// =============================================================================

/** `](web-KEY)` and `href="web-KEY"` link targets. Only a target position is matched. */
const WEB_LINK_TARGET_PATTERN = /(\]\(|href=")(web-[A-Za-z2-7]{10})(?=[)\s"])/g;

/**
 * Rewrite web page link targets (`[WHO fact sheet](web-K3J9Q2XA7M)`) to the
 * pages' URLs, for content that leaves the chat (a copied message, a note, a
 * file export), where a `web-` id is not a working link. `urlFor` looks the
 * id up in the conversation's records; an id it does not know is left as
 * written, and the export then keeps only the link's text.
 */
export function rewriteWebLinkTargets(markdown: string, urlFor: (webId: string) => string | null | undefined): string {
    return markdown.replace(WEB_LINK_TARGET_PATTERN, (match, opener: string, id: string) => {
        const webId = webPageId(id);
        const url = webId ? urlFor(webId) : null;
        if (!url || !isHttpUrl(url)) return match;
        if (opener === 'href="') return `${opener}${url.trim().replace(/"/g, '%22')}`;
        return `${opener}${markdownLinkTarget(url)}`;
    });
}

/** A URL as a markdown link target; angle brackets let it hold spaces and parentheses. */
export function markdownLinkTarget(url: string): string {
    const target = url.trim();
    return /[\s()<>]/.test(target) ? `<${target.replace(/[<>\s]/g, encodeURIComponent)}>` : target;
}

/** Text shown as written in Markdown: its punctuation escaped (link brackets, emphasis, code, math, backslashes). */
export function escapeMarkdownText(text: string): string {
    return text.replace(/[\\`*_[\]<>#|~$]/g, '\\$&');
}

/** A cited web page in Markdown: `([Title](URL), site)`. */
export function webCitationMarkdown(page: WebCitationExport): string {
    const site = page.site ? `, ${escapeMarkdownText(page.site)}` : '';
    return `([${escapeMarkdownText(page.title)}](${markdownLinkTarget(page.url)})${site})`;
}

/** What an exported web citation shows: `(<a href="URL">Title</a>, site)`. */
export interface WebCitationExport {
    url: string;
    title: string;
    /** Shown after the link; null when it would only repeat the title. */
    site: string | null;
}

/** The export form of a cited web page, or null when the page's URL is unknown. */
export function webCitationExport(page: {
    url?: string | null;
    title?: string | null;
    details?: { kind?: string | null; site?: unknown; site_name?: unknown } | null;
} | null | undefined): WebCitationExport | null {
    const url = page?.url?.trim();
    if (!url || !isHttpUrl(url)) return null;
    const details = page?.details?.kind === 'webpage' ? page.details : null;
    const siteValue = details?.site_name || details?.site;
    const site = typeof siteValue === 'string' && siteValue.trim() ? siteValue.trim() : null;
    const title = page?.title?.trim() || site || url;
    return { url, title, site: site && site !== title ? site : null };
}

const HTML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };

/**
 * Search highlights as a row shows them: without their sentence tags
 * (`<h3>…</h3>`), and with the text the backend escaped for them unescaped.
 */
export function stripHighlightTags(text: string): string {
    return text.replace(/<\/?h\d+>/g, '').replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => HTML_ENTITIES[entity]);
}
