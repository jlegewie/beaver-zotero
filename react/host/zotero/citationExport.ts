import { getPageLabelsForItem } from './itemData';
import { getPageLocator } from '../../utils/citationGrammar';
import { resolvePageLabelFromLabels, translatePageNumberToLabelFromLabels } from '../../utils/pageLabels';
import { buildZoteroCitationLinkHTML, isLinkCitationItem } from '../../../src/utils/zoteroLinkCitation';
import { resolveLibraryRef } from '../../../src/utils/libraryIdentity';
import { logger } from '../../../src/utils/logger';
import type {
    CitationExportRequest,
    CitationExportRender,
    DocumentExportHost,
    ExternalFileCitationExportRequest,
} from '../types';

/** Escape text for safe interpolation into an HTML attribute or text node. */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Render a Zotero/library citation as CSL-formatted HTML for note export.
 *
 * Returns the formatted HTML plus the serialized citation payload (for the note
 * editor's `data-citation` attribute), or null when the item is unavailable.
 * Pre-formatted "link" citation items are returned as raw HTML.
 */
function renderCitation(request: CitationExportRequest): CitationExportRender | null {
    const { effectiveLibraryID, effectiveItemKey, effectiveLibraryRef, requestedRef, pages, metadata, pageLabelsByAttachmentId } = request;
    if (!effectiveItemKey) return null;
    // Group citations carry a device-local libraryID of 0 — their identity is the
    // portable `library_ref` (e.g. "g287629"). Resolve it to a local libraryID so
    // the item lookup (and thus the exported citation) works for group items too.
    const libraryID = effectiveLibraryID || resolveLibraryRef({ library_ref: effectiveLibraryRef, library_id: effectiveLibraryID });
    if (!libraryID) return null;
    try {
        const item = Zotero.Items.getByLibraryAndKey(libraryID, effectiveItemKey);
        if (!item) return null;
        if (isLinkCitationItem(item)) {
            return { kind: 'html', html: buildZoteroCitationLinkHTML(item) };
        }
        const itemData = Zotero.Utilities.Item.itemToCSLJSON(item.parentItem || item);
        const startPage = pages.length > 0 ? pages[0] : undefined;
        // Fallback: use the requested page locator when metadata doesn't provide pages.
        const requestedPage = requestedRef ? getPageLocator(requestedRef) : undefined;
        // Labels come from the active render store (passed in) so note export
        // respects the isolated store populated by renderToHTML.
        const loadedLabels = getPageLabelsForItem(item, pageLabelsByAttachmentId);
        const exportLabels = loadedLabels ?? metadata?.page_labels;
        // Zotero note clicks use the CSL locator as a PDF page label. When labels
        // are available, store the visible label for the physical page.
        const navLocator = startPage
            ? resolvePageLabelFromLabels(exportLabels, startPage)
            : (requestedPage ? translatePageNumberToLabelFromLabels(exportLabels, requestedPage) : undefined);
        const citationObj = {
            citationItems: [{
                uris: [Zotero.URI.getItemURI(item.parentItem || item)],
                itemData: itemData,
                locator: navLocator,
            }],
            properties: {},
        };
        const formatted = Zotero.EditorInstanceUtilities.formatCitation(citationObj);
        return {
            kind: 'citation',
            html: formatted,
            citationData: encodeURIComponent(JSON.stringify(citationObj)),
        };
    } catch (e) {
        logger(`zoteroDocumentExport: Item not loaded for ${effectiveLibraryID}/${effectiveItemKey}: ${e}`);
        return null;
    }
}

/**
 * Render an external-file citation as a clickable link to the locally stored
 * copy, for note export.
 *
 * Zotero-only enhancement: the note editor opens a `file://` link via the OS
 * default handler. Returns null when there's no local copy on this computer
 * (the file was attached on another machine), so the render layer falls back to
 * plain text. The locator suffix is appended outside the link, mirroring the
 * external-reference export form.
 */
function renderExternalFileCitation(request: ExternalFileCitationExportRequest): CitationExportRender | null {
    const { externalFileKey, displayName, locatorSuffix, localPathsByExtKey } = request;
    if (!externalFileKey) return null;
    const path = localPathsByExtKey[externalFileKey];
    if (!path) return null;
    try {
        const href = escapeHtml(Zotero.File.pathToFileURI(path));
        const label = escapeHtml(displayName);
        const suffix = escapeHtml(locatorSuffix);
        return { kind: 'html', html: `(<a href="${href}">${label}</a>${suffix})` };
    } catch (e) {
        logger(`zoteroDocumentExport: failed to build file link for ext-${externalFileKey}: ${e}`);
        return null;
    }
}

/** Zotero implementation of {@link DocumentExportHost}. */
export const zoteroDocumentExport: DocumentExportHost = {
    renderCitation,
    renderExternalFileCitation,
};
