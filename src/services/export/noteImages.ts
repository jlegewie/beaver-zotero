/**
 * Load the images of a Zotero note for export.
 *
 * Inserted images and image annotations are child attachments of the note;
 * older or unsaved notes may hold an image as a data URI. Images on the web
 * are never fetched (the writers link to them instead). Every image is
 * decoded once in a window to learn its size; formats Word and LaTeX cannot
 * show (WebP, AVIF, SVG, BMP) also get a PNG rendering.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import type { ExportImage, NoteImageSource } from '@beaver/agent-export/types';
import { getDomWindow } from '../../prosemirror/dom';

/** Formats every writer can embed as they are (LaTeX takes GIF as its PNG rendering). */
const PORTABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
/** SVG is drawn at this scale, so its PNG stays sharp in print. */
const SVG_RASTER_SCALE = 2;

export interface LoadedNoteImages {
    images: Record<string, ExportImage>;
    /** Images that could not be loaded (files missing, unreadable data). */
    missing: number;
    /** Images on the web, which are linked rather than included. */
    remote: number;
}

/** Bytes of a base64 data URI, or null. */
export function dataUriBytes(src: string): { mime: string; data: Uint8Array } | null {
    // `data:<type>[;<parameter>=<value>]*[;base64],<data>`
    const match = /^data:([^;,]+)((?:;[^;,]*)*?)(;base64)?,([\s\S]*)$/i.exec(src);
    if (!match) return null;
    try {
        const raw = match[3] ? atobBytes(match[4]) : percentDecodedBytes(match[4]);
        return { mime: match[1].trim().toLowerCase(), data: raw };
    } catch {
        return null;
    }
}

/** The bytes of percent-encoded data: escapes are bytes as they are, other characters UTF-8. */
function percentDecodedBytes(text: string): Uint8Array {
    const bytes: number[] = [];
    const encoder = new TextEncoder();
    for (let index = 0; index < text.length; index++) {
        if (text[index] === '%' && /^[0-9a-f]{2}$/i.test(text.slice(index + 1, index + 3))) {
            bytes.push(parseInt(text.slice(index + 1, index + 3), 16));
            index += 2;
        } else {
            const codePoint = text.codePointAt(index)!;
            const char = String.fromCodePoint(codePoint);
            bytes.push(...encoder.encode(char));
            index += char.length - 1;
        }
    }
    return Uint8Array.from(bytes);
}

function atobBytes(base64: string): Uint8Array {
    const binary = (getDomWindow() as any)?.atob?.(base64.replace(/\s+/g, '')) ?? globalThis.atob(base64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/** The image's natural size and, when needed, a PNG rendering, decoded in `win`. */
async function decodeImage(win: Window, mime: string, data: Uint8Array, raster: boolean): Promise<{ width: number; height: number; png?: Uint8Array } | null> {
    const blob = new (win as any).Blob([data], { type: mime });
    const url = (win as any).URL.createObjectURL(blob);
    try {
        const image = win.document.createElementNS(XHTML_NS, 'img') as HTMLImageElement;
        image.src = url;
        await image.decode();
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!width || !height) return null;
        if (!raster) return { width, height };
        const scale = mime === 'image/svg+xml' ? SVG_RASTER_SCALE : 1;
        const canvas = win.document.createElementNS(XHTML_NS, 'canvas') as HTMLCanvasElement;
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
        const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!png) return { width, height };
        return { width, height, png: new Uint8Array(await png.arrayBuffer()) };
    } finally {
        (win as any).URL.revokeObjectURL(url);
    }
}

/**
 * An image asset from its bytes: PNG and JPEG as they are; GIF and SVG with a
 * PNG rendering (LaTeX reads neither; Word needs one for SVG); others as PNG.
 */
async function asset(mime: string, data: Uint8Array): Promise<ExportImage | null> {
    const normalized = mime === 'image/apng' ? 'image/png' : mime;
    const win = getDomWindow();
    if (!win) {
        // Without a window the size is unknown; portable formats still embed.
        return PORTABLE_TYPES.has(normalized) ? { mime: normalized, data, width: 0, height: 0 } : null;
    }
    const keepsOriginal = PORTABLE_TYPES.has(normalized) || normalized === 'image/svg+xml';
    const decoded = await decodeImage(win, normalized, data, normalized !== 'image/png' && normalized !== 'image/jpeg');
    if (!decoded) return null;
    if (keepsOriginal) {
        return { mime: normalized, data, width: decoded.width, height: decoded.height, ...(decoded.png ? { png: decoded.png } : {}) };
    }
    if (!decoded.png) return null;
    return { mime: 'image/png', data: decoded.png, width: decoded.width, height: decoded.height };
}

/** The note's image attachments by key, downloading their files once if any is missing. */
async function attachmentFiles(note: Zotero.Item, keys: string[]): Promise<Map<string, { path: string; mime: string }>> {
    const read = async () => {
        const files = new Map<string, { path: string; mime: string }>();
        const attachments = await Zotero.Items.getAsync(note.getAttachments()) as Zotero.Item[];
        for (const attachment of attachments) {
            if (!attachment || !keys.includes(attachment.key)) continue;
            try {
                const path = await attachment.getFilePathAsync();
                if (path && await IOUtils.exists(path)) {
                    files.set(attachment.key, { path, mime: (attachment as any).attachmentContentType || 'image/png' });
                }
            } catch (error) {
                // An unreadable file is a missing image, not a failed export.
                logger(`noteImages: could not locate ${attachment.key}: ${error}`, 2);
            }
        }
        return files;
    };
    let files = new Map<string, { path: string; mime: string }>();
    try {
        files = await read();
    } catch (error) {
        logger(`noteImages: could not list the note's images: ${error}`, 2);
        return files;
    }
    if (files.size < new Set(keys).size) {
        try {
            // Files of a note synced from another computer download on demand.
            await (Zotero as any).Notes.ensureEmbeddedImagesAreAvailable(note);
            files = await read();
        } catch (error) {
            logger(`noteImages: could not download note images: ${error}`, 2);
        }
    }
    return files;
}

/** Load the images a note document references (`ExportDoc.images`). */
export async function loadNoteImages(
    note: Zotero.Item | null,
    sources: Record<string, NoteImageSource>,
): Promise<LoadedNoteImages> {
    const images: Record<string, ExportImage> = {};
    let missing = 0;
    let remote = 0;
    const keys = Object.values(sources).flatMap(source => (source.kind === 'attachment' ? [source.key] : []));
    const files = note && keys.length > 0 ? await attachmentFiles(note, keys) : new Map<string, { path: string; mime: string }>();
    for (const [id, source] of Object.entries(sources)) {
        if (source.kind === 'remote') {
            remote += 1;
            continue;
        }
        try {
            let loaded: ExportImage | null = null;
            if (source.kind === 'attachment') {
                const file = files.get(source.key);
                if (file) loaded = await asset(file.mime, await IOUtils.read(file.path));
            } else {
                const decoded = dataUriBytes(source.src);
                if (decoded) loaded = await asset(decoded.mime, decoded.data);
            }
            if (loaded) images[id] = loaded;
            else missing += 1;
        } catch (error) {
            logger(`noteImages: could not load ${id}: ${error}`, 2);
            missing += 1;
        }
    }
    return { images, missing, remote };
}
