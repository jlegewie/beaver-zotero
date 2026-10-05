/**
 * Export Beaver output to files (`addon.exporter`), owned by the plugin realm.
 *
 * A renderer builds the `ExportSource` from its run history and citation
 * state and passes it here as plain data; everything else happens in this
 * realm: parsing, resolving and formatting citations against the library,
 * writing the file (a PDF is printed from the HTML writer's page), and the
 * save dialog (parented to the requesting window).
 */

import type { ExportSource, ExportWarning } from '@beaver/agent-export/types';
import type { WriteDocxResult, WriteHtmlResult } from '@beaver/agent-export/runtime';
import { logger } from '@beaver/agent-core/platform/logger';
import { loadExportRuntime, type ExportRuntime } from './exportRuntime';
import { formatExportCitations } from './exportCitations';
import { printHtmlToPdf } from './printPdf';
import { CitationService } from '../CitationService';

export type ExportFormat = 'docx' | 'pdf';

export interface ExportRequest {
    source: ExportSource;
    format: ExportFormat;
    /** CSL style id; defaults to the citation style preference. */
    styleId?: string;
    /** CSL locale; defaults to the citation locale preference. */
    locale?: string;
    /** Write citations as Zotero fields (Word; default true). */
    liveCitations?: boolean;
    /**
     * Link item references to the library (default: true for Word, false for
     * PDF, where `zotero://` links are of little use).
     */
    linkItems?: boolean;
    /** Write to this path without a save dialog (development endpoints). */
    path?: string;
    /** Return the HTML a PDF was printed from (development endpoints). */
    includeHtml?: boolean;
}

type ExportStats = (WriteDocxResult['stats'] | WriteHtmlResult['stats']) & { clusters: number; bibliographyEntries: number };

export type ExportResult =
    | { status: 'saved'; path: string; warnings: ExportWarning[]; stats: ExportStats; html?: string }
    | { status: 'canceled' };

const FORMATS: Record<ExportFormat, { extension: string; filterTitle: string }> = {
    docx: { extension: 'docx', filterTitle: 'Word Document' },
    pdf: { extension: 'pdf', filterTitle: 'PDF' },
};

function windowUnavailable(): Error {
    return Object.assign(new Error('Target window is unavailable'), { code: 'window_unavailable' });
}

/** A file name for the title: no path separators or reserved characters, bounded length. */
export function exportFileName(title: string, extension: string): string {
    const base = [...title]
        // Control characters and characters reserved in file names.
        .map(char => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? ' ' : char))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
        .trim() || 'Beaver export';
    return `${base}.${extension}`;
}

export class InstanceExport {
    private runtime: ExportRuntime | null = null;
    private ownCitationService: CitationService | null = null;
    /** The save dialog is not modal across windows; one export asks at a time. */
    private choosingPath = false;

    private getRuntime(): ExportRuntime {
        this.runtime ??= loadExportRuntime();
        return this.runtime;
    }

    private async choosePath(request: ExportRequest, windowId: string | undefined): Promise<string | null> {
        const format = FORMATS[request.format];
        const runtime = Zotero.Beaver?.runtime?.resolveWindow(windowId);
        if (!runtime) throw windowUnavailable();
        const { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
        const picker = new FilePicker();
        picker.init(runtime.hostWindow, 'Export', picker.modeSave);
        picker.defaultString = exportFileName(request.source.title, format.extension);
        picker.defaultExtension = format.extension;
        picker.appendFilter(format.filterTitle, `*.${format.extension}`);
        const result = await picker.show();
        if (result !== picker.returnOK && result !== picker.returnReplace) return null;
        // Write exactly where the dialog confirmed (including any overwrite);
        // `defaultExtension` already adds the extension to a bare name.
        return picker.file as string;
    }

    /**
     * Export a source to a file. Asks where to save unless `request.path` is
     * given; `windowId` is the requesting window, which parents the dialog.
     */
    async run(request: ExportRequest, context: { windowId?: string } = {}): Promise<ExportResult> {
        if (!FORMATS[request.format]) throw new Error(`Unsupported export format: ${request.format}`);
        // The sequence API keeps no state between calls, so an export started
        // before startup has assigned the shared service uses its own.
        const citationService = Zotero.Beaver?.citationService
            ?? (this.ownCitationService ??= new CitationService({ log: (message: string) => logger(message, 4) }));

        if (!request.path && this.choosingPath) throw new Error('An export is already waiting for a file name.');
        let path = request.path ?? null;
        if (!path) {
            this.choosingPath = true;
            try {
                path = await this.choosePath(request, context.windowId);
            } finally {
                this.choosingPath = false;
            }
        }
        if (!path) return { status: 'canceled' };

        const started = Date.now();
        const runtime = this.getRuntime();
        const doc = runtime.parseExportSource(request.source);
        const liveCitations = request.format === 'docx' && (request.liveCitations ?? true);
        const { citations, warnings } = await formatExportCitations(doc, request.source.citations, citationService, {
            styleId: request.styleId,
            locale: request.locale,
            liveCitations,
        });
        const bibliographyTitle = citations.styleClass === 'note' ? 'Bibliography' : 'References';
        let written: { warnings: ExportWarning[]; stats: WriteDocxResult['stats'] | WriteHtmlResult['stats'] };
        let html: string | undefined;
        if (request.format === 'pdf') {
            const result = runtime.writeHtml({
                doc,
                citations,
                options: { linkItems: request.linkItems ?? false, bibliographyTitle, notesTitle: 'Notes' },
            });
            await printHtmlToPdf(result.html, path, { title: doc.title.trim() || 'Beaver export', page: result.page });
            written = result;
            if (request.includeHtml) html = result.html;
        } else {
            const result = await runtime.writeDocx({
                doc,
                citations,
                options: { liveCitations, linkItems: request.linkItems ?? true, bibliographyTitle },
            });
            await IOUtils.write(path, result.bytes);
            written = result;
        }
        logger(`InstanceExport: wrote ${request.format} (${doc.clusters.length} citations) in ${Date.now() - started} ms`, 3);

        return {
            status: 'saved',
            path,
            warnings: [...warnings, ...written.warnings],
            stats: {
                ...written.stats,
                clusters: doc.clusters.length,
                bibliographyEntries: citations.bibliography?.entries.length ?? 0,
            },
            ...(html !== undefined ? { html } : {}),
        };
    }

    /** Show an exported file in the system file manager. */
    reveal(path: string): void {
        try {
            Zotero.File.reveal(path);
        } catch (error) {
            logger(`InstanceExport: could not reveal ${path}: ${error}`, 2);
        }
    }

    dispose(): void {
        this.runtime = null;
        this.ownCitationService = null;
    }
}
