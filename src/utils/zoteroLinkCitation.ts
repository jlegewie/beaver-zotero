import { normalizeCitationTag, parseRawCitationAttributes, type Locator } from '@beaver/agent-core/citations/citationGrammar';
import { noteCitationTagPattern } from './noteCitationTags';
import { UNRESOLVED_LIBRARY_ID } from './libraryIdentity';
import { externalFileLocatorSuffix } from './externalFileCitation';
import { escapeAttr, unescapeAttr } from './noteHtmlEntities';

const MAX_LABEL_SNIPPET_LENGTH = 120;
const MAX_NOTE_TITLE_LENGTH = 50;
const MAX_ATTACHMENT_TITLE_LENGTH = 70;

function isAnnotationItem(item: any): boolean {
    return item?.isAnnotation?.() === true || item?.itemType === 'annotation';
}

function librarySegment(libraryID: number): string {
    const library = Zotero.Libraries.get(libraryID);
    if (library && library.isGroup) {
        const groupID = Zotero.Groups.getGroupIDFromLibraryID(libraryID);
        return `groups/${groupID}`;
    }
    return 'library';
}

function truncateLabel(text: string, maxLength = MAX_LABEL_SNIPPET_LENGTH): string {
    const normalized = text.trim().replace(/\s+/g, ' ');
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function safeGetField(item: any, field: string): string {
    try {
        return String(item?.getField?.(field) || '');
    } catch {
        return '';
    }
}

function safeGetProperty(item: any, property: string): any {
    try {
        return item?.[property];
    } catch {
        return undefined;
    }
}

function safeGetNoteTitle(item: any): string {
    try {
        return String(item?.getNoteTitle?.() || '');
    } catch {
        return '';
    }
}

function getCompactItemDisplayName(item: any): string {
    if (!item) return '';
    if (item.isNote?.() === true) {
        return truncateLabel(safeGetNoteTitle(item) || 'Note', MAX_NOTE_TITLE_LENGTH);
    }
    if (isStandaloneAttachment(item)) {
        const title = safeGetField(item, 'title') || safeGetProperty(item, 'attachmentFilename') || 'attachment';
        return truncateLabel(title, MAX_ATTACHMENT_TITLE_LENGTH);
    }

    const firstCreator = safeGetProperty(item, 'firstCreator') || safeGetField(item, 'title') || 'Unknown Author';
    const year = safeGetField(item, 'date').match(/\d{4}/)?.[0] || '';
    return `${firstCreator}${year ? ` ${year}` : ''}`;
}

function getAnnotationSourceItem(annotation: any): any {
    const attachment = safeGetProperty(annotation, 'parentItem');
    return safeGetProperty(attachment, 'parentItem') || attachment || null;
}

function decodeHrefAttrValue(href: string): string {
    return href.replace(/&amp;/g, '&');
}

/** Whether the attachment has no bibliographic parent to cite. */
export function isStandaloneAttachment(item: any): boolean {
    return item?.isAttachment?.() === true && !item.parentID;
}

/** Whether to represent the item as a plain Zotero link instead of CSL. */
export function isLinkCitationItem(item: any): boolean {
    return item?.isNote?.() === true || isAnnotationItem(item) || isStandaloneAttachment(item);
}

/**
 * Build a Zotero protocol URI for note, annotation, and standalone attachment
 * citations.
 *
 * A standalone attachment opens its file rather than revealing the library row:
 * the note already names the attachment, the reader is what the citation points
 * at, and opening leaves the note itself on screen instead of navigating the
 * item pane away from it. `navPage` is the cited *physical* 1-based page, which
 * is how Zotero reads `?page=`; it is only passed for PDFs, because the EPUB
 * view resolves the same parameter through its own page mapping.
 *
 * Selecting is the fallback whenever opening would do nothing: an attachment
 * with no file (a linked URL), and one whose file this computer does not have
 * (never downloaded, or a linked file on a disconnected volume) — Zotero's
 * `open` handler gives up silently when it cannot resolve a path. Availability
 * is read from Zotero's cached file state, which
 * `preloadStandaloneAttachmentLinks` primes for every cited attachment; an
 * unchecked attachment reads as null and still opens.
 */
export function buildZoteroCitationLinkURI(item: any, navPage?: number, physicalPages?: string): string | null {
    if (!item || !item.key || !item.libraryID) return null;

    const segment = librarySegment(item.libraryID);
    if (item.isNote?.() === true) {
        return `zotero://select/${segment}/items/${item.key}`;
    }

    if (isStandaloneAttachment(item)) {
        const isPdf = item.isPDFAttachment?.() === true;
        if (item.isFileAttachment?.() !== true || item.fileExistsCached?.() === false) {
            return `zotero://select/${segment}/items/${item.key}${isPdf ? pagesFragment(physicalPages) : ''}`;
        }
        const pageQuery = navPage && isPdf ? `?page=${navPage}` : '';
        const fragment = isPdf && physicalPages && physicalPages !== String(navPage)
            ? pagesFragment(physicalPages)
            : '';
        return `zotero://open/${segment}/items/${item.key}${pageQuery}${fragment}`;
    }

    if (isAnnotationItem(item)) {
        const attachment = item.parentItem;
        if (!attachment?.isFileAttachment?.()) return null;
        return `zotero://open-pdf/${segment}/items/${attachment.key}?annotation=${item.key}`;
    }

    return null;
}

/**
 * Build the visible label for a note, annotation, or attachment citation link.
 */
export function buildZoteroCitationLinkLabel(item: any): string {
    if (isStandaloneAttachment(item)) {
        return getCompactItemDisplayName(item);
    }
    if (item?.isNote?.() === true) {
        const noteTitle = truncateLabel(safeGetNoteTitle(item) || 'Note', MAX_NOTE_TITLE_LENGTH);
        const parentItem = safeGetProperty(item, 'parentItem');
        const parentLabel = parentItem ? getCompactItemDisplayName(parentItem) : '';
        return parentLabel
            ? `Note in ${parentLabel}: ${noteTitle}`
            : `Note: ${noteTitle}`;
    }

    if (isAnnotationItem(item)) {
        const sourceLabel = getCompactItemDisplayName(getAnnotationSourceItem(item));
        const pageLabel = safeGetProperty(item, 'annotationPageLabel');
        const page = pageLabel ? `, page ${pageLabel}` : '';
        return sourceLabel
            ? `Annotation in ${sourceLabel}${page}`
            : `Annotation${page}`;
    }

    return 'Zotero item';
}

/**
 * Fragment recording the physical pages a link citation cites. Zotero's URL
 * router strips fragments before routing (`PathParser.run`), so it changes
 * nothing about where the link goes; Beaver reads it back
 * (`parseZoteroCitationLinkPages`) because the visible suffix is a page label,
 * which cannot always be translated back: printed labels repeat, and a
 * `zotero://select` link carries no `?page=`.
 */
const PAGES_FRAGMENT = 'beaver-pages=';

function pagesFragment(physicalPages: string | undefined): string {
    const pages = physicalPages ? normalizePhysicalPages(physicalPages) : null;
    return pages ? `#${PAGES_FRAGMENT}${encodeURIComponent(pages)}` : '';
}

/** Physical pages ("4", "4-7", "2, 9") in canonical form, or null for anything else. */
function normalizePhysicalPages(pages: string): string | null {
    const normalized = pages.trim().replace(/[\u2012-\u2015\u2212]/g, '-').replace(/\s*([-,])\s*/g, (_m, sep) => sep === ',' ? ', ' : '-');
    return /^[1-9]\d*(?:(?:-|, )[1-9]\d*)*$/.test(normalized) ? normalized : null;
}

/**
 * The physical pages a link citation records in its fragment
 * (`#beaver-pages=4-7`), or null when it records none.
 */
export function parseZoteroCitationLinkPages(href: string): string | null {
    const decoded = decodeHrefAttrValue(href);
    const hash = decoded.indexOf('#');
    if (hash < 0) return null;
    const fragment = decoded.slice(hash + 1);
    if (!fragment.startsWith(PAGES_FRAGMENT)) return null;
    try {
        return normalizePhysicalPages(decodeURIComponent(fragment.slice(PAGES_FRAGMENT.length)));
    } catch {
        return null;
    }
}

/**
 * Build plain HTML for a note, annotation, or attachment citation link.
 *
 * `locator` is what the reader sees (a page label, possibly a range); `navPage`
 * is the physical page the link navigates to. They are resolved separately
 * because Zotero's `?page=` counts pages by position, not by label.
 * `physicalPages` (the physical pages behind `locator`) is recorded in the
 * link when `?page=` alone does not say them (see `pagesFragment`).
 */
export function buildZoteroCitationLinkHTML(
    item: any,
    locator?: Locator,
    navPage?: number,
    physicalPages?: string,
): string {
    const uri = buildZoteroCitationLinkURI(item, navPage, physicalPages);
    if (!uri) {
        throw new Error(
            `Error: Zotero item "${item?.libraryID ?? ''}-${item?.key ?? ''}" cannot be embedded as a note link.`
        );
    }
    const visibleLabel = buildZoteroCitationLinkLabel(item);
    const standalone = isStandaloneAttachment(item);
    const suffix = standalone ? externalFileLocatorSuffix(locator) : '';
    // Match the note normalizer so a newly saved link is also an exact edit anchor.
    const rel = 'noopener noreferrer nofollow';
    return `(<a href="${escapeAttr(uri)}" rel="${rel}">${escapeAttr(visibleLabel)}</a>${escapeAttr(suffix)})`;
}

/**
 * Match a link citation in note HTML — the anchor plus the parentheses and
 * locator suffix `buildZoteroCitationLinkHTML` writes around it. Capture
 * groups: opening parenthesis, anchor, href, locator suffix, closing
 * parenthesis; every one but the anchor and href is optional, so a bare link
 * matches too and the caller decides what to do with a partial wrapper.
 *
 * Shared so the note simplifier and the page-label preload agree on which text
 * belongs to a citation.
 */
export function zoteroLinkCitationPattern(): RegExp {
    return /(\()?(<a\s+[^>]*href="(zotero:\/\/[^"]*)"[^>]*>[\s\S]*?<\/a>)(,[^<()]*)?(\))?/g;
}

/**
 * The page a link citation's locator suffix displays (", p. 6-8" → "6-8"), or
 * null when the suffix is absent or is not a page locator. The value is a
 * display label, as stored in the note.
 */
export function parseLinkCitationPageSuffix(suffix: string | undefined): string | null {
    const match = suffix ? /^,\s*p\.\s*(\S[^<]*?)\s*$/.exec(suffix) : null;
    return match ? unescapeAttr(match[1]) : null;
}

/**
 * The physical 1-based page a link citation opens (`zotero://open/…?page=12`),
 * or null when the link names none. Links are built with the first page the
 * citation cites (`buildZoteroCitationLinkURI`).
 */
export function parseZoteroCitationLinkPage(href: string): number | null {
    const match = decodeHrefAttrValue(href).match(/^zotero:\/\/open\/[^?#]*\?([^#]*)/);
    if (!match) return null;
    const page = new URLSearchParams(match[1]).get('page');
    return page && /^\d+$/.test(page) && Number(page) > 0 ? Number(page) : null;
}

/**
 * Label namespace for the page suffix of a link citation to `item`.
 *
 * A standalone PDF whose file this computer has links with `zotero://open`
 * and `?page=` (`buildZoteroCitationLinkURI`), so the link records the
 * physical page and the suffix can show the Zotero locator label. Any other
 * standalone attachment links with `zotero://select`, which cannot carry the
 * page: its suffix is the only record, so it stays in the PDF's declared
 * labels, the convention such a suffix is read back in.
 *
 * Call after the attachment's file state is known (`getFilePathAsync` primes
 * `fileExistsCached`), so the choice matches the link built later.
 */
export function linkCitationPageLabelNamespace(item: any): 'locator' | 'declared' {
    if (!isStandaloneAttachment(item)) return 'locator';
    const recordsPage = item.isFileAttachment?.() === true
        && item.fileExistsCached?.() !== false
        && item.isPDFAttachment?.() === true;
    return recordsPage ? 'locator' : 'declared';
}

/**
 * Parse Beaver note/annotation citation links back into Zotero item references.
 */
export function parseZoteroCitationLinkHref(
    href: string,
): { libraryId: number; itemKey: string } | null {
    const decodedHref = decodeHrefAttrValue(href);
    if (!decodedHref.startsWith('zotero://')) return null;
    if (decodedHref.startsWith('zotero://beaver/')) return null;

    const selectMatch = decodedHref.match(/^zotero:\/\/select\/(library|groups\/(\d+))\/items\/([^/?#]+)/);
    if (selectMatch) {
        const libraryId = selectMatch[1] === 'library'
            ? Zotero.Libraries.userLibraryID
            : Zotero.Groups.getLibraryIDFromGroupID(Number(selectMatch[2]));
        if (!libraryId) return null;
        return { libraryId, itemKey: selectMatch[3] };
    }

    // `open` / `open-pdf` name the attachment; an `annotation` query names the
    // annotation inside it, which is the citation target in that case.
    const openMatch = decodedHref.match(/^zotero:\/\/open(?:-pdf)?\/(library|groups\/(\d+))\/items\/([^/?#]+)(?:\?([^#]*))?/);
    if (openMatch) {
        const libraryId = openMatch[1] === 'library'
            ? Zotero.Libraries.userLibraryID
            : Zotero.Groups.getLibraryIDFromGroupID(Number(openMatch[2]));
        if (!libraryId) return null;

        const params = new URLSearchParams(openMatch[4] || '');
        return { libraryId, itemKey: params.get('annotation') || openMatch[3] };
    }

    return null;
}

/**
 * Prepare cited standalone attachments for synchronous link rendering: load the
 * titles the label needs, and resolve each file once so Zotero's cached file
 * state can tell `buildZoteroCitationLinkURI` whether opening it would work.
 */
export async function preloadStandaloneAttachmentLinks(
    content: string,
    allowLibrary: (libraryID: number) => boolean = () => true,
): Promise<void> {
    const seen = new Set<string>();
    const items: Zotero.Item[] = [];
    for (const match of content.matchAll(noteCitationTagPattern())) {
        const normalized = normalizeCitationTag(parseRawCitationAttributes(match[1]));
        if (!normalized.ok || normalized.ref.kind !== 'zotero') continue;
        const { library_id: libraryID, zotero_key: key } = normalized.ref;
        if (libraryID === UNRESOLVED_LIBRARY_ID || !allowLibrary(libraryID)) continue;
        const identity = `${libraryID}-${key}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        try {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
            if (item && isStandaloneAttachment(item)) items.push(item);
        } catch {
            // Skip unavailable targets without preventing other titles from loading.
        }
    }
    if (items.length === 0) return;
    try {
        await Zotero.Items.loadDataTypes(items, ['itemData']);
    } catch {
        // Rendering can still use filenames when title data is unavailable.
    }
    // Resolving the path is what populates `fileExistsCached()`. Failures leave
    // it unknown, which renders an open link — the same as before this check.
    await Promise.all(items.map(async (item) => {
        try {
            await item.getFilePathAsync?.();
        } catch {
            // A file that cannot be checked is not a reason to drop the link.
        }
    }));
}
