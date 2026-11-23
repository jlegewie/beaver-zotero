import { logger } from '@beaver/agent-core/platform/logger';
import { refuseCaptchaChallengeUrls } from '../utils/pdfChallengeUrls';
import { getSystemTimers } from '../utils/systemTimers';
import { isPdfDocument } from '../utils/attachmentFiles';
import { coordinateLibraryMutation } from './libraryMutations';
import { PDF_FETCH_CANCELLED_MESSAGE, type PdfFetchDiagnostics } from './pdfFetchDiagnostics';

const PDF_FETCH_BUDGET_MS = 60_000;

/** A file downloaded into a private temporary storage directory, not yet attached. */
export interface DownloadedFile {
    /** Temporary storage directory; saving moves it into the attachment's storage. */
    directory: string;
    path: string;
    /** The URL the file came from. */
    url: string;
    mimeType: string;
    /** The resolver entry that won (`articleVersion`, ...). */
    props?: Record<string, any>;
    /** A title the resolver supplied (translator walks). */
    title?: string;
    /** Access method of the resolver that won. */
    accessMethod?: string;
}

async function removeDirectory(directory: string | undefined): Promise<void> {
    if (!directory) return;
    try {
        await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
    } catch (error) {
        logger(`PDF temporary storage cleanup failed: ${String(error)}`, 2);
    }
}

/**
 * Download the first available file among `resolvers` into a private
 * temporary directory, without holding the library queue.
 *
 * Downloads go through `downloadFirstAvailableFile` with
 * `shouldDisplayCaptcha: false`, and CAPTCHA challenge URLs are refused, so no
 * window ever opens. The download is bounded by a budget and by `signal`; an
 * abandoned download finishes only into its private directory, which is
 * removed once it settles. Returns null when no resolver produced a file. The
 * caller owns the returned directory: pass it to
 * {@link saveDownloadedAttachment} or {@link discardDownloadedFile}.
 *
 * The caller owns `diagnostics`, so what was tried survives a throw.
 */
export async function downloadAttachmentFile(
    resolvers: Record<string, unknown>[],
    signal: AbortSignal,
    assertAccess: () => void,
    diagnostics?: PdfFetchDiagnostics,
): Promise<DownloadedFile | null> {
    const attachments = Zotero.Attachments as any;
    let directory: string | undefined;
    let abandoned = false;
    let accessMethod: string | undefined;
    let keep = false;
    const assertCurrent = () => {
        if (signal.aborted || abandoned) throw new Error(PDF_FETCH_CANCELLED_MESSAGE);
        assertAccess();
    };
    const cleanup = () => removeDirectory(directory);
    const timers = getSystemTimers();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const stopped = new Promise<never>((_, reject) => {
        cancel = () => {
            abandoned = true;
            diagnostics?.stop();
            reject(new Error(PDF_FETCH_CANCELLED_MESSAGE));
        };
        timer = timers.setTimeout(() => {
            diagnostics?.markTimeout();
            cancel();
        }, PDF_FETCH_BUDGET_MS);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
    });
    // A rejection after the download already settled has no listener.
    stopped.catch(() => {});
    const download = (async () => {
        assertCurrent();
        directory = (await attachments.createTemporaryStorageDirectory()).path;
        assertCurrent();
        const path = PathUtils.join(directory!, 'file.tmp');
        const result = await attachments.downloadFirstAvailableFile(resolvers, path, {
            enforceFileType: true,
            shouldDisplayCaptcha: false,
            onBeforeRequest: (url: string) => {
                // Record first so a refused URL still shows up as an attempt.
                diagnostics?.onBeforeRequest(url);
                assertCurrent();
                refuseCaptchaChallengeUrls(url);
            },
            onAccessMethodStart: (method: string) => {
                accessMethod = method;
                diagnostics?.onAccessMethodStart(method);
            },
            onRequestError: diagnostics?.onRequestError,
        });
        return { result, path };
    })();
    try {
        const { result, path } = await Promise.race([download, stopped]);
        timers.clearTimeout(timer);
        assertCurrent();
        if (!result?.url) return null;
        diagnostics?.markSucceeded();
        const mimeType = result.mimeType || await Zotero.MIME.getMIMETypeFromFile(path);
        if (!attachments.FIND_AVAILABLE_FILE_TYPES.includes(mimeType)) {
            diagnostics?.markUnsupportedType();
            throw new Error(`Resolved file is unsupported type ${mimeType}`);
        }
        keep = true;
        return {
            directory: directory!,
            path,
            url: result.url,
            mimeType,
            props: result.props,
            title: result.title,
            accessMethod,
        };
    } finally {
        timers.clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        if (abandoned) {
            // Zotero's downloader has no abort handle. It can finish only into
            // this private directory; remove it after the writer has settled.
            void download.then(cleanup, cleanup);
        } else if (!keep) {
            await cleanup();
        }
    }
}

/** Remove a downloaded file that will not be attached. */
export async function discardDownloadedFile(file: DownloadedFile | null | undefined): Promise<void> {
    await removeDirectory(file?.directory);
}

export interface SaveDownloadedAttachmentOptions {
    /** Attachment title; also feeds the user's filename template. */
    title: string;
    signal: AbortSignal;
    /** Throws when the save must not happen (cancelled, access revoked). */
    assertCurrent: () => void;
    /** Keep a PDF that is already attached instead of saving another one. */
    skipIfPdfExists?: boolean;
}

/**
 * Save a downloaded file as a child attachment of `item`, keeping its source
 * URL and title. The file is named from the user's Zotero filename template,
 * as Zotero's own "Find Available PDF" names it. Only attachment admission
 * and the save are serialized on the library queue. The temporary directory
 * is always consumed.
 */
export async function saveDownloadedAttachment(
    item: Zotero.Item,
    file: DownloadedFile,
    options: SaveDownloadedAttachmentOptions,
): Promise<{ attachment: Zotero.Item; created: boolean }> {
    const attachments = Zotero.Attachments as any;
    try {
        const baseName = attachments.getFileBaseNameFromItem(item, { attachmentTitle: options.title });
        const extension = Zotero.MIME.getPrimaryExtension(file.mimeType, '') || 'dat';
        const filename = await Zotero.File.rename(file.path, `${baseName}.${extension}`);
        options.assertCurrent();
        return await coordinateLibraryMutation(async () => {
            options.assertCurrent();
            const current = await Zotero.Items.getByLibraryAndKeyAsync(item.libraryID, item.key);
            if (!current || current.deleted) throw new Error('Attachment parent item is unavailable');
            if (options.skipIfPdfExists) {
                const ids = await current.getAttachments();
                const existing = await Promise.all(ids.map(id => Zotero.Items.getAsync(id)));
                options.assertCurrent();
                const pdf = existing.find(candidate => candidate && !candidate.deleted && isPdfDocument(candidate));
                if (pdf) return { attachment: pdf, created: false };
            }
            const attachment = await attachments.createURLAttachmentFromTemporaryStorageDirectory({
                directory: file.directory, libraryID: current.libraryID, parentItemID: current.id,
                filename, title: options.title, url: file.url, contentType: file.mimeType,
            });
            return { attachment, created: true };
        }, { signal: options.signal, assertCurrent: options.assertCurrent });
    } finally {
        await removeDirectory(file.directory);
    }
}

/**
 * Find a PDF for `item` among `resolvers` and attach it, unless a PDF was
 * attached meanwhile. Download without holding the library queue; only
 * attachment admission and saving are serialized.
 *
 * The caller owns `diagnostics`, so what was tried survives a throw.
 */
export async function fetchPdfAttachment(
    item: Zotero.Item,
    resolvers: Record<string, unknown>[],
    signal: AbortSignal,
    assertAccess: () => void,
    diagnostics?: PdfFetchDiagnostics,
): Promise<{ attachment: Zotero.Item | null; accessMethod?: string }> {
    const file = await downloadAttachmentFile(resolvers, signal, assertAccess, diagnostics);
    if (!file) return { attachment: null };
    const version = file.props?.articleVersion;
    const title = file.title || Zotero.getString(`attachment.${
        version === 'accepted' || version === 'acceptedVersion' ? 'acceptedVersion'
            : version === 'submitted' || version === 'submittedVersion' ? 'submittedVersion' : 'fullText'
    }`);
    const assertCurrent = () => {
        if (signal.aborted) throw new Error(PDF_FETCH_CANCELLED_MESSAGE);
        assertAccess();
    };
    const saved = await saveDownloadedAttachment(item, file, { title, signal, assertCurrent, skipIfPdfExists: true });
    return saved.created ? { attachment: saved.attachment, accessMethod: file.accessMethod } : { attachment: saved.attachment };
}
