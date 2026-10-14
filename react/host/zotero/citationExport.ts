import {
    firstPageNumber,
    formatCitationPages,
    normalizePageRange,
    translatePageNumberToLabel,
} from '../../../src/utils/pageLabelTranslation';
import { buildNoteCitation, encodeNoteCitationData } from '../../../src/utils/zoteroUtils';
import {
    buildAnnotationNoteCitation,
    buildExternalNoteCitation,
    citesPrintedPages,
    type BuiltNoteCitation,
} from '../../../src/utils/noteCitationBuilders';
import { buildBeaverCitationMeta, locatorToken } from '../../../src/utils/noteCitationMeta';
import { formatExternalFileCitationHTML } from '../../../src/utils/externalFileCitation';
import { getPageLabelsForItem } from './itemData';
import { getPageLocator, isRecordIdRange } from '@beaver/agent-core/citations/citationGrammar';
import { translatePageNumberToLabelFromLabels } from '../../utils/pageLabels';
import { resolvePageLabelFromLabels } from '@beaver/agent-ui/utils/pageLabels';
import { buildZoteroCitationLinkHTML, isLinkCitationItem } from '../../../src/utils/zoteroLinkCitation';
import { resolveLibraryRef } from '../../../src/utils/libraryIdentity';
import { logger } from '@beaver/agent-core/platform/logger';
import type {
    CitationExportRequest,
    CitationExportRender,
    DocumentExportHost,
    ExternalFileCitationExportRequest,
    ExternalReferenceCitationExportRequest,
} from '@beaver/agent-ui/host/types';

function citationRender({ citation, formatted }: BuiltNoteCitation): CitationExportRender {
    return { kind: 'citation', html: formatted, citationData: encodeNoteCitationData(citation) };
}

/**
 * Render a Zotero/library citation as CSL-formatted HTML for note export.
 *
 * Returns the formatted HTML plus the serialized citation payload (for the note
 * editor's `data-citation` attribute), or null when the item is unavailable.
 * Pre-formatted "link" citation items are returned as raw HTML.
 */
function renderCitation(request: CitationExportRequest): CitationExportRender | null {
    const { effectiveLibraryID, effectiveItemKey, effectiveLibraryRef, requestedRef, pages, pageLabelsByAttachmentId } = request;
    if (!effectiveItemKey) return null;
    // `library_ref` is the portable identity and must win over a device-local
    // libraryID when both are present. The numeric id may be 0 (unresolved) or
    // may point at an unrelated library after the citation moves devices.
    const libraryID = resolveLibraryRef({
        library_ref: effectiveLibraryRef,
        library_id: effectiveLibraryID,
    });
    if (!libraryID) return null;
    try {
        const item = Zotero.Items.getByLibraryAndKey(libraryID, effectiveItemKey);
        if (!item) return null;
        if (item.isAnnotation?.() === true) {
            const annotationCitation = buildAnnotationNoteCitation(item);
            if (annotationCitation) return citationRender(annotationCitation);
        }
        // A note's locators are Zotero locator labels, preloaded into the
        // export store. The citation's own `page_labels` are printed labels
        // for display and must not reach a note.
        if (isLinkCitationItem(item)) {
            const labels = getPageLabelsForItem(item, pageLabelsByAttachmentId);
            const requestedPage = requestedRef ? getPageLocator(requestedRef) : undefined;
            const page = requestedPage
                ? translatePageNumberToLabel(labels, requestedPage)
                : formatCitationPages(pages, labels, {
                    inclusiveRange: !!requestedRef?.loc && isRecordIdRange(requestedRef.loc),
                });
            // The visible locator is a display label; the link navigates by
            // physical page, which is what the cited pages already are.
            const navPage = requestedPage
                ? firstPageNumber(requestedPage)
                : (pages.length > 0 ? Math.min(...pages) : undefined);
            return { kind: 'html', html: buildZoteroCitationLinkHTML(item, page
                ? { kind: 'page', value: page, raw: `page${page}` }
                : undefined, navPage) };
        }
        // The same rule note writes use: a page range or list the model wrote
        // is kept, translated to labels; a structural locator (a sentence,
        // paragraph, …) cites the page it starts on. Metadata pages and a
        // requested locator are both physical pages.
        const startPage = pages.length > 0 ? Math.min(...pages) : undefined;
        const requestedPage = requestedRef ? normalizePageRange(getPageLocator(requestedRef) ?? '') || undefined : undefined;
        // Labels come from the active render store (passed in) so note export
        // respects the isolated store populated by renderToHTML.
        const exportLabels = getPageLabelsForItem(item, pageLabelsByAttachmentId);
        // Only a PDF page is a printed page; for other attachments the
        // citation carries no page and the private metadata keeps the locator.
        let locator: string | undefined;
        if (citesPrintedPages(item)) {
            locator = requestedPage
                ? translatePageNumberToLabelFromLabels(exportLabels, requestedPage)
                : (startPage ? resolvePageLabelFromLabels(exportLabels, startPage) : undefined);
        }
        const meta = buildBeaverCitationMeta({
            loc: locatorToken(requestedRef?.loc),
            att: item.isAttachment() ? item.key : undefined,
        });
        return citationRender(buildNoteCitation(item, locator, {}, meta));
    } catch (e) {
        logger(`zoteroDocumentExport: Item not loaded for ${libraryID}/${effectiveItemKey}: ${e}`);
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
        const href = Zotero.File.pathToFileURI(path);
        return { kind: 'html', html: formatExternalFileCitationHTML(displayName, locatorSuffix, href) };
    } catch (e) {
        logger(`zoteroDocumentExport: failed to build file link for ext-${externalFileKey}: ${e}`);
        return null;
    }
}

/**
 * Render a citation of an external work (not in the library) as a native note
 * citation of an embedded item, the form note writes use.
 */
function renderExternalReferenceCitation(request: ExternalReferenceCitationExportRequest): CitationExportRender | null {
    try {
        const loc = request.requestedRef?.kind === 'external' ? request.requestedRef.loc : undefined;
        return citationRender(buildExternalNoteCitation(request.externalId, request.reference, loc));
    } catch (e) {
        logger(`zoteroDocumentExport: failed to cite external reference ${request.externalId}: ${e}`);
        return null;
    }
}

/** Zotero implementation of {@link DocumentExportHost}. */
export const zoteroDocumentExport: DocumentExportHost = {
    renderCitation,
    renderExternalFileCitation,
    renderExternalReferenceCitation,
};
