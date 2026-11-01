import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

/** Each hidden browser takes the next load outcome; prints log their order. */
const state = { loads: [] as boolean[], created: 0, destroyed: 0, events: [] as string[] };

class FakeHiddenBrowser {
    browsingContext = {
        print: async (settings: { toFileName: string }) => {
            state.events.push(`print-start ${settings.toFileName}`);
            await new Promise(resolve => setTimeout(resolve, 5));
            files.set(settings.toFileName, 1);
            state.events.push(`print-end ${settings.toFileName}`);
        },
    };
    constructor() { state.created += 1; }
    async load() { return state.loads.shift() ?? true; }
    async waitForDocument() {}
    destroy() { state.destroyed += 1; }
}

const files = new Map<string, number>();

/** A hidden browser whose page load never returns. */
class StallingHiddenBrowser extends FakeHiddenBrowser {
    load() { return new Promise<boolean>(() => {}); }
}

beforeEach(() => {
    state.loads = [];
    state.created = 0;
    state.destroyed = 0;
    state.events = [];
    files.clear();
    vi.stubGlobal('ChromeUtils', {
        importESModule: (url: string) => (url.includes('HiddenBrowser')
            ? { HiddenBrowser: FakeHiddenBrowser }
            : { setTimeout, clearTimeout }),
    });
    vi.stubGlobal('Zotero', {
        getMainWindow: () => ({}),
        getTempDirectory: () => ({ path: '/tmp' }),
        Utilities: { randomString: () => Math.random().toString(36).slice(2) },
        File: { pathToFileURI: (path: string) => `file://${path}` },
    });
    vi.stubGlobal('PathUtils', { join: (...parts: string[]) => parts.join('/') });
    vi.stubGlobal('IOUtils', {
        writeUTF8: async () => {},
        stat: async (path: string) => (files.has(path) ? { size: 1 } : null),
        move: async (from: string, to: string) => { files.delete(from); files.set(to, 1); },
        remove: async () => {},
    });
    const printSettings = { kOutputDestinationFile: 2, kOutputFormatPDF: 2, kPaperSizeInches: 0, kPaperSizeMillimeters: 1 };
    vi.stubGlobal('Components', {
        classes: { '@mozilla.org/gfx/printsettings-service;1': { getService: () => ({ createNewPrintSettings: () => ({}) }) } },
        interfaces: { nsIPrintSettingsService: {}, nsIPrintSettings: printSettings },
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const page = { size: 'letter' as const, margin: 1, pageNumbers: false };

describe('printHtmlToPdf', () => {
    it('retries a page load that timed out with a fresh hidden browser', async () => {
        const { printHtmlToPdf } = await import('../../../src/services/export/printPdf');
        state.loads = [false, true];
        await printHtmlToPdf('<p>x</p>', '/out/a.pdf', { title: 'A', page });
        expect(files.has('/out/a.pdf')).toBe(true);
        expect(state.created).toBe(2);
        expect(state.destroyed).toBe(2);
    });

    it('gives up after the second failed load and says so', async () => {
        const { printHtmlToPdf } = await import('../../../src/services/export/printPdf');
        state.loads = [false, false];
        await expect(printHtmlToPdf('<p>x</p>', '/out/b.pdf', { title: 'B', page }))
            .rejects.toThrow('The document could not be prepared for printing.');
        expect(state.created).toBe(2);
        expect(files.has('/out/b.pdf')).toBe(false);
    });

    it('destroys a browser whose load never returns when the print times out, and frees the queue', async () => {
        const { printHtmlToPdf } = await import('../../../src/services/export/printPdf');
        // The print timeout fires at once; the first load never settles.
        vi.stubGlobal('ChromeUtils', {
            importESModule: (url: string) => (url.includes('HiddenBrowser')
                ? { HiddenBrowser: StallingHiddenBrowser }
                : { setTimeout: (fn: () => void) => setTimeout(fn, 1), clearTimeout }),
        });
        await expect(printHtmlToPdf('<p>x</p>', '/out/f.pdf', { title: 'F', page })).rejects.toThrow('Printing the PDF timed out.');
        expect(state.created).toBe(1);
        expect(state.destroyed).toBe(1);
    });

    it('prints one document at a time, and a failure does not stop the next', async () => {
        const { printHtmlToPdf } = await import('../../../src/services/export/printPdf');
        state.loads = [false, false];
        const failed = printHtmlToPdf('<p>x</p>', '/out/c.pdf', { title: 'C', page });
        const first = printHtmlToPdf('<p>x</p>', '/out/d.pdf', { title: 'D', page });
        const second = printHtmlToPdf('<p>x</p>', '/out/e.pdf', { title: 'E', page });
        await expect(failed).rejects.toThrow();
        await Promise.all([first, second]);
        const starts = state.events.map(event => event.split(' ')[0]);
        expect(starts).toEqual(['print-start', 'print-end', 'print-start', 'print-end']);
        expect(files.has('/out/d.pdf') && files.has('/out/e.pdf')).toBe(true);
    });
});
