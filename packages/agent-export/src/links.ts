/**
 * Where an exported link points, by the kind of link.
 *
 * - Web and mail links are kept.
 * - Links into the library work only where Zotero is installed, so they are
 *   kept only with `linkItems`: Beaver item links (`u-KEY`, written as
 *   `zotero://select/…`) and `zotero://` links in notes.
 * - Anything else (local files, Beaver's own links) becomes its text.
 */

import { itemLinkExportHref, parseItemLinkHref } from '@beaver/agent-core/identity/itemLinks';

export function isWebLink(url: string): boolean {
    return /^(https?:|mailto:)/i.test(url.trim());
}

/** The URL a link is exported with, or null to write only its text. */
export function exportLinkTarget(url: string, linkItems: boolean): string | null {
    if (parseItemLinkHref(url)) return linkItems ? itemLinkExportHref(url) : null;
    if (isWebLink(url)) return url.trim();
    if (/^zotero:\/\//i.test(url.trim()) && !/^zotero:\/\/beaver\//i.test(url.trim())) return linkItems ? url.trim() : null;
    return null;
}
