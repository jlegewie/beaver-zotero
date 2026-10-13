/** Sizes and fallbacks of note images, shared by the writers. */

import type { MdImage } from '../mdast';
import type { ExportDoc, ExportImage } from '../types';

/** CSS pixels per inch: note images are sized in CSS pixels. */
export const PIXELS_PER_INCH = 96;

/** Width of an image whose natural size is unknown, in CSS pixels: a typical figure. */
export const DEFAULT_IMAGE_WIDTH = 480;

/** Height-to-width ratio of an image whose natural size is unknown (4:3). */
export const DEFAULT_HEIGHT_RATIO = 0.75;

/** An image's height-to-width ratio: its natural one, else the default. */
export function imageHeightRatio(asset: ExportImage): number {
    return asset.width > 0 && asset.height > 0 ? asset.height / asset.width : DEFAULT_HEIGHT_RATIO;
}

/** Width an image is shown at in CSS pixels: the note's, else from its height and shape, else its natural width. */
export function imageDisplayWidth(node: MdImage, asset: ExportImage): number {
    if (node.width) return node.width;
    if (node.height) return node.height / imageHeightRatio(asset);
    return asset.width || DEFAULT_IMAGE_WIDTH;
}

/**
 * What stands in for an image that is not embedded: a link to an image on
 * the web (never fetched), else its alt text, else a placeholder for a note
 * image that could not be loaded. Null when there is nothing to show.
 */
export function imageFallback(node: MdImage, doc: ExportDoc): { linkUrl?: string; text: string } | null {
    if (node.assetId && doc.images?.[node.assetId]?.kind === 'remote' && node.url) {
        return { linkUrl: node.url, text: node.alt || '[Image]' };
    }
    const text = node.alt || (node.assetId ? '[Image not available]' : '');
    return text ? { text } : null;
}
