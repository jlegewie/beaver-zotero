/**
 * Guarded access to the Zotero APIs item import depends on that are internal or
 * undocumented.
 *
 * A Zotero update can rename or remove any of them, so every use goes through
 * this module. Each API is probed lazily on first use (does it exist, does it
 * have the expected shape) and the result is cached for the plugin's lifetime.
 * A runtime failure that looks like API drift (a TypeError, or an unexpected
 * result shape) marks the API unavailable for the session, so callers take
 * their fallback instead of surfacing a raw Zotero internal error. Each
 * unavailable API is logged once with the Zotero version.
 *
 * The probe states are reported at `/beaver/test/item-import-capabilities`.
 *
 * Esbuild-safe: no `react/*` imports, no bare `addon`.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { getSystemTimers } from '../../utils/systemTimers';

export type ZoteroApiName =
    | 'translateSearch'
    | 'remoteTranslate'
    | 'itemSaver'
    | 'pdfRecognizerData'
    | 'recognizerService'
    | 'recognizeDocument'
    | 'epub'
    | 'rdfImport'
    | 'importFromDocument'
    | 'attachmentRename';

export interface ZoteroApiStatus {
    available: boolean;
    reason?: string;
}

const API_NAMES: ZoteroApiName[] = [
    'translateSearch',
    'remoteTranslate',
    'itemSaver',
    'pdfRecognizerData',
    'recognizerService',
    'recognizeDocument',
    'epub',
    'rdfImport',
    'importFromDocument',
    'attachmentRename',
];

const statuses = new Map<ZoteroApiName, ZoteroApiStatus>();
const loggedUnavailable = new Set<ZoteroApiName>();

/** System timers: a timer scheduled from a window's realm dies with that window. */
export const pluginTimers = getSystemTimers;

/** Reject after `ms` with an Error carrying `code: 'timeout'`; the work itself is not cancelled. */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
    const timers = pluginTimers();
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        handle = timers.setTimeout(() => {
            reject(Object.assign(new Error(`${label} timed out after ${Math.round(ms / 100) / 10}s`), { code: 'timeout' }));
        }, Math.max(0, ms));
    });
    return Promise.race([work, timeout]).finally(() => {
        if (handle !== undefined) timers.clearTimeout(handle);
    });
}

function importModule<T = any>(url: string): T | null {
    try {
        return ChromeUtils.importESModule(url) as T;
    } catch (error) {
        logger(`itemImport/zoteroApis: could not import ${url}: ${error}`, 1);
        return null;
    }
}

function probe(name: ZoteroApiName): ZoteroApiStatus {
    const Z = Zotero as any;
    const fn = (value: unknown) => typeof value === 'function';
    switch (name) {
        case 'translateSearch':
            return fn(Z.Translate?.Search)
                && fn(Z.Translate.Search.prototype?.setIdentifier)
                && fn(Z.Translate.Search.prototype?.getTranslators)
                ? { available: true }
                : { available: false, reason: 'Zotero.Translate.Search is missing setIdentifier/getTranslators' };
        case 'remoteTranslate': {
            const remote = importModule<any>('chrome://zotero/content/RemoteTranslate.mjs');
            const hidden = importModule<any>('chrome://zotero/content/HiddenBrowser.mjs');
            return fn(remote?.RemoteTranslate) && fn(hidden?.HiddenBrowser)
                ? { available: true }
                : { available: false, reason: 'RemoteTranslate.mjs / HiddenBrowser.mjs did not import' };
        }
        case 'itemSaver': {
            const saver = Z.Translate?.ItemSaver;
            return fn(saver) && fn(saver.prototype?.saveItems) && typeof saver.ATTACHMENT_MODE_IGNORE === 'number'
                ? { available: true }
                : { available: false, reason: 'Zotero.Translate.ItemSaver is missing saveItems or ATTACHMENT_MODE_IGNORE' };
        }
        case 'pdfRecognizerData':
            return fn(Z.PDFWorker?._enqueue) && fn(Z.PDFWorker?._query)
                ? { available: true }
                : { available: false, reason: 'Zotero.PDFWorker._enqueue/_query are missing' };
        case 'recognizerService':
            return fn(Z.Sync?.Runner?.getAPIClient) && recognizerBaseUrl() !== null
                ? { available: true }
                : { available: false, reason: 'No API client or recognizer URL' };
        case 'recognizeDocument':
            return fn(Z.RecognizeDocument?._recognize)
                ? { available: true }
                : { available: false, reason: 'Zotero.RecognizeDocument._recognize is missing' };
        case 'epub': {
            const epub = importModule<any>('chrome://zotero/content/EPUB.mjs');
            return fn(epub?.EPUB) && fn(epub.EPUB.prototype?.getMetadataRDF) && fn(epub.EPUB.prototype?.getSectionDocuments)
                ? { available: true }
                : { available: false, reason: 'EPUB.mjs did not import or lacks getMetadataRDF/getSectionDocuments' };
        }
        case 'rdfImport':
            return fn(Z.Translate?.Import) && typeof Z.Translators?.TRANSLATOR_ID_RDF === 'string'
                ? { available: true }
                : { available: false, reason: 'Zotero.Translate.Import or TRANSLATOR_ID_RDF is missing' };
        case 'importFromDocument':
            return fn(Z.Attachments?.importFromDocument)
                ? { available: true }
                : { available: false, reason: 'Zotero.Attachments.importFromDocument is missing' };
        case 'attachmentRename':
            return fn(Z.Attachments?.shouldAutoRenameFile) && fn(Z.Attachments?.getRenamedFileBaseNameIfAllowedType)
                ? { available: true }
                : { available: false, reason: 'Attachment rename helpers are missing' };
    }
}

/** Probe state of one API (probed on first call). */
export function apiStatus(name: ZoteroApiName): ZoteroApiStatus {
    let status = statuses.get(name);
    if (!status) {
        try {
            status = probe(name);
        } catch (error) {
            status = { available: false, reason: `probe threw: ${error}` };
        }
        statuses.set(name, status);
        if (!status.available) logUnavailable(name, status.reason);
    }
    return status;
}

export function isApiAvailable(name: ZoteroApiName): boolean {
    return apiStatus(name).available;
}

/** All probe states, for diagnostics and the capabilities endpoint. */
export function probeAllZoteroApis(): Record<ZoteroApiName, ZoteroApiStatus> {
    const result = {} as Record<ZoteroApiName, ZoteroApiStatus>;
    for (const name of API_NAMES) result[name] = apiStatus(name);
    return result;
}

/** Mark an API unavailable for the rest of the session after it failed like an API change. */
export function markApiUnavailable(name: ZoteroApiName, error: unknown): void {
    const reason = `runtime failure: ${error instanceof Error ? error.message : String(error)}`;
    statuses.set(name, { available: false, reason });
    logUnavailable(name, reason);
}

/**
 * True for failures that indicate API drift (a renamed or removed function)
 * rather than a bad input or the network. A TypeError about missing data — a
 * malformed file read by an intact API — does not count.
 */
export function looksLikeApiDrift(error: unknown): boolean {
    const isTypeError = error instanceof TypeError || (error as any)?.name === 'TypeError';
    return isTypeError && /is not a (function|constructor)|is not iterable/i.test(String((error as any)?.message ?? error));
}

/** Forget cached probes (tests only). */
export function resetZoteroApiProbes(): void {
    statuses.clear();
    loggedUnavailable.clear();
}

function logUnavailable(name: ZoteroApiName, reason?: string): void {
    if (loggedUnavailable.has(name)) return;
    loggedUnavailable.add(name);
    logger(`itemImport: Zotero API '${name}' unavailable on Zotero ${(Zotero as any).version ?? '?'}: ${reason ?? 'unknown'}`, 1);
}

// =============================================================================
// Wrappers
// =============================================================================

export function loadWebTranslationModules(): { RemoteTranslate: any; HiddenBrowser: any } | null {
    if (!isApiAvailable('remoteTranslate')) return null;
    const remote = importModule<any>('chrome://zotero/content/RemoteTranslate.mjs');
    const hidden = importModule<any>('chrome://zotero/content/HiddenBrowser.mjs');
    if (!remote?.RemoteTranslate || !hidden?.HiddenBrowser) return null;
    return { RemoteTranslate: remote.RemoteTranslate, HiddenBrowser: hidden.HiddenBrowser };
}

export function loadEpubModule(): any | null {
    if (!isApiAvailable('epub')) return null;
    return importModule<any>('chrome://zotero/content/EPUB.mjs')?.EPUB ?? null;
}

/** The recognizer endpoint Zotero itself uses: `recognize.url`, else `services.url` + `recognizer/`. */
export function recognizerBaseUrl(): string | null {
    try {
        let url = Zotero.Prefs.get('recognize.url') as string | undefined;
        if (!url) {
            url = Zotero.Prefs.get('services.url') as string | undefined;
            if (!url) {
                // ZOTERO_CONFIG is an ES module export, not a global in the plugin realm.
                const config = importModule<any>('resource://zotero/config.mjs');
                url = config?.ZOTERO_CONFIG?.SERVICES_URL;
            }
            if (!url) return null;
            if (!url.endsWith('/')) url += '/';
            return url + 'recognizer/';
        }
        return url.endsWith('/') ? url : url + '/';
    } catch {
        return null;
    }
}

/** Recognizer layout data: `{pages: [[w, h, textRuns], …], …}`. */
export interface PdfRecognizerData {
    pages: any[];
    [key: string]: unknown;
}

/**
 * Run the PDF worker's `pdf.getRecognizerData` on a file buffer, without a
 * Zotero item. Mirrors `Zotero.PDFWorker.getRecognizerData`, minus the item.
 * Returns null when the API is unavailable or drifted.
 */
export async function getPdfRecognizerData(buf: ArrayBuffer, timeoutMs: number): Promise<PdfRecognizerData | null> {
    if (!isApiAvailable('pdfRecognizerData')) return null;
    const worker = (Zotero as any).PDFWorker;
    try {
        const data = await withTimeout<any>(
            worker._enqueue(() => worker._query('pdf.getRecognizerData', { buf, password: undefined }, [buf]), true),
            timeoutMs,
            'PDF recognizer data',
        );
        if (!data || !Array.isArray(data.pages)) {
            markApiUnavailable('pdfRecognizerData', new Error('result has no pages array'));
            return null;
        }
        return data;
    } catch (error) {
        if (looksLikeApiDrift(error)) markApiUnavailable('pdfRecognizerData', error);
        throw error;
    }
}

/** Recognizer service response: an identifier, or title/authors and other fields. */
export interface RecognizerResponse {
    arxiv?: string;
    doi?: string;
    isbn?: string;
    title?: string;
    authors?: Array<{ firstName?: string; lastName?: string }>;
    abstract?: string;
    language?: string;
    type?: string;
    year?: string;
    pages?: string;
    volume?: string;
    issue?: string;
    url?: string;
    container?: string;
    publisher?: string;
    ISSN?: string;
    [key: string]: unknown;
}

/** POST layout data to Zotero's recognizer service, exactly as `RecognizeDocument` does. */
export async function queryRecognizerService(json: unknown, timeoutMs: number): Promise<RecognizerResponse | null> {
    if (!isApiAvailable('recognizerService')) return null;
    const base = recognizerBaseUrl();
    if (!base) return null;
    try {
        const client = (Zotero as any).Sync.Runner.getAPIClient();
        const request = await withTimeout<any>(
            client.makeRequest('POST', base + 'recognize', {
                successCodes: [200],
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(json),
                noAPIKey: true,
            }),
            timeoutMs,
            'Recognizer request',
        );
        const response = JSON.parse(request.responseText);
        if (!response || typeof response !== 'object') {
            markApiUnavailable('recognizerService', new Error('response is not an object'));
            return null;
        }
        return response as RecognizerResponse;
    } catch (error) {
        if (looksLikeApiDrift(error)) markApiUnavailable('recognizerService', error);
        throw error;
    }
}
