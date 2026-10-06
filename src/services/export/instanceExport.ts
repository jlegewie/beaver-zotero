/**
 * Export Beaver output to files (`addon.exporter`), owned by the plugin realm.
 *
 * A renderer builds the `ExportSource` from its run history and citation
 * state and passes it here as plain data; everything else happens in this
 * realm: parsing, resolving and formatting citations against the library,
 * writing the file (a PDF is printed from the HTML writer's page; LaTeX gets
 * a .bib file next to it), and the save dialog (parented to the requesting
 * window).
 */

import type { ExportDoc, ExportSource, ExportWarning, FormattedCitations, LatexCitationPackage } from '@beaver/agent-export/types';
import type { WriteDocxResult, WriteHtmlResult, WriteLatexResult, WriteMarkdownResult } from '@beaver/agent-export/runtime';
import { logger } from '@beaver/agent-core/platform/logger';
import { loadExportRuntime, type ExportRuntime } from './exportRuntime';
import { formatExportCitations } from './exportCitations';
import { printHtmlToPdf } from './printPdf';
import { BIB_FILE_MARKER, buildBibliographyFile } from './bibliographyFile';
import { CitationService } from '../CitationService';

export type ExportFormat = 'docx' | 'pdf' | 'markdown' | 'latex';

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
     * the other formats, where `zotero://` links are of little use).
     */
    linkItems?: boolean;
    /** Markdown: YAML front matter with the title, date and source thread (default false). */
    frontMatter?: boolean;
    /** LaTeX: cite with biblatex and Biber (default) or natbib and BibTeX. */
    citationPackage?: LatexCitationPackage;
    /** LaTeX: a complete document (default) or only its body. */
    standalone?: boolean;
    /** Write to this path without a save dialog (development endpoints). */
    path?: string;
    /** Return the HTML a PDF was printed from (development endpoints). */
    includeHtml?: boolean;
}

type WriterStats = WriteDocxResult['stats'] | WriteHtmlResult['stats'] | WriteMarkdownResult['stats'] | WriteLatexResult['stats'];
type ExportStats = WriterStats & { clusters: number; bibliographyEntries: number };

export type ExportResult =
    | {
        status: 'saved';
        /** The exported document. */
        path: string;
        /** Every file written, the document first (LaTeX adds its .bib file). */
        files: string[];
        warnings: ExportWarning[];
        stats: ExportStats;
        html?: string;
    }
    | { status: 'canceled' };

const FORMATS: Record<ExportFormat, { extension: string; filterTitle: string }> = {
    docx: { extension: 'docx', filterTitle: 'Word Document' },
    pdf: { extension: 'pdf', filterTitle: 'PDF' },
    markdown: { extension: 'md', filterTitle: 'Markdown' },
    latex: { extension: 'tex', filterTitle: 'LaTeX' },
};

/** Written output of one format. */
interface WrittenExport {
    files: string[];
    warnings: ExportWarning[];
    stats: WriterStats;
    html?: string;
}

function windowUnavailable(): Error {
    return Object.assign(new Error('Target window is unavailable'), { code: 'window_unavailable' });
}

/**
 * A file name for the title: no path separators or reserved characters,
 * bounded length. A .tex name also avoids the characters that stop TeX from
 * opening the file.
 */
export function exportFileName(title: string, extension: string): string {
    const reserved = extension === 'tex' ? '\\/:*?"<>|%$' : '\\/:*?"<>|';
    const base = [...title]
        // Control characters and characters reserved in file names.
        .map(char => (char.charCodeAt(0) < 32 || reserved.includes(char) ? ' ' : char))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
        .trim() || 'Beaver export';
    return `${base}.${extension}`;
}

/**
 * Characters that break a bibliography name in `\addbibresource` /
 * `\bibliography` (BibTeX reads a comma as a separator between files).
 */
const UNSAFE_BIB_NAME = /[\s%#{}\\~$&^,]+/g;

/** First line of a .bib file an export wrote, naming the document it belongs to. */
export function bibliographyHeader(texFileName: string): string {
    return `${BIB_FILE_MARKER} for ${texFileName}.`;
}

/**
 * Where a LaTeX export's .bib file goes: next to the .tex file, named after
 * it. An existing file of that name is replaced only when an export of the
 * same document wrote it; otherwise the next free numbered name is used.
 */
export async function bibliographyPath(texPath: string): Promise<string> {
    const directory = PathUtils.parent(texPath) ?? '';
    const base = PathUtils.filename(texPath).replace(/\.tex$/i, '').replace(UNSAFE_BIB_NAME, '-').replace(/^-+|-+$/g, '') || 'references';
    for (let index = 1; index < 1000; index++) {
        const path = PathUtils.join(directory, index === 1 ? `${base}.bib` : `${base}-${index}.bib`);
        if (!await IOUtils.exists(path)) return path;
        const content = await IOUtils.readUTF8(path).catch(() => '');
        if (content.split('\n', 1)[0] === bibliographyHeader(PathUtils.filename(texPath))) return path;
    }
    throw new Error('Could not find a name for the bibliography file.');
}

/** Today's date, written out in the citation locale (`October 5, 2026`). */
function longDate(locale: string): string {
    try {
        return new Date().toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
        return new Date().toISOString().slice(0, 10);
    }
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
        const written = await this.write(runtime, request, path, doc, citations, bibliographyTitle);
        logger(`InstanceExport: wrote ${request.format} (${doc.clusters.length} citations) in ${Date.now() - started} ms`, 3);

        return {
            status: 'saved',
            path,
            files: written.files,
            warnings: [...warnings, ...written.warnings],
            stats: {
                ...written.stats,
                clusters: doc.clusters.length,
                bibliographyEntries: citations.bibliography?.entries.length ?? 0,
            },
            ...(written.html !== undefined ? { html: written.html } : {}),
        };
    }

    /** Write the document in the requested format at `path`. */
    private async write(
        runtime: ExportRuntime,
        request: ExportRequest,
        path: string,
        doc: ExportDoc,
        citations: FormattedCitations,
        bibliographyTitle: string,
    ): Promise<WrittenExport> {
        switch (request.format) {
            case 'pdf': {
                const result = runtime.writeHtml({
                    doc,
                    citations,
                    options: { linkItems: request.linkItems ?? false, bibliographyTitle, notesTitle: 'Notes' },
                });
                await printHtmlToPdf(result.html, path, { title: doc.title.trim() || 'Beaver export', page: result.page });
                return { files: [path], warnings: result.warnings, stats: result.stats, ...(request.includeHtml ? { html: result.html } : {}) };
            }
            case 'markdown': {
                const { threadId, runIds } = request.source.provenance;
                const frontMatter = request.frontMatter
                    ? {
                        date: new Date().toISOString().slice(0, 10),
                        ...(threadId && runIds.length > 0 ? { source: `zotero://beaver/thread/${threadId}/run/${runIds[runIds.length - 1]}` } : {}),
                    }
                    : null;
                const result = runtime.writeMarkdown({
                    doc,
                    citations,
                    options: { linkItems: request.linkItems ?? false, bibliographyTitle, frontMatter },
                });
                await IOUtils.writeUTF8(path, result.markdown);
                return { files: [path], warnings: [], stats: result.stats };
            }
            case 'latex': {
                const citationPackage = request.citationPackage === 'natbib' ? 'natbib' : 'biblatex';
                const cited = citations.clusters.flatMap(cluster => cluster.items);
                const bibliography = cited.length > 0
                    ? await buildBibliographyFile(cited, citationPackage === 'natbib' ? 'bibtex' : 'biblatex')
                    : null;
                const bibPath = bibliography && Object.keys(bibliography.keys).length > 0 ? await bibliographyPath(path) : null;
                const result = runtime.writeLatex({
                    doc,
                    citations,
                    keys: bibliography?.keys ?? {},
                    options: {
                        citationPackage,
                        standalone: request.standalone ?? true,
                        bibFileName: bibPath ? PathUtils.filename(bibPath) : null,
                        linkItems: request.linkItems ?? false,
                        bibliographyTitle,
                        date: longDate(citations.locale),
                    },
                });
                const files = [path];
                // The bibliography first: a .tex file without it would not compile.
                let previousBib: string | null = null;
                if (bibPath && bibliography) {
                    if (await IOUtils.exists(bibPath)) previousBib = await IOUtils.readUTF8(bibPath);
                    await IOUtils.writeUTF8(bibPath, `${bibliographyHeader(PathUtils.filename(path))}\n\n${bibliography.bib}\n`);
                    files.push(bibPath);
                }
                try {
                    await IOUtils.writeUTF8(path, result.tex);
                } catch (error) {
                    // The previous export's document still needs its bibliography;
                    // a new bibliography without its document is of no use.
                    if (bibPath && files.includes(bibPath)) {
                        const restore = previousBib !== null
                            ? IOUtils.writeUTF8(bibPath, previousBib)
                            : IOUtils.remove(bibPath, { ignoreAbsent: true });
                        await restore.catch((restoreError: unknown) => logger(`InstanceExport: could not restore ${bibPath}: ${restoreError}`, 1));
                    }
                    throw error;
                }
                return { files, warnings: result.warnings, stats: result.stats };
            }
            default: {
                const liveCitations = request.liveCitations ?? true;
                const result = await runtime.writeDocx({
                    doc,
                    citations,
                    options: { liveCitations, linkItems: request.linkItems ?? true, bibliographyTitle },
                });
                await IOUtils.write(path, result.bytes);
                return { files: [path], warnings: result.warnings, stats: result.stats };
            }
        }
    }

    /** Show an exported file in the system file manager. */
    async reveal(path: string): Promise<void> {
        try {
            await Zotero.File.reveal(path);
        } catch (error) {
            logger(`InstanceExport: could not reveal ${path}: ${error}`, 2);
            throw new Error('The exported file could not be found. It may have been moved or deleted.');
        }
    }

    /** Open an exported file in the system's default application for its type. */
    async open(path: string): Promise<void> {
        if (!await IOUtils.exists(path)) {
            throw new Error('The exported file could not be found. It may have been moved or deleted.');
        }
        Zotero.launchFile(path);
    }

    dispose(): void {
        this.runtime = null;
        this.ownCitationService = null;
    }
}
