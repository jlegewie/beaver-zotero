import { BEAVER_CITATION_ANNOTATION_AUTHOR } from '../../src/constants/annotations';
import { logger } from '../../src/utils/logger';
import { getPref } from '../../src/utils/prefs';
import { selectItemById } from '../../src/utils/selectItem';
import type { AttachmentMatchTarget } from '../agents/toolResultTypes';
import { CoordOrigin, type BoundingBox, type SymbolicLocation } from '../types/citations';
import type { ZoteroItemReference } from '../types/zotero';
import {
    BeaverTemporaryAnnotations,
    createBoundingBoxHighlights,
} from './annotationUtils';
import {
    flashHighlightBoundingBoxes,
    presentTemporaryAnnotations,
} from './citationNavigation';
import { navigateToEpubCitation } from './epubVisualizer/epubCitationNavigation';
import { navigateToSnapshotCitation } from './snapshotVisualizer/snapshotCitationNavigation';
import { getCurrentReaderAndWaitForView } from './readerUtils';
import { revealSource } from './sourceUtils';

/** One find_in_attachments match to navigate to. */
export interface AttachmentMatchNavRequest {
    library_id: number;
    zotero_key: string;
    /** Device-portable library identity ("u" | "g<groupID>"). */
    library_ref?: string;
    content_kind: 'pdf' | 'epub' | 'text' | 'snapshot';
    /** 1-based page number (EPUB: 1-based section ordinal). */
    page_number?: number;
    /** Printed page label for the matched page, when known. */
    page_label?: string;
    /** Compact part location from the backend summary. */
    target?: AttachmentMatchTarget;
    /** Match preview text, used for temporary-annotation comments and EPUB search. */
    snippet?: string;
    ownerDocument?: Document;
}

/**
 * Navigate to a find_in_attachments match and highlight it.
 *
 * Condensed adaptation of the citation activation flow in
 * `react/host/zotero/citationActivation.ts`, driven by the compact
 * `AttachmentMatchTarget` wire format instead of CitationMetadata:
 * PDF matches flash (or temporarily annotate) the target bounding boxes,
 * EPUB matches resolve the section/passage in the live reader, text files
 * open in the OS default viewer. Every failure degrades to selecting the
 * attachment in the library.
 */
export async function navigateToAttachmentMatch(nav: AttachmentMatchNavRequest): Promise<void> {
    const useTemporaryAnnotations = getPref('useTemporaryCitationAnnotations') === true;

    // Cleanup any existing temporary annotations
    await BeaverTemporaryAnnotations.cleanupAll();

    const item = await Zotero.Items.getByLibraryAndKeyAsync(nav.library_id, nav.zotero_key);
    if (!item) {
        logger(`navigateToAttachmentMatch: item not found (${nav.library_id}-${nav.zotero_key})`);
        return;
    }
    await item.loadAllData();

    if (!item.isAttachment()) {
        revealSource({
            library_id: nav.library_id,
            zotero_key: nav.zotero_key,
            library_ref: nav.library_ref,
        } as ZoteroItemReference);
        return;
    }

    // Text files: no in-app reader; open in the OS default viewer
    if (nav.content_kind === 'text') {
        const filePath = await item.getFilePathAsync();
        if (filePath) {
            logger(`navigateToAttachmentMatch: opening text file: ${filePath}`);
            Zotero.launchFile(filePath);
        } else {
            await selectItemById(item.id);
        }
        return;
    }

    if (nav.content_kind === 'epub') {
        const symbolicLocation: SymbolicLocation | undefined = nav.target?.section_href
            ? {
                content_kind: 'epub',
                section_href: nav.target.section_href,
                anchor_id: nav.target.anchor_id,
                text: nav.target.text,
            }
            : undefined;
        const outcome = await navigateToEpubCitation({
            item,
            symbolicLocation,
            sectionOrdinal: nav.page_number,
            searchText: nav.target?.text ?? nav.snippet,
            previewText: nav.snippet,
            useTemporaryAnnotations,
            ownerDocument: nav.ownerDocument,
        });
        logger(`navigateToAttachmentMatch: EPUB navigation outcome: ${outcome}`);
        if (outcome === 'failed') {
            revealSource({
                library_id: nav.library_id,
                zotero_key: nav.zotero_key,
                library_ref: nav.library_ref,
            } as ZoteroItemReference);
        }
        return;
    }

    if (nav.content_kind === 'snapshot') {
        // Snapshots have no section/page navigation (continuous scroll view);
        // resolve the cited passage from the target's anchor/text in the live
        // reader DOM, the same way snapshot citation clicks do.
        const symbolicLocation: SymbolicLocation | undefined =
            (nav.target?.anchor_id || nav.target?.text)
                ? {
                    content_kind: 'snapshot',
                    anchor_id: nav.target.anchor_id,
                    text: nav.target.text,
                }
                : undefined;
        const outcome = await navigateToSnapshotCitation({
            item,
            symbolicLocation,
            searchText: nav.target?.text ?? nav.snippet,
            previewText: nav.snippet,
            useTemporaryAnnotations,
            ownerDocument: nav.ownerDocument,
        });
        logger(`navigateToAttachmentMatch: snapshot navigation outcome: ${outcome}`);
        if (outcome === 'failed') {
            revealSource({
                library_id: nav.library_id,
                zotero_key: nav.zotero_key,
                library_ref: nav.library_ref,
            } as ZoteroItemReference);
        }
        return;
    }

    // Other non-PDF attachments: open the reader without locators
    if (nav.content_kind !== 'pdf') {
        try {
            await Zotero.Reader.open(item.id);
        } catch (error) {
            logger(`navigateToAttachmentMatch: failed to open non-PDF attachment: ${error}`);
            await selectItemById(item.id);
        }
        return;
    }

    // PDF: open the reader at the matched page and highlight the target boxes
    const pageIndex = nav.target?.page_idx
        ?? (nav.page_number !== undefined ? nav.page_number - 1 : undefined);
    if (pageIndex === undefined) {
        await selectItemById(item.id);
        return;
    }

    try {
        let reader = await getCurrentReaderAndWaitForView(undefined, true);
        if (!reader || reader.itemID !== item.id) {
            logger(`navigateToAttachmentMatch: opening item ${item.id} at page index ${pageIndex}`);
            reader = await Zotero.Reader.open(item.id, { pageIndex });
            // Wait for the reader to initialize before navigating
            await new Promise(resolve => setTimeout(resolve, 300));
            reader = await getCurrentReaderAndWaitForView(undefined, true);
        }

        const boxes: BoundingBox[] = (nav.target?.boxes ?? []).map(([l, t, r, b]) => ({
            l, t, r, b,
            coord_origin: CoordOrigin.TOPLEFT,
        }));

        if (boxes.length > 0) {
            // Shape matches both TemporaryHighlightLocation (annotationUtils)
            // and HighlightLocation (citationNavigation).
            const locations: { pageIndex: number; boxes: BoundingBox[]; pageLabel?: string | null }[] = [
                { pageIndex, boxes, pageLabel: nav.page_label ?? null },
            ];
            if (useTemporaryAnnotations) {
                const annotationReferences = await createBoundingBoxHighlights(
                    locations,
                    nav.snippet ?? '',
                    BEAVER_CITATION_ANNOTATION_AUTHOR,
                    { authorName: BEAVER_CITATION_ANNOTATION_AUTHOR },
                );
                if (reader) {
                    presentTemporaryAnnotations(reader, annotationReferences, {
                        ownerDocument: nav.ownerDocument,
                        logContext: 'navigateToAttachmentMatch',
                    });
                } else {
                    // Keep created annotations tracked for cleanup even when
                    // the reader handle is unavailable.
                    BeaverTemporaryAnnotations.addToTracking(annotationReferences);
                }
            } else if (reader) {
                await flashHighlightBoundingBoxes(reader, locations);
            }
        } else if (reader) {
            reader.navigate({ pageIndex });
        }
    } catch (error) {
        logger(`navigateToAttachmentMatch: failed to navigate PDF match: ${error}`);
        await selectItemById(item.id);
    }
}
