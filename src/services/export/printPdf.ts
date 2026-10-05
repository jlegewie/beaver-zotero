/**
 * Print an HTML document to a PDF file, silently.
 *
 * The document is loaded in one of Zotero's hidden content browsers and
 * printed with fresh print settings whose destination is a PDF file, so no
 * dialog opens and the user's saved printer settings are left alone. The
 * print promise resolves once the file is written.
 *
 * A printable hidden browser lives in a main window's document (Zotero's
 * `HiddenBrowser` with `useHiddenFrame: false`), so printing needs an open
 * main window.
 */

import type { HtmlPageSetup } from '@beaver/agent-export/html/writeHtml';
import { logger } from '@beaver/agent-core/platform/logger';
import { getSystemTimers } from '../../utils/systemTimers';

/** A generous bound for large documents (printing takes well under a second per page). */
const PRINT_TIMEOUT_MS = 180_000;

const PAPER = {
    letter: { id: 'na_letter', unit: 'inches', width: 8.5, height: 11 },
    a4: { id: 'iso_a4', unit: 'millimeters', width: 210, height: 297 },
} as const;

function loadHiddenBrowser(): any {
    try {
        return ChromeUtils.importESModule('chrome://zotero/content/HiddenBrowser.mjs').HiddenBrowser;
    } catch {
        // Zotero 7.0 ships the module as a JSM.
        return (ChromeUtils as any).import('chrome://zotero/content/HiddenBrowser.jsm').HiddenBrowser;
    }
}

/** Wait until the loaded page is complete. */
async function waitForDocument(browser: any): Promise<void> {
    if (typeof browser.waitForDocument === 'function') {
        await browser.waitForDocument();
    } else {
        // Older Zotero: page-data queries wait for the document to be ready.
        await browser.getPageData(['title']);
    }
}

function printSettings(path: string, title: string, page: HtmlPageSetup): any {
    const service = (Components.classes as any)['@mozilla.org/gfx/printsettings-service;1']
        .getService(Components.interfaces.nsIPrintSettingsService);
    const PrintSettings = Components.interfaces.nsIPrintSettings;
    // Fresh settings: printing to a file must not touch the user's printer settings.
    const settings = service.createNewPrintSettings();
    settings.outputDestination = PrintSettings.kOutputDestinationFile;
    settings.outputFormat = PrintSettings.kOutputFormatPDF;
    settings.toFileName = path;
    settings.printSilent = true;
    settings.title = title;

    const paper = PAPER[page.size];
    settings.paperId = paper.id;
    settings.paperSizeUnit = paper.unit === 'inches' ? PrintSettings.kPaperSizeInches : PrintSettings.kPaperSizeMillimeters;
    settings.paperWidth = paper.width;
    settings.paperHeight = paper.height;
    // The stylesheet's `@page` rule sets the same margins.
    settings.marginTop = settings.marginBottom = settings.marginLeft = settings.marginRight = page.margin;

    for (const key of ['headerStrLeft', 'headerStrCenter', 'headerStrRight', 'footerStrLeft', 'footerStrCenter', 'footerStrRight']) {
        settings[key] = '';
    }
    if (page.pageNumbers) settings.footerStrCenter = '&P';
    // Code blocks and table shading are backgrounds.
    settings.printBGColors = true;
    settings.printBGImages = false;
    return settings;
}

/**
 * Print `html` to a PDF at `path`. Resolves when the file is written. The PDF
 * is printed next to the HTML in the temp directory and moved into place only
 * when complete, so a failed print never leaves a partial file at `path`.
 */
export async function printHtmlToPdf(html: string, path: string, options: { title: string; page: HtmlPageSetup }): Promise<void> {
    if (!Zotero.getMainWindow()) {
        throw new Error('PDF export needs an open Zotero window.');
    }
    const HiddenBrowser = loadHiddenBrowser();
    const base = PathUtils.join(Zotero.getTempDirectory().path, `beaver-export-${Zotero.Utilities.randomString(10)}`);
    const source = `${base}.html`;
    const printed = `${base}.pdf`;
    await IOUtils.writeUTF8(source, html);
    const browser = new HiddenBrowser({ useHiddenFrame: false });
    const timers = getSystemTimers();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const work = (async () => {
            if (!await browser.load(Zotero.File.pathToFileURI(source))) {
                throw new Error('The document could not be prepared for printing.');
            }
            // `load()` resolves when the address changes, before the page has
            // loaded; printing then captures an empty page.
            await waitForDocument(browser);
            await browser.browsingContext.print(printSettings(printed, options.title, options.page));
        })();
        // A print that fails after the timeout has nobody left to tell.
        work.catch(() => {});
        await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timeout = timers.setTimeout(() => reject(new Error('Printing the PDF timed out.')), PRINT_TIMEOUT_MS);
            }),
        ]);
        const info = await IOUtils.stat(printed).catch(() => null);
        if (!info?.size) throw new Error('The PDF was not written.');
        try {
            await IOUtils.move(printed, path);
        } catch (error) {
            logger(`printHtmlToPdf: could not move ${printed} to ${path}: ${error}`, 1);
            throw new Error(`Could not save the PDF to ${path}.`);
        }
    } finally {
        if (timeout !== undefined) timers.clearTimeout(timeout);
        browser.destroy();
        for (const file of [source, printed]) {
            IOUtils.remove(file, { ignoreAbsent: true })
                .catch((error: unknown) => logger(`printHtmlToPdf: could not remove ${file}: ${error}`, 2));
        }
    }
}
