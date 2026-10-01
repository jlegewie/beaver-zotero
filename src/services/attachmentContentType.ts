import { logger } from '@beaver/agent-core/platform/logger';
import { canonicalContentTypeCorrection } from '../utils/attachmentFiles';
import { isLibrarySearchable } from './agentDataProvider/utils';

/** Sniff the file's leading bytes the way Zotero does before opening it. */
async function fileConfirmsContentType(item: Zotero.Item, contentType: string): Promise<boolean> {
    try {
        const path = await item.getFilePathAsync();
        if (!path) return false;
        // getSample() reads the first bytes as a binary string.
        const sample = await Zotero.File.getSample(path) as string;
        return Zotero.MIME.sniffForMIMEType(sample) === contentType;
    } catch (error) {
        logger(`attachmentContentType: failed to sniff ${item.libraryKey}: ${error}`, 2);
        return false;
    }
}

/**
 * Check whether Zotero's reader and annotation APIs can use this attachment,
 * either as-is or after `ensureReaderContentType()`. Does not write.
 */
export async function canUseReaderContentType(item: Zotero.Item): Promise<boolean> {
    const canonical = canonicalContentTypeCorrection(item);
    return canonical === null || await fileConfirmsContentType(item, canonical);
}

/**
 * Give a mislabelled PDF/EPUB the content type Zotero's reader and annotation
 * APIs require, mirroring the correction `ZoteroPane.viewAttachment()` applies
 * when the user opens the file: the type is rewritten only when the file's
 * leading bytes confirm it. Call only from paths that are about to open or
 * annotate the attachment on the user's behalf.
 *
 * Callers must already hold the library mutation queue when one applies.
 *
 * @returns true when the attachment now carries (or already carried) a type
 *   Zotero can open, false when the library is excluded from Beaver or
 *   read-only, or the file could not confirm the type.
 */
export async function ensureReaderContentType(item: Zotero.Item): Promise<boolean> {
    const canonical = canonicalContentTypeCorrection(item);
    if (canonical === null) return true;
    // Beaver never modifies an excluded library, even when the user opened the
    // file; the caller still opens or reveals it without the correction.
    if (!isLibrarySearchable(item.libraryID)) return false;
    const library = Zotero.Libraries.get(item.libraryID);
    if (!library || !library.editable) return false;
    if (!await fileConfirmsContentType(item, canonical)) return false;
    logger(`attachmentContentType: correcting ${item.libraryKey} from '${item.attachmentContentType}' to '${canonical}'`, 3);
    item.attachmentContentType = canonical;
    await item.saveTx();
    return true;
}

/**
 * Plugin-realm library operation: correct a mislabelled attachment's content
 * type before a renderer opens it in Zotero's reader.
 */
export async function ensureReaderContentTypeForItem(itemID: number): Promise<boolean> {
    const item = await Zotero.Items.getAsync(itemID);
    if (!item || item.deleted) return false;
    return ensureReaderContentType(item);
}
