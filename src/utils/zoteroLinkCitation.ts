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

function getCompactItemDisplayName(item: any): string {
    if (!item) return '';
    if (item.isNote?.() === true) {
        return truncateLabel(item.getNoteTitle?.() || 'Note', MAX_NOTE_TITLE_LENGTH);
    }
    if (item.isAttachment?.() === true && !item.parentItem) {
        const title = safeGetField(item, 'title') || item.attachmentFilename || 'attachment';
        return truncateLabel(title, MAX_ATTACHMENT_TITLE_LENGTH);
    }

    const firstCreator = item.firstCreator || safeGetField(item, 'title') || 'Unknown Author';
    const year = safeGetField(item, 'date').match(/\d{4}/)?.[0] || '';
    return `${firstCreator}${year ? ` ${year}` : ''}`;
}

function getAnnotationSourceItem(annotation: any): any {
    const attachment = annotation?.parentItem;
    return attachment?.parentItem || attachment || null;
}

function decodeHrefAttrValue(href: string): string {
    return href.replace(/&amp;/g, '&');
}

/**
 * Return true when the Zotero item should be represented as a plain zotero:// link.
 */
export function isLinkCitationItem(item: any): boolean {
    return item?.isNote?.() === true || isAnnotationItem(item);
}

/**
 * Build a Zotero protocol URI for note and annotation citations.
 */
export function buildZoteroCitationLinkURI(item: any): string | null {
    if (!item || !item.key || !item.libraryID) return null;

    const segment = librarySegment(item.libraryID);
    if (item.isNote?.() === true) {
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
 * Build the visible label for a note or annotation citation link.
 */
export function buildZoteroCitationLinkLabel(item: any): string {
    if (item?.isNote?.() === true) {
        const noteTitle = truncateLabel(item.getNoteTitle?.() || 'Note', MAX_NOTE_TITLE_LENGTH);
        const parentLabel = item.parentItem ? getCompactItemDisplayName(item.parentItem) : '';
        return parentLabel
            ? `Note in ${parentLabel}: ${noteTitle}`
            : `Note: ${noteTitle}`;
    }

    if (isAnnotationItem(item)) {
        const sourceLabel = getCompactItemDisplayName(getAnnotationSourceItem(item));
        const page = item.annotationPageLabel ? `, page ${item.annotationPageLabel}` : '';
        return sourceLabel
            ? `Annotation in ${sourceLabel}${page}`
            : `Annotation${page}`;
    }

    return 'Zotero item';
}

/**
 * Build plain HTML for a note or annotation citation link.
 */
export function buildZoteroCitationLinkHTML(item: any, label?: string): string {
    const uri = buildZoteroCitationLinkURI(item);
    if (!uri) {
        throw new Error(
            `Error: Zotero item "${item?.libraryID ?? ''}-${item?.key ?? ''}" cannot be embedded as a note link.`
        );
    }
    const visibleLabel = label || buildZoteroCitationLinkLabel(item);
    return `(<a href="${escapeAttr(uri)}" rel="noopener noreferrer">${escapeAttr(visibleLabel)}</a>)`;
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
