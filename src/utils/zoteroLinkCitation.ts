import { normalizeCitationTag, parseRawCitationAttributes, type Locator } from '@beaver/agent-core/citations/citationGrammar';
import { noteCitationTagPattern } from './noteCitationTags';
import { UNRESOLVED_LIBRARY_ID } from './libraryIdentity';
import { externalFileLocatorSuffix } from './externalFileCitation';
import { escapeAttr } from './noteHtmlEntities';

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
 * Build a Zotero protocol URI for note, annotation, and standalone attachment citations.
 */
export function buildZoteroCitationLinkURI(item: any): string | null {
    if (!item || !item.key || !item.libraryID) return null;

    const segment = librarySegment(item.libraryID);
    if (item.isNote?.() === true || isStandaloneAttachment(item)) {
        return `zotero://select/${segment}/items/${item.key}`;
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
 * Build plain HTML for a note, annotation, or attachment citation link.
 */
export function buildZoteroCitationLinkHTML(item: any, locator?: Locator): string {
    const uri = buildZoteroCitationLinkURI(item);
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

    const openPdfMatch = decodedHref.match(/^zotero:\/\/open-pdf\/(library|groups\/(\d+))\/items\/([^/?#]+)(?:\?([^#]*))?/);
    if (openPdfMatch) {
        const libraryId = openPdfMatch[1] === 'library'
            ? Zotero.Libraries.userLibraryID
            : Zotero.Groups.getLibraryIDFromGroupID(Number(openPdfMatch[2]));
        if (!libraryId) return null;

        const params = new URLSearchParams(openPdfMatch[4] || '');
        const annotationKey = params.get('annotation');
        return annotationKey ? { libraryId, itemKey: annotationKey } : null;
    }

    return null;
}

/** Load attachment titles before synchronous rendering; no file access is needed. */
export async function preloadStandaloneAttachmentTitles(
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
            const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
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
}
