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

import type { ExportDoc, ExportImage, ExportSource, ExportWarning, FormattedCitations, LatexCitationPackage } from '@beaver/agent-export/types';
import type { WriteDocxResult, WriteHtmlResult, WriteLatexResult, WriteMarkdownResult } from '@beaver/agent-export/runtime';
import { logger } from '@beaver/agent-core/platform/logger';
import { loadExportRuntime, type ExportRuntime } from './exportRuntime';
import { formatExportCitations } from './exportCitations';
import { loadNoteImages } from './noteImages';
import { readNoteForExport } from './noteExportSource';
import { resolveLibraryRef } from '../../utils/libraryIdentity';
import { getLatestNoteHtml } from '../../utils/noteEditorIO';
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

/**
 * Export of a Zotero note (`addon.exporter.exportNote`): the note as it is
 * now, whoever wrote it. Format options are those of `ExportRequest`.
 */
export interface NoteExportRequest extends Omit<ExportRequest, 'source'> {
    /** The note: its key and library (`libraryRef` preferred, or a local `libraryID`; default the user library). */
    note?: { key: string; libraryRef?: string; libraryID?: number };
    /**
     * The note's content as one editor shows it (with `note`; by default, the
     * latest content of any open editor). Without `note`, development
     * endpoints export this HTML with no note in the library.
     */
    html?: string;
    /** Title (file name) for `html`. */
    title?: string;
    /**
     * Keep text colors, highlights and cell backgrounds (default: on for
     * Word and PDF, off for LaTeX, where they need extra packages).
     */
    colors?: boolean;
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

/** Who asked for an export: the window that parents the save dialog. */
export interface ExportContext {
    /** A Beaver window runtime id. */
    windowId?: string;
    /** A window with no Beaver runtime (such as a note window); takes precedence over `windowId`. */
    window?: Window;
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

/** What a write needs besides the document: the request's format options and the source's extras. */
type WriteSettings = Omit<ExportRequest, 'source'> & {
    provenance?: ExportSource['provenance'];
    /** Images of a note document, by asset id. */
    images?: Record<string, ExportImage>;
};

/** Names the document a folder of exported images belongs to, so a later export of it may write there again. */
const IMAGE_FOLDER_MARKER = '.beaver-export';

/**
 * A folder for a document's images, next to it and named after it
 * (`<name>-figures`, or `<name>_files` for Markdown), in characters LaTeX
 * reads in a path. An existing folder is reused only when an export of the
 * same document made it; otherwise the next free numbered name is used.
 * Without `create`, only an existing folder of the document is returned.
 */
async function imageFolder(documentPath: string, suffix: string, create: true): Promise<string>;
async function imageFolder(documentPath: string, suffix: string, create: false): Promise<string | null>;
async function imageFolder(documentPath: string, suffix: string, create: boolean): Promise<string | null> {
    const directory = PathUtils.parent(documentPath) ?? '';
    const owner = `Images of ${PathUtils.filename(documentPath)}, exported by Beaver.`;
    const base = `${PathUtils.filename(documentPath).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'export'}${suffix}`;
    for (let index = 1; index < 1000; index++) {
        const folder = PathUtils.join(directory, index === 1 ? base : `${base}-${index}`);
        const marker = PathUtils.join(folder, IMAGE_FOLDER_MARKER);
        if (!await IOUtils.exists(folder)) {
            if (!create) return null;
            await IOUtils.makeDirectory(folder, { createAncestors: false });
            await IOUtils.writeUTF8(marker, `${owner}\n`);
            return folder;
        }
        const content = await IOUtils.readUTF8(marker).catch(() => '');
        if (content.trim() === owner) return folder;
    }
    throw new Error('Could not find a folder name for the exported images.');
}

/** Files written next to a document, put in place together with it. */
interface StagedFiles {
    /** The files, in the order given. */
    files: string[];
    /** Put the files in place, keeping what they replace until `finish` or `restore`. */
    commit(): Promise<void>;
    /** The document is written: drop the replaced files. */
    finish(): Promise<void>;
    /** The export failed: put the replaced files back and remove the new ones. */
    restore(): Promise<void>;
}

const quietly = (operation: Promise<unknown>) => operation.catch((error: unknown) => logger(`InstanceExport: file: ${error}`, 1));

/**
 * Stage the files that go next to a document (its bibliography, its images)
 * under temporary names. `commit` swaps them in, keeping what they replace,
 * so a document that then fails to write leaves an earlier export as it was;
 * `finish` runs `onFinish` once everything is in place.
 */
async function stageFiles(
    entries: Array<{ path: string; data: Uint8Array | string }>,
    onFinish?: () => Promise<void>,
): Promise<StagedFiles> {
    const staged: Array<{ temporary: string; path: string; backup: string; replaced: boolean; placed: boolean }> = [];
    const restore = async () => {
        for (const file of staged) {
            if (file.placed) await quietly(IOUtils.remove(file.path, { ignoreAbsent: true }));
            if (file.replaced) await quietly(IOUtils.move(file.backup, file.path, { noOverwrite: false }));
            await quietly(IOUtils.remove(file.temporary, { ignoreAbsent: true }));
        }
    };
    try {
        for (const entry of entries) {
            const directory = PathUtils.parent(entry.path) ?? '';
            const name = PathUtils.filename(entry.path);
            const file = {
                temporary: PathUtils.join(directory, `.${name}.partial`),
                path: entry.path,
                backup: PathUtils.join(directory, `.${name}.previous`),
                replaced: false,
                placed: false,
            };
            staged.push(file);
            if (typeof entry.data === 'string') await IOUtils.writeUTF8(file.temporary, entry.data);
            else await IOUtils.write(file.temporary, entry.data);
        }
    } catch (error) {
        await restore();
        throw error;
    }
    return {
        files: staged.map(file => file.path),
        commit: async () => {
            for (const file of staged) {
                if (await IOUtils.exists(file.path)) {
                    await IOUtils.move(file.path, file.backup, { noOverwrite: false });
                    file.replaced = true;
                }
                await IOUtils.move(file.temporary, file.path, { noOverwrite: false });
                file.placed = true;
            }
        },
        finish: async () => {
            for (const file of staged) {
                if (file.replaced) await quietly(IOUtils.remove(file.backup, { ignoreAbsent: true }));
            }
            await onFinish?.();
        },
        restore,
    };
}

/**
 * A document's images as files in its image folder, each with its path
 * relative to the document. LaTeX gets the PNG rendering of SVG and GIF
 * images. `removeStale` removes images an earlier export of the document had
 * and this one does not (also when this one has none).
 */
async function imageFiles(
    documentPath: string,
    images: Record<string, ExportImage>,
    format: 'latex' | 'markdown',
): Promise<{ images: Record<string, ExportImage>; entries: Array<{ path: string; data: Uint8Array }>; removeStale: () => Promise<void> }> {
    const suffix = format === 'latex' ? '-figures' : '_files';
    const folder = Object.keys(images).length > 0
        ? await imageFolder(documentPath, suffix, true)
        : await imageFolder(documentPath, suffix, false);
    const entries: Array<{ path: string; data: Uint8Array }> = [];
    const out: Record<string, ExportImage> = {};
    const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
    for (const [id, image] of folder ? Object.entries(images) : []) {
        // LaTeX's graphics drivers read neither SVG nor GIF.
        const usePng = format === 'latex' && (image.mime === 'image/svg+xml' || image.mime === 'image/gif');
        const data = usePng ? image.png : image.data;
        const extension = usePng ? 'png' : extensions[image.mime];
        if (!data || !extension) continue;
        const name = `${id}.${extension}`;
        entries.push({ path: PathUtils.join(folder!, name), data });
        out[id] = { ...image, path: `${PathUtils.filename(folder!)}/${name}` };
    }
    const removeStale = async () => {
        if (!folder) return;
        const current = new Set(entries.map(entry => entry.path));
        const children = await IOUtils.getChildren(folder).catch(() => [] as string[]);
        for (const child of children) {
            if (/^image-\d+\.(?:png|jpg|gif|svg)$/.test(PathUtils.filename(child)) && !current.has(child)) {
                await quietly(IOUtils.remove(child, { ignoreAbsent: true }));
            }
        }
    };
    return { images: out, entries, removeStale };
}

/** Citation state of a source with no Beaver citation tags (a Zotero note). */
const EMPTY_SNAPSHOT = { citationsByKey: {}, externalReferences: {}, externalItemMapping: {}, pageLabelsByAttachmentId: {} };

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
    /** Writes in progress by destination: exports to one path write one after another. */
    private readonly writing = new Map<string, Promise<unknown>>();

    private getRuntime(): ExportRuntime {
        this.runtime ??= loadExportRuntime();
        return this.runtime;
    }

    private async choosePath(exportFormat: ExportFormat, title: string, context: ExportContext): Promise<string | null> {
        const format = FORMATS[exportFormat];
        const parent = context.window ?? Zotero.Beaver?.runtime?.resolveWindow(context.windowId)?.hostWindow;
        if (!parent || parent.closed) throw windowUnavailable();
        const { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
        const picker = new FilePicker();
        picker.init(parent, 'Export', picker.modeSave);
        picker.defaultString = exportFileName(title, format.extension);
        picker.defaultExtension = format.extension;
        picker.appendFilter(format.filterTitle, `*.${format.extension}`);
        const result = await picker.show();
        if (result !== picker.returnOK && result !== picker.returnReplace) return null;
        // Write exactly where the dialog confirmed (including any overwrite);
        // `defaultExtension` already adds the extension to a bare name.
        return picker.file as string;
    }

    /** The citation service; an export started before startup assigned the shared one uses its own (the sequence API keeps no state). */
    private citationService(): Pick<CitationService, 'formatCitationSequence' | 'resolveStyle'> {
        return Zotero.Beaver?.citationService
            ?? (this.ownCitationService ??= new CitationService({ log: (message: string) => logger(message, 4) }));
    }

    /** `path`, or where the user chooses to save (null when canceled). */
    private async outputPath(format: ExportFormat, title: string, path: string | undefined, context: ExportContext): Promise<string | null> {
        if (path) return path;
        if (this.choosingPath) throw new Error('An export is already waiting for a file name.');
        this.choosingPath = true;
        try {
            return await this.choosePath(format, title, context);
        } finally {
            this.choosingPath = false;
        }
    }

    /**
     * Export a source to a file. Asks where to save unless `request.path` is
     * given; the requesting window parents the dialog.
     */
    async run(request: ExportRequest, context: ExportContext = {}): Promise<ExportResult> {
        if (!FORMATS[request.format]) throw new Error(`Unsupported export format: ${request.format}`);
        const citationService = this.citationService();
        const path = await this.outputPath(request.format, request.source.title, request.path, context);
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
        return this.writeResult(runtime, { ...request, provenance: request.source.provenance }, path, doc, citations, warnings, started);
    }

    /**
     * Export a Zotero note as it is now: its content as the note editor shows
     * it, and its citations as stored (live Zotero citations in Word). Asks
     * where to save unless `request.path` is given; the requesting window
     * parents the dialog.
     */
    async exportNote(request: NoteExportRequest, context: ExportContext = {}): Promise<ExportResult> {
        if (!FORMATS[request.format]) throw new Error(`Unsupported export format: ${request.format}`);
        let note: Zotero.Item | null = null;
        let html: string;
        let title: string;
        if (request.note) {
            // Without a library, the note is in the user's own library.
            const libraryID = request.note.libraryRef || request.note.libraryID
                ? resolveLibraryRef({ library_ref: request.note.libraryRef, library_id: request.note.libraryID ?? 0 })
                : Zotero.Libraries.userLibraryID;
            const item = libraryID ? await Zotero.Items.getByLibraryAndKeyAsync(libraryID, request.note.key) : null;
            if (!item || !(item as Zotero.Item).isNote()) {
                throw Object.assign(new Error('The note could not be found.'), { code: 'note_not_found' });
            }
            note = item as Zotero.Item;
            await note.loadAllData();
            // An open editor may hold edits Zotero has not saved yet.
            html = typeof request.html === 'string' ? request.html : getLatestNoteHtml(note);
            title = note.getNoteTitle() || 'Note';
        } else if (typeof request.html === 'string') {
            html = request.html;
            title = request.title?.trim() || 'Note';
        } else {
            throw new Error('A note or note HTML is required.');
        }

        const path = await this.outputPath(request.format, title, request.path, context);
        if (!path) return { status: 'canceled' };

        const started = Date.now();
        const runtime = this.getRuntime();
        const { doc: json, citationItems } = readNoteForExport(html);
        const colors = request.colors ?? (request.format === 'docx' || request.format === 'pdf');
        const doc = runtime.parseNoteDoc(json, { colors });
        const liveCitations = request.format === 'docx' && (request.liveCitations ?? true);
        // Image files load and decode while the citations are formatted.
        const [{ citations, warnings }, { images, missing, remote }] = await Promise.all([
            formatExportCitations(doc, EMPTY_SNAPSHOT, this.citationService(), {
                styleId: request.styleId,
                locale: request.locale,
                liveCitations,
                noteCitationItems: citationItems,
            }),
            loadNoteImages(note, doc.images ?? {}),
        ]);
        if (missing > 0) {
            warnings.push({
                code: 'images_missing',
                message: `${missing} image${missing === 1 ? '' : 's'} could not be loaded and ${missing === 1 ? 'was' : 'were'} left out.`,
                count: missing,
            });
        }
        if (remote > 0) {
            warnings.push({
                code: 'images_linked',
                message: `${remote} image${remote === 1 ? '' : 's'} on the web ${remote === 1 ? 'is' : 'are'} linked, not included.`,
                count: remote,
            });
        }
        return this.writeResult(runtime, { ...request, images }, path, doc, citations, warnings, started);
    }

    /** Write the document and report what was saved, with the warnings gathered so far. */
    private async writeResult(
        runtime: ExportRuntime,
        settings: WriteSettings,
        path: string,
        doc: ExportDoc,
        citations: FormattedCitations,
        warnings: ExportWarning[],
        started: number,
    ): Promise<ExportResult> {
        const bibliographyTitle = citations.styleClass === 'note' ? 'Bibliography' : 'References';
        const written = await this.write(runtime, settings, path, doc, citations, bibliographyTitle);
        logger(`InstanceExport: wrote ${settings.format} (${doc.clusters.length} citations) in ${Date.now() - started} ms`, 3);
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

    /**
     * Write the document in the requested format at `path`, after any other
     * write to the same path (their image and bibliography files would collide).
     */
    private write(...args: Parameters<InstanceExport['writeFiles']>): Promise<WrittenExport> {
        const path = args[2];
        const previous = this.writing.get(path) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(() => this.writeFiles(...args));
        this.writing.set(path, next);
        const release = () => {
            if (this.writing.get(path) === next) this.writing.delete(path);
        };
        next.then(release, release);
        return next;
    }

    private async writeFiles(
        runtime: ExportRuntime,
        request: WriteSettings,
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
                    images: request.images,
                });
                await printHtmlToPdf(result.html, path, { title: doc.title.trim() || 'Beaver export', page: result.page });
                return { files: [path], warnings: result.warnings, stats: result.stats, ...(request.includeHtml ? { html: result.html } : {}) };
            }
            case 'markdown': {
                const threadId = request.provenance?.threadId;
                const runIds = request.provenance?.runIds ?? [];
                const frontMatter = request.frontMatter
                    ? {
                        date: new Date().toISOString().slice(0, 10),
                        ...(threadId && runIds.length > 0 ? { source: `zotero://beaver/thread/${threadId}/run/${runIds[runIds.length - 1]}` } : {}),
                    }
                    : null;
                const images = request.images ? await imageFiles(path, request.images, 'markdown') : null;
                const result = runtime.writeMarkdown({
                    doc,
                    citations,
                    options: { linkItems: request.linkItems ?? false, bibliographyTitle, frontMatter },
                    images: images?.images,
                });
                const staged = await stageFiles(images?.entries ?? [], images?.removeStale);
                try {
                    // Images first: the document is replaced only once they are in place.
                    await staged.commit();
                    await IOUtils.writeUTF8(path, result.markdown);
                    await staged.finish();
                } catch (error) {
                    await staged.restore();
                    throw error;
                }
                return { files: [path, ...staged.files], warnings: result.warnings, stats: result.stats };
            }
            case 'latex': {
                const citationPackage = request.citationPackage === 'natbib' ? 'natbib' : 'biblatex';
                const cited = citations.clusters.flatMap(cluster => cluster.items);
                const bibliography = cited.length > 0
                    ? await buildBibliographyFile(cited, citationPackage === 'natbib' ? 'bibtex' : 'biblatex')
                    : null;
                const bibPath = bibliography && Object.keys(bibliography.keys).length > 0 ? await bibliographyPath(path) : null;
                const images = request.images ? await imageFiles(path, request.images, 'latex') : null;
                const result = runtime.writeLatex({
                    doc,
                    citations,
                    images: images?.images,
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
                const staged = await stageFiles([
                    ...(bibPath && bibliography
                        ? [{ path: bibPath, data: `${bibliographyHeader(PathUtils.filename(path))}\n\n${bibliography.bib}\n` }]
                        : []),
                    ...(images?.entries ?? []),
                ], images?.removeStale);
                try {
                    // The bibliography and images first: the document is replaced only
                    // once they are in place, and a failure puts the earlier ones back.
                    await staged.commit();
                    await IOUtils.writeUTF8(path, result.tex);
                    await staged.finish();
                } catch (error) {
                    await staged.restore();
                    throw error;
                }
                return { files: [path, ...staged.files], warnings: result.warnings, stats: result.stats };
            }
            default: {
                const liveCitations = request.liveCitations ?? true;
                const result = await runtime.writeDocx({
                    doc,
                    citations,
                    options: { liveCitations, linkItems: request.linkItems ?? true, bibliographyTitle },
                    images: request.images,
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
