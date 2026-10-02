import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    apiStatus,
    getPdfRecognizerData,
    isApiAvailable,
    looksLikeApiDrift,
    markApiUnavailable,
    probeAllZoteroApis,
    recognizerBaseUrl,
    resetZoteroApiProbes,
    withTimeout,
} from '../../../src/services/itemImport/zoteroApis';

const Z = Zotero as any;
let saved: Record<string, unknown>;

/** `ChromeUtils` serving the real Node timers for Timer.sys.mjs and `modules` for everything else. */
function stubChromeUtils(modules: (url: string) => unknown) {
    vi.stubGlobal('ChromeUtils', {
        importESModule: vi.fn((url: string) => (url.includes('Timer.sys.mjs') ? { setTimeout, clearTimeout } : modules(url))),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    resetZoteroApiProbes();
    saved = { Translate: Z.Translate, PDFWorker: Z.PDFWorker, Attachments: Z.Attachments, RecognizeDocument: Z.RecognizeDocument, Sync: Z.Sync, Translators: Z.Translators };
    stubChromeUtils(() => ({}));
});

afterEach(() => {
    for (const [key, value] of Object.entries(saved)) Z[key] = value;
    resetZoteroApiProbes();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('API probes', () => {
    it('reports translateSearch unavailable when Zotero.Translate.Search is missing', () => {
        Z.Translate = undefined;
        expect(apiStatus('translateSearch')).toMatchObject({ available: false });
        expect(isApiAvailable('translateSearch')).toBe(false);
    });

    it('reports translateSearch available with the expected shape', () => {
        Z.Translate = { Search: class { setIdentifier() {} getTranslators() {} } };
        expect(isApiAvailable('translateSearch')).toBe(true);
    });

    it('requires saveItems and a numeric ATTACHMENT_MODE_IGNORE for itemSaver', () => {
        Z.Translate = { ItemSaver: class { saveItems() {} } };
        expect(isApiAvailable('itemSaver')).toBe(false);
        resetZoteroApiProbes();
        Z.Translate = { ItemSaver: Object.assign(class { saveItems() {} }, { ATTACHMENT_MODE_IGNORE: 0 }) };
        expect(isApiAvailable('itemSaver')).toBe(true);
    });

    it('reports the PDF worker and attachment helpers unavailable when absent', () => {
        Z.PDFWorker = undefined;
        Z.Attachments = {};
        expect(isApiAvailable('pdfRecognizerData')).toBe(false);
        expect(isApiAvailable('attachmentRename')).toBe(false);
        expect(isApiAvailable('importFromDocument')).toBe(false);
    });

    it('reports remoteTranslate and epub unavailable when the chrome modules do not import', () => {
        stubChromeUtils(() => { throw new Error('nope'); });
        expect(apiStatus('remoteTranslate')).toMatchObject({ available: false });
        expect(apiStatus('epub')).toMatchObject({ available: false });
    });

    it('treats a probe that throws as unavailable', () => {
        Object.defineProperty(Z, 'Translate', { configurable: true, get() { throw new Error('boom'); } });
        try {
            expect(apiStatus('translateSearch')).toEqual({ available: false, reason: expect.stringContaining('probe threw') });
        } finally {
            Object.defineProperty(Z, 'Translate', { configurable: true, writable: true, value: saved.Translate });
        }
    });

    it('caches the first probe result until reset', () => {
        Z.Translate = { Search: class { setIdentifier() {} getTranslators() {} } };
        expect(isApiAvailable('translateSearch')).toBe(true);
        Z.Translate = undefined;
        expect(isApiAvailable('translateSearch')).toBe(true);
        resetZoteroApiProbes();
        expect(isApiAvailable('translateSearch')).toBe(false);
    });

    it('probes every API for the capabilities report', () => {
        const all = probeAllZoteroApis();
        expect(Object.keys(all).sort()).toEqual([
            'attachmentRename', 'epub', 'importFromDocument', 'itemSaver', 'pdfRecognizerData',
            'recognizerService', 'rdfImport', 'remoteTranslate', 'translateSearch',
        ].sort());
        for (const status of Object.values(all)) expect(typeof status.available).toBe('boolean');
    });
});

describe('markApiUnavailable', () => {
    it('overrides an available probe for the rest of the session', () => {
        Z.Translate = { Search: class { setIdentifier() {} getTranslators() {} } };
        expect(isApiAvailable('translateSearch')).toBe(true);
        markApiUnavailable('translateSearch', new TypeError('x is not a function'));
        expect(apiStatus('translateSearch')).toEqual({ available: false, reason: 'runtime failure: x is not a function' });
    });

    it('accepts non-Error values', () => {
        markApiUnavailable('epub', 'plain string');
        expect(apiStatus('epub').reason).toBe('runtime failure: plain string');
    });
});

describe('looksLikeApiDrift', () => {
    it('is true for TypeErrors about a missing function, constructor or iterable', () => {
        expect(looksLikeApiDrift(new TypeError('x.foo is not a function'))).toBe(true);
        expect(looksLikeApiDrift(new TypeError('Zotero.Translate.Search is not a constructor'))).toBe(true);
        expect(looksLikeApiDrift(new TypeError('items is not iterable'))).toBe(true);
        expect(looksLikeApiDrift({ name: 'TypeError', message: 'y is not a function' })).toBe(true);
    });

    it('is false for TypeErrors about missing data and for other errors', () => {
        expect(looksLikeApiDrift(new TypeError('metadata is null'))).toBe(false);
        expect(looksLikeApiDrift(new TypeError("can't access property \"x\", y is undefined"))).toBe(false);
        expect(looksLikeApiDrift(new Error('network'))).toBe(false);
        expect(looksLikeApiDrift(null)).toBe(false);
        expect(looksLikeApiDrift('TypeError')).toBe(false);
    });
});

describe('withTimeout', () => {
    it('resolves with the work result and clears its timer', async () => {
        vi.useFakeTimers();
        await expect(withTimeout(Promise.resolve(42), 1000, 'Work')).resolves.toBe(42);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects with a coded timeout error when the work is too slow', async () => {
        vi.useFakeTimers();
        const pending = withTimeout(new Promise(() => {}), 1500, 'Lookup');
        const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout', message: 'Lookup timed out after 1.5s' });
        await vi.advanceTimersByTimeAsync(1500);
        await assertion;
    });

    it('propagates the work error unchanged', async () => {
        await expect(withTimeout(Promise.reject(new Error('bad')), 1000, 'Work')).rejects.toThrow('bad');
    });
});

describe('getPdfRecognizerData', () => {
    const buf = new ArrayBuffer(8);

    function installWorker(result: unknown) {
        const query = vi.fn(async () => result);
        Z.PDFWorker = { _enqueue: vi.fn(async (fn: () => Promise<unknown>) => fn()), _query: query };
        return query;
    }

    it('returns null without touching the worker when the API is unavailable', async () => {
        Z.PDFWorker = undefined;
        await expect(getPdfRecognizerData(buf, 1000)).resolves.toBeNull();
    });

    it('returns the recognizer data from the PDF worker', async () => {
        const query = installWorker({ pages: [[612, 792, []]] });
        await expect(getPdfRecognizerData(buf, 1000)).resolves.toEqual({ pages: [[612, 792, []]] });
        expect(query).toHaveBeenCalledWith('pdf.getRecognizerData', { buf, password: undefined }, [buf]);
    });

    it.each([[null], [{}], [{ pages: 'x' }]])('marks the API unavailable on a malformed result %j', async (malformed) => {
        installWorker(malformed);
        await expect(getPdfRecognizerData(buf, 1000)).resolves.toBeNull();
        expect(isApiAvailable('pdfRecognizerData')).toBe(false);
        expect(apiStatus('pdfRecognizerData').reason).toContain('no pages array');
    });

    it('marks the API unavailable and rethrows on a TypeError', async () => {
        Z.PDFWorker = {
            _enqueue: vi.fn(async () => { throw new TypeError('worker._query is not a function'); }),
            _query: vi.fn(),
        };
        await expect(getPdfRecognizerData(buf, 1000)).rejects.toThrow('worker._query is not a function');
        expect(isApiAvailable('pdfRecognizerData')).toBe(false);
    });

    it('rethrows a data TypeError without marking the API unavailable', async () => {
        Z.PDFWorker = {
            _enqueue: vi.fn(async () => { throw new TypeError('data is null'); }),
            _query: vi.fn(),
        };
        await expect(getPdfRecognizerData(buf, 1000)).rejects.toThrow('data is null');
        expect(isApiAvailable('pdfRecognizerData')).toBe(true);
    });

    it('rethrows other errors without marking the API unavailable', async () => {
        Z.PDFWorker = {
            _enqueue: vi.fn(async () => { throw new Error('corrupt pdf'); }),
            _query: vi.fn(),
        };
        await expect(getPdfRecognizerData(buf, 1000)).rejects.toThrow('corrupt pdf');
        expect(isApiAvailable('pdfRecognizerData')).toBe(true);
    });
});

describe('recognizerBaseUrl', () => {
    it('uses recognize.url with a trailing slash', () => {
        Z.Prefs.get.mockImplementation((key: string) => (key === 'recognize.url' ? 'https://r.example.org/x' : undefined));
        expect(recognizerBaseUrl()).toBe('https://r.example.org/x/');
    });

    it('derives the URL from services.url', () => {
        Z.Prefs.get.mockImplementation((key: string) => (key === 'services.url' ? 'https://services.example.org' : undefined));
        expect(recognizerBaseUrl()).toBe('https://services.example.org/recognizer/');
    });

    it('is null without any configured URL', () => {
        Z.Prefs.get.mockReturnValue(undefined);
        expect(recognizerBaseUrl()).toBeNull();
    });
});
