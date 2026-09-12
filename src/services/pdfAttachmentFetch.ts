import { logger } from '@beaver/agent-core/platform/logger';
import { refuseCaptchaChallengeUrls } from '../utils/pdfChallengeUrls';
import { getSystemTimers } from '../utils/systemTimers';
import { coordinateLibraryMutation } from './libraryMutations';

const PDF_FETCH_BUDGET_MS = 60_000;

/** Download without holding the library queue; only attachment admission and saving are serialized. */
export async function fetchPdfAttachment(
    item: Zotero.Item,
    resolvers: Record<string, unknown>[],
    signal: AbortSignal,
    assertAccess: () => void,
): Promise<{ attachment: Zotero.Item | null; accessMethod?: string }> {
    const attachments = Zotero.Attachments as any;
    let directory: string | undefined;
    let abandoned = false;
    let accessMethod: string | undefined;
    const assertCurrent = () => {
        if (signal.aborted || abandoned) throw new Error('PDF fetch cancelled or timed out');
        assertAccess();
    };
    const cleanup = async () => {
        if (!directory) return;
        try {
            await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
        } catch (error) {
            logger(`PDF temporary storage cleanup failed: ${String(error)}`, 2);
        }
    };
    const timers = getSystemTimers();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const stopped = new Promise<never>((_, reject) => {
        cancel = () => {
            abandoned = true;
            reject(new Error('PDF fetch cancelled or timed out'));
        };
        timer = timers.setTimeout(cancel, PDF_FETCH_BUDGET_MS);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
    });
    const download = (async () => {
        assertCurrent();
        directory = (await attachments.createTemporaryStorageDirectory()).path;
        assertCurrent();
        const path = PathUtils.join(directory!, 'file.tmp');
        const result = await attachments.downloadFirstAvailableFile(resolvers, path, {
            enforceFileType: true,
            shouldDisplayCaptcha: false,
            onBeforeRequest: (url: string) => {
                assertCurrent();
                refuseCaptchaChallengeUrls(url);
            },
            onAccessMethodStart: (method: string) => { accessMethod = method; },
        });
        return { result, path };
    })();
    try {
        const { result, path } = await Promise.race([download, stopped]);
        timers.clearTimeout(timer);
        assertCurrent();
        if (!result?.url) return { attachment: null };
        const mimeType = result.mimeType || await Zotero.MIME.getMIMETypeFromFile(path);
        if (!attachments.FIND_AVAILABLE_FILE_TYPES.includes(mimeType)) {
            throw new Error(`Resolved file is unsupported type ${mimeType}`);
        }
        const version = result.props?.articleVersion;
        const title = result.title || Zotero.getString(`attachment.${
            version === 'accepted' || version === 'acceptedVersion' ? 'acceptedVersion'
                : version === 'submitted' || version === 'submittedVersion' ? 'submittedVersion' : 'fullText'
        }`);
        const baseName = attachments.getFileBaseNameFromItem(item, { attachmentTitle: title });
        const extension = Zotero.MIME.getPrimaryExtension(mimeType, '') || 'dat';
        const filename = await Zotero.File.rename(path, `${baseName}.${extension}`);
        assertCurrent();
        return await coordinateLibraryMutation(async () => {
            assertCurrent();
            const current = await Zotero.Items.getByLibraryAndKeyAsync(item.libraryID, item.key);
            if (!current || current.deleted) throw new Error('PDF parent item is unavailable');
            const ids = await current.getAttachments();
            const existing = await Promise.all(ids.map(id => Zotero.Items.getAsync(id)));
            assertCurrent();
            const pdf = existing.find(candidate => candidate && !candidate.deleted && candidate.isPDFAttachment());
            if (pdf) return { attachment: pdf };
            const attachment = await attachments.createURLAttachmentFromTemporaryStorageDirectory({
                directory, libraryID: current.libraryID, parentItemID: current.id,
                filename, title, url: result.url, contentType: mimeType,
            });
            return { attachment, accessMethod };
        }, { signal, assertCurrent });
    } finally {
        timers.clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        if (abandoned) {
            // Zotero's downloader has no abort handle. It can finish only into
            // this private directory; remove it after the writer has settled.
            void download.then(cleanup, cleanup);
        } else {
            await cleanup();
        }
    }
}
