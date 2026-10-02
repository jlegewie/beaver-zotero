/**
 * File identification for item import, without creating a Zotero item.
 *
 * - **PDF:** the same two steps as Zotero's "Retrieve Metadata for PDF"
 *   (`RecognizeDocument._recognizePDF`), run on the file buffer instead of a
 *   saved attachment: the PDF worker extracts layout data
 *   (`pdf.getRecognizerData`) and Zotero's recognizer service returns an arXiv
 *   id / DOI / ISBN, or a title and authors. This sends the first pages' text
 *   to Zotero's service — exactly what Zotero does by default when a user adds
 *   a PDF. If those internal APIs are unavailable, recognition is deferred to
 *   after approval and runs through Zotero's own per-file recognizer.
 * - **EPUB:** a port of `RecognizeDocument._recognizeEPUB` for a bare path:
 *   OPF/RDF metadata through the RDF import translator, plus a scan of the
 *   copyright page and first sections for an ISBN or DOI. Fully local except
 *   for the identifier lookup.
 * - Other file types fail with `unsupported_type`.
 */

import type { ImportFileRef, TypedIdentifier } from '@beaver/agent-core/types/itemImport';
import { logger } from '@beaver/agent-core/platform/logger';
import { resolveExternalFile } from '../externalFiles';
import { authorizePath } from './pathAccess';
import {
    getPdfRecognizerData,
    isApiAvailable,
    loadEpubModule,
    looksLikeApiDrift,
    markApiUnavailable,
    queryRecognizerService,
    withTimeout,
    type RecognizerResponse,
} from './zoteroApis';

const EPUB_MAX_SECTIONS = 5;

/** A located, readable file. */
export interface LocatedFile {
    path: string;
    filename: string;
    mimeType: string;
    size: number;
    mtimeMs?: number;
    ref: ImportFileRef;
}

export type FileLocation =
    | { ok: true; file: LocatedFile }
    | { ok: false; code: string; message: string };

export type FileRecognition =
    /** Identifiers to translate, best first, plus whatever else the recognizer returned. */
    | { kind: 'identifiers'; identifiers: TypedIdentifier[]; hints: { abstract?: string; language?: string }; titleItem?: Record<string, any> }
    /** Item JSON already produced from the file (EPUB metadata, or a recognized title). */
    | { kind: 'item'; json: Record<string, any>; translator?: string; hints: { abstract?: string; language?: string } }
    /** The internal APIs are unavailable: recognize after approval with the public API. */
    | { kind: 'deferred'; reason: string }
    | { kind: 'error'; code: 'unrecognized_file' | 'unsupported_type' | 'no_text'; message: string };

const PDF_MIME = 'application/pdf';
const EPUB_MIME = 'application/epub+zip';

function mimeFromName(filename: string, fallback?: string): string {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.pdf')) return PDF_MIME;
    if (lower.endsWith('.epub')) return EPUB_MIME;
    return fallback || 'application/octet-stream';
}

/**
 * Locate the file an import refers to: an attached external file
 * (`ext_key`), or an authorized local path. `threadId` scopes path
 * authorization; `expected` is the size/mtime recorded at resolution.
 */
export async function locateImportFile(
    ref: ImportFileRef,
    options: { threadId?: string | null; recheck?: boolean } = {},
): Promise<FileLocation> {
    if (ref.ext_key) {
        const resolved = await resolveExternalFile(ref.ext_key);
        if (!resolved.ok) {
            return {
                ok: false,
                code: 'file_not_found',
                message: resolved.record
                    ? `The attached file ext-${ref.ext_key} is no longer available on this computer.`
                    : `ext-${ref.ext_key} is not an attached file.`,
            };
        }
        const record = resolved.record;
        return {
            ok: true,
            file: {
                path: record.storedPath,
                filename: record.filename,
                mimeType: record.mimeType || mimeFromName(record.filename),
                size: record.fileSize,
                mtimeMs: record.mtimeMs,
                // Always a copy: Beaver's managed copy can be deleted with the
                // conversation files, so a library item must never link to it.
                ref: { ...ref, filename: record.filename, mime_type: record.mimeType, size: record.fileSize, mode: 'import' },
            },
        };
    }
    if (ref.path) {
        const authorization = await authorizePath(ref.path, {
            threadId: options.threadId,
            expected: options.recheck ? { size: ref.size, mtime_ms: ref.mtime_ms } : undefined,
        });
        if (!authorization.ok) return authorization;
        return {
            ok: true,
            file: {
                path: authorization.path,
                filename: authorization.filename,
                mimeType: authorization.mimeType,
                size: authorization.size,
                mtimeMs: authorization.mtimeMs,
                ref: {
                    ...ref,
                    path: authorization.path,
                    filename: authorization.filename,
                    mime_type: authorization.mimeType,
                    size: authorization.size,
                    mtime_ms: authorization.mtimeMs,
                    mode: ref.mode ?? 'import',
                },
            },
        };
    }
    return { ok: false, code: 'file_not_found', message: 'No file was given.' };
}

/** Identify a located file. */
export async function recognizeFile(file: LocatedFile, timeoutMs: number): Promise<FileRecognition> {
    const mimeType = file.mimeType === PDF_MIME || file.mimeType === EPUB_MIME ? file.mimeType : mimeFromName(file.filename, file.mimeType);
    if (mimeType === PDF_MIME) return recognizePdf(file, timeoutMs);
    if (mimeType === EPUB_MIME) return recognizeEpub(file, timeoutMs);
    return {
        kind: 'error',
        code: 'unsupported_type',
        message: `${file.filename} is not a PDF or EPUB, so Zotero cannot identify it.`,
    };
}

/**
 * Whether a page's recognizer text structure (blocks → lines → words, each word
 * ending in its string) contains any word. A text-less page still carries empty
 * block arrays, so a plain length check would count it as text.
 */
function hasWords(node: unknown, depth = 0): boolean {
    if (typeof node === 'string') return node.trim().length > 0;
    if (!Array.isArray(node) || depth > 8) return false;
    return node.some((child) => hasWords(child, depth + 1));
}

function identifiersFromResponse(response: RecognizerResponse): TypedIdentifier[] {
    const identifiers: TypedIdentifier[] = [];
    // Zotero's own order: arXiv, then DOI, then ISBN.
    if (typeof response.arxiv === 'string' && response.arxiv) identifiers.push({ type: 'arxiv', value: response.arxiv });
    if (typeof response.doi === 'string' && response.doi) identifiers.push({ type: 'doi', value: response.doi });
    if (typeof response.isbn === 'string' && response.isbn) identifiers.push({ type: 'isbn', value: response.isbn });
    return identifiers;
}

/** The minimal item Zotero builds from a recognized title (`_recognizePDF`, last branch). */
function titleItemFromResponse(response: RecognizerResponse): Record<string, any> | undefined {
    if (typeof response.title !== 'string' || !response.title.trim()) return undefined;
    const itemType = response.type === 'book-chapter' ? 'bookSection' : 'journalArticle';
    const json: Record<string, any> = {
        itemType,
        title: response.title,
        creators: (response.authors ?? [])
            .filter((author) => author && (author.firstName || author.lastName))
            .map((author) => ({ creatorType: 'author', firstName: author.firstName ?? '', lastName: author.lastName ?? '' })),
        libraryCatalog: 'Zotero',
    };
    const set = (field: string, value: unknown) => {
        if (typeof value === 'string' && value.trim()) json[field] = value.trim();
    };
    set('abstractNote', response.abstract);
    set('date', response.year);
    set('pages', response.pages);
    set('volume', response.volume);
    set('url', response.url);
    set('language', response.language);
    if (itemType === 'journalArticle') {
        set('issue', response.issue);
        set('ISSN', response.ISSN);
        set('publicationTitle', response.container);
    } else {
        set('bookTitle', response.container);
        set('publisher', response.publisher);
    }
    return json;
}

async function recognizePdf(file: LocatedFile, timeoutMs: number): Promise<FileRecognition> {
    if (!isApiAvailable('pdfRecognizerData') || !isApiAvailable('recognizerService')) {
        return { kind: 'deferred', reason: 'PDF recognition APIs unavailable' };
    }
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    let data: any;
    try {
        const bytes: Uint8Array = await IOUtils.read(file.path);
        const buf = new Uint8Array(bytes).buffer;
        data = await getPdfRecognizerData(buf, Math.min(left(), 20000));
    } catch (error: any) {
        if (error?.code === 'timeout') throw error;
        logger(`itemImport/recognizeFile: recognizer data failed for ${file.filename}: ${error}`, 1);
        if (/password/i.test(String(error?.name ?? error))) {
            return { kind: 'error', code: 'unrecognized_file', message: `${file.filename} is password-protected.` };
        }
        return looksLikeApiDrift(error)
            ? { kind: 'deferred', reason: 'PDF worker API drifted' }
            : { kind: 'error', code: 'unrecognized_file', message: `${file.filename} could not be read as a PDF.` };
    }
    if (!data) return { kind: 'deferred', reason: 'PDF recognition APIs unavailable' };

    const textPages = data.pages.filter((page: any) => hasWords(page?.[2])).length;
    if (!textPages) {
        return { kind: 'error', code: 'no_text', message: `${file.filename} has no text layer (a scan without OCR).` };
    }
    data.fileName = file.filename;

    let response: RecognizerResponse | null;
    try {
        response = await queryRecognizerService(data, Math.min(left(), 20000));
    } catch (error: any) {
        if (error?.code === 'timeout') throw error;
        logger(`itemImport/recognizeFile: recognizer service failed for ${file.filename}: ${error}`, 1);
        return looksLikeApiDrift(error)
            ? { kind: 'deferred', reason: 'recognizer service API drifted' }
            : { kind: 'error', code: 'unrecognized_file', message: `Zotero's recognizer service could not identify ${file.filename}.` };
    }
    if (!response) return { kind: 'deferred', reason: 'recognizer service unavailable' };

    const hints = {
        ...(typeof response.abstract === 'string' && response.abstract ? { abstract: response.abstract } : {}),
        ...(typeof response.language === 'string' && response.language ? { language: response.language } : {}),
    };
    const identifiers = identifiersFromResponse(response);
    const titleItem = titleItemFromResponse(response);
    if (identifiers.length) return { kind: 'identifiers', identifiers, hints, titleItem };
    if (titleItem) return { kind: 'item', json: titleItem, translator: 'Zotero recognizer', hints };
    return { kind: 'error', code: 'unrecognized_file', message: `Zotero could not identify ${file.filename}.` };
}

function cleanISBN(value: string): string | null {
    return ((Zotero.Utilities as any).cleanISBN?.(value) as string | false) || null;
}

function doisFromDocument(doc: any): string[] {
    const pattern = /\b10\.[0-9]{4,}\/[^\s&"']*[^\s&"'.,]/g;
    const found = new Set<string>();
    const trim = (doi: string) => {
        if (doi.endsWith(')') && !doi.includes('(')) doi = doi.slice(0, -1);
        if (doi.endsWith('}') && !doi.includes('{')) doi = doi.slice(0, -1);
        return doi;
    };
    const SHOW_TEXT = 4;
    const walker = doc.createTreeWalker(doc.documentElement, SHOW_TEXT);
    while (walker.nextNode()) {
        const parent = walker.currentNode.parentNode?.tagName?.toLowerCase();
        if (parent === 'script' || parent === 'style') continue;
        for (const match of String(walker.currentNode.nodeValue ?? '').matchAll(pattern)) found.add(trim(match[0]));
    }
    for (const link of Array.from(doc.querySelectorAll('a[href]')) as any[]) {
        const match = String(link.href ?? '').match(/\b10\.[0-9]{4,}\/[^\s&"']*[^\s&"'.,]/);
        if (match) {
            const doi = trim(match[0]);
            if (!found.has(doi) && !found.has(doi.replace(/#.*/, ''))) found.add(doi);
        }
    }
    return Array.from(found);
}

async function translateEpubMetadata(epub: any): Promise<Record<string, any> | null> {
    if (!isApiAvailable('rdfImport')) return null;
    let metadata: string | null;
    try {
        metadata = await epub.getMetadataRDF();
    } catch (error) {
        // A malformed package (no OPF metadata) still has sections to scan.
        if (looksLikeApiDrift(error)) markApiUnavailable('epub', error);
        return null;
    }
    if (!metadata) return null;
    try {
        // Selecting a translator by id needs the translator list loaded, which
        // is lazy right after startup.
        await (Zotero as any).Translators.init?.();
        const translate = new (Zotero as any).Translate.Import();
        translate.setTranslator((Zotero as any).Translators.TRANSLATOR_ID_RDF);
        translate.setString(metadata);
        const [json] = await translate.translate({ libraryID: false, saveAttachments: false });
        return json ?? null;
    } catch (error) {
        if (looksLikeApiDrift(error)) markApiUnavailable('rdfImport', error);
        return null;
    }
}

async function* firstSectionDocuments(epub: any, filename: string): AsyncGenerator<any> {
    try {
        const copyright = await epub.getDocumentByReferenceType('copyright-page');
        if (copyright) yield copyright;
        let count = 0;
        for await (const section of epub.getSectionDocuments()) {
            yield section.doc;
            if (++count >= EPUB_MAX_SECTIONS) break;
        }
    } catch (error) {
        // A package without a usable spine has nothing more to scan.
        if (looksLikeApiDrift(error)) markApiUnavailable('epub', error);
        logger(`itemImport/recognizeFile: could not read the sections of ${filename}: ${error}`, 2);
    }
}

async function recognizeEpub(file: LocatedFile, timeoutMs: number): Promise<FileRecognition> {
    const EPUB = loadEpubModule();
    if (!EPUB) return { kind: 'deferred', reason: 'EPUB module unavailable' };

    let epub: any;
    try {
        epub = new EPUB(file.path);
    } catch (error) {
        if (looksLikeApiDrift(error)) markApiUnavailable('epub', error);
        return { kind: 'error', code: 'unrecognized_file', message: `${file.filename} could not be opened as an EPUB.` };
    }
    try {
        return await withTimeout((async (): Promise<FileRecognition> => {
            const search: Record<string, string> = {};
            const rdfJson = await translateEpubMetadata(epub);
            if (rdfJson && typeof rdfJson.ISBN === 'string') {
                const clean = rdfJson.ISBN.split(' ').map(cleanISBN).filter(Boolean);
                if (clean.length) search.ISBN = clean.join(' ');
            }
            for await (const doc of firstSectionDocuments(epub, file.filename)) {
                if (search.DOI && search.ISBN) break;
                if (!search.DOI) {
                    const dois = doisFromDocument(doc);
                    if (dois.length) search.DOI = dois[0];
                }
                if (!search.ISBN && doc.body) {
                    const isbn = cleanISBN(doc.body.innerText ?? doc.body.textContent ?? '');
                    if (isbn) search.ISBN = isbn;
                }
            }

            if (search.ISBN || search.DOI) {
                try {
                    const translate = new (Zotero as any).Translate.Search();
                    translate.setSearch(search);
                    const [json] = await translate.translate({ libraryID: false, saveAttachments: false });
                    const isbnMismatch = search.ISBN && json?.ISBN
                        && !String(json.ISBN).split(' ').map(cleanISBN).includes(search.ISBN);
                    if (json && !isbnMismatch) return { kind: 'item', json, translator: 'Zotero EPUB recognizer', hints: {} };
                } catch (error) {
                    logger(`itemImport/recognizeFile: EPUB identifier lookup failed for ${file.filename}: ${error}`, 2);
                }
            }
            if (rdfJson) return { kind: 'item', json: rdfJson, translator: 'EPUB metadata', hints: {} };
            return { kind: 'error', code: 'unrecognized_file', message: `Zotero could not identify ${file.filename}.` };
        })(), timeoutMs, 'Identifying the EPUB');
    } catch (error: any) {
        if (error?.code === 'timeout') throw error;
        if (looksLikeApiDrift(error)) {
            markApiUnavailable('epub', error);
            return { kind: 'deferred', reason: 'EPUB API drifted' };
        }
        return { kind: 'error', code: 'unrecognized_file', message: `${file.filename} could not be read as an EPUB.` };
    } finally {
        try { epub.close(); } catch { /* already closed */ }
    }
}
