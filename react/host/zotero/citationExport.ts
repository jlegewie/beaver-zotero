import { getPageLabelsForItem } from './itemData';
import { getPageLocator } from '../../utils/citationGrammar';
import { resolvePageLabelFromLabels, translatePageNumberToLabelFromLabels } from '../../utils/pageLabels';
import { buildZoteroCitationLinkHTML, isLinkCitationItem } from '../../../src/utils/zoteroLinkCitation';
import { logger } from '../../../src/utils/logger';
import type { CitationExportRequest, CitationExportRender, DocumentExportHost } from '../types';

/**
 * Render a Zotero/library citation as CSL-formatted HTML for note export.
 *
 * Returns the formatted HTML plus the serialized citation payload (for the note
 * editor's `data-citation` attribute), or null when the item is unavailable.
 * Pre-formatted "link" citation items are returned as raw HTML.
 */
function renderCitation(request: CitationExportRequest): CitationExportRender | null {
    const { effectiveLibraryID, effectiveItemKey, requestedRef, pages, metadata, pageLabelsByAttachmentId } = request;
    if (!effectiveLibraryID || !effectiveItemKey) return null;
    try {
        const item = Zotero.Items.getByLibraryAndKey(effectiveLibraryID, effectiveItemKey);
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

/** Zotero implementation of {@link DocumentExportHost}. */
export const zoteroDocumentExport: DocumentExportHost = {
    renderCitation,
};
