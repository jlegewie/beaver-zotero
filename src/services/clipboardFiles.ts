/**
 * Reading attachable content out of the system clipboard.
 *
 * The two clipboard shapes reach the composer differently:
 *
 * - **Image bytes** (screenshot, "Copy Image" in the PDF reader, an image
 *   copied from a browser) are pasteable, so a `paste` event fires and usually
 *   carries the image in `clipboardData.files`. Some platforms fire the paste
 *   without it; `clipboardHasImage` / `readClipboardImageToTemp` cover those.
 * - **A file copied in a file manager** carries only `application/x-moz-file`,
 *   which the editor does not consider pasteable, so **no `paste` event is
 *   dispatched at all**. It can only be seen by reading the clipboard directly.
 *
 * `nsIClipboard` holds a single transferable, so at most one file is
 * retrievable even when several were copied.
 *
 * Must stay esbuild-safe (no `react/*` value imports); also called from
 * webpack-bundled code.
 */

import { logger } from '../utils/logger';

const FILE_FLAVOR = 'application/x-moz-file';

/**
 * Clipboard image flavors, in preference order. These are synthesized from
 * whatever the OS pasteboard holds (including the `x-moz-nativeimage` the PDF
 * reader writes), so they cover every image source.
 */
const IMAGE_FLAVORS = ['image/png', 'image/jpeg', 'image/gif'] as const;

const IMAGE_FLAVOR_EXTENSIONS: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
};

/** Basename (without extension) given to images pasted as raw bytes. */
const PASTED_IMAGE_BASENAME = 'pasted-image';

/** Prefix of the per-paste scratch folders holding temp copies. */
const TEMP_FOLDER_PREFIX = 'beaver-paste-';

/** Monotonic counter keeping successive pastes in one session distinguishable. */
let pastedImageCounter = 0;

/** Monotonic counter giving each temp copy its own scratch folder. */
let tempFolderCounter = 0;

/** XPCOM contract lookup; the generated typings do not cover these IDs. */
function createInstance(contractId: string, iface: any): any {
    return (Components.classes as any)[contractId].createInstance(iface);
}

/** A fresh, initialized transferable holding a single flavor. */
function createTransferable(flavor: string): any {
    const transferable = createInstance(
        '@mozilla.org/widget/transferable;1',
        Components.interfaces.nsITransferable,
    );
    transferable.init(null);
    transferable.addDataFlavor(flavor);
    return transferable;
}

function getClipboardService(): any | null {
    try {
        return (Services as any).clipboard ?? null;
    } catch (error) {
        logger(`clipboardFiles: clipboard service unavailable: ${error}`, 2);
        return null;
    }
}

/** Whether the clipboard offers any of `flavors`. */
function hasAnyFlavor(flavors: readonly string[]): boolean {
    const clipboard = getClipboardService();
    if (!clipboard) return false;
    try {
        return clipboard.hasDataMatchingFlavors(
            [...flavors],
            flavors.length,
            clipboard.kGlobalClipboard,
        ) === true;
    } catch (error) {
        logger(`clipboardFiles: flavor check failed for '${flavors.join(', ')}': ${error}`, 2);
        return false;
    }
}

/**
 * Whether the clipboard holds a file copied in a file manager. Called on every
 * paste keystroke, so it stays synchronous and cheap.
 */
export function clipboardHasFile(): boolean {
    return hasAnyFlavor([FILE_FLAVOR]);
}

/**
 * Path of the file on the clipboard, or null when there is none. Handed
 * straight to `attachExternalFile`, so the copy keeps the file's real name.
 */
export function readClipboardFilePath(): string | null {
    const clipboard = getClipboardService();
    if (!clipboard) return null;
    try {
        const transferable = createTransferable(FILE_FLAVOR);
        clipboard.getData(transferable, clipboard.kGlobalClipboard);
        const data: { value?: unknown } = {};
        transferable.getTransferData(FILE_FLAVOR, data);
        const file = (data.value as any)?.QueryInterface(Components.interfaces.nsIFile);
        return file?.path ?? null;
    } catch (error) {
        logger(`clipboardFiles: reading the clipboard file failed: ${error}`, 2);
        return null;
    }
}

/** Filename for an image pasted as raw bytes, e.g. `pasted-image-3.png`. */
function nextPastedImageName(extension: string): string {
    pastedImageCounter += 1;
    return `${PASTED_IMAGE_BASENAME}-${pastedImageCounter}.${extension}`;
}

/**
 * Name for the temp copy of a pasted File. Clipboard images arrive under a
 * synthesized placeholder name, which would become the chip label and the name
 * the model sees, so those get a generated one; other files keep their own.
 */
function tempNameForPastedFile(file: File): string {
    const extension = extensionForMime(file.type);
    if (!file.name || (file.type || '').startsWith('image/')) {
        return nextPastedImageName(extension);
    }
    // `File.name` is a bare name; PathUtils.filename requires an absolute path.
    const base = file.name.split(/[/\\]/).pop() ?? '';
    const safe = Zotero.File.getValidFileName(base);
    return safe || nextPastedImageName(extension);
}

/**
 * Extension for a pasted image's temp file. Only has to be plausible —
 * `attachExternalFile` sniffs the real MIME type from the content.
 */
function extensionForMime(mimeType: string | null | undefined): string {
    const mime = (mimeType || '').toLowerCase().split(';')[0].trim();
    return IMAGE_FLAVOR_EXTENSIONS[mime] ?? 'png';
}

/**
 * Write bytes to a temp file and return its path; the caller attaches it and
 * then discards it via `removeTempFile`. Each write gets its own scratch folder
 * so a user-controlled filename cannot collide with another paste in flight.
 */
async function writeTempFile(bytes: Uint8Array, filename: string): Promise<string> {
    tempFolderCounter += 1;
    const folder = PathUtils.join(
        Zotero.getTempDirectory().path,
        `${TEMP_FOLDER_PREFIX}${tempFolderCounter}`,
    );
    await IOUtils.makeDirectory(folder, { createAncestors: true, ignoreExisting: true });
    const path = PathUtils.join(folder, filename);
    await IOUtils.write(path, bytes);
    return path;
}

/**
 * Spill a pasted File to disk so it can go through the attach path, which
 * needs a path. Returns null on failure.
 */
export async function writePastedFileToTemp(file: File): Promise<string | null> {
    try {
        const buffer = await file.arrayBuffer();
        return await writeTempFile(new Uint8Array(buffer), tempNameForPastedFile(file));
    } catch (error) {
        logger(`clipboardFiles: writing the pasted file failed: ${error}`, 1);
        return null;
    }
}

/**
 * Read an image off the clipboard and spill it to disk, for a paste event that
 * arrives without the image in its payload. Null when there is no image.
 */
export async function readClipboardImageToTemp(): Promise<string | null> {
    const clipboard = getClipboardService();
    if (!clipboard) return null;
    const flavor = IMAGE_FLAVORS.find((candidate) => hasAnyFlavor([candidate]));
    if (!flavor) return null;
    try {
        const transferable = createTransferable(flavor);
        clipboard.getData(transferable, clipboard.kGlobalClipboard);
        const data: { value?: unknown } = {};
        transferable.getTransferData(flavor, data);
        const stream = (data.value as any)?.QueryInterface(Components.interfaces.nsIInputStream);
        if (!stream) return null;
        const binaryStream = createInstance(
            '@mozilla.org/binaryinputstream;1',
            Components.interfaces.nsIBinaryInputStream,
        );
        binaryStream.setInputStream(stream);
        const bytes = binaryStream.readByteArray(binaryStream.available());
        if (!bytes.length) return null;
        return await writeTempFile(new Uint8Array(bytes), nextPastedImageName(extensionForMime(flavor)));
    } catch (error) {
        logger(`clipboardFiles: reading the clipboard image failed: ${error}`, 2);
        return null;
    }
}

/** Whether the clipboard holds an image (raw bytes, not a copied image file). */
export function clipboardHasImage(): boolean {
    return hasAnyFlavor(IMAGE_FLAVORS);
}

/** Discard a temp copy and its scratch folder once attached. Never throws. */
export async function removeTempFile(path: string): Promise<void> {
    try {
        const folder = PathUtils.parent(path);
        const target = folder && PathUtils.filename(folder).startsWith(TEMP_FOLDER_PREFIX)
            ? folder
            : path;
        await IOUtils.remove(target, { ignoreAbsent: true, recursive: true });
    } catch (error) {
        logger(`clipboardFiles: removing the temp copy failed: ${error}`, 3);
    }
}
