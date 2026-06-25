import { BEAVER_CITATION_ANNOTATION_AUTHOR } from "../../../src/constants/annotations";
import { logger } from "../../../src/utils/logger";
import { getBestEpubAttachmentAsync } from "../../../src/utils/zoteroItemHelpers";
import type { SymbolicLocation } from "../../types/citations";
import type { ZoteroReader } from "../annotationUtils";
import { presentTemporaryAnnotations } from "../citationNavigation";
import { getCurrentReaderAndWaitForView, waitForReaderForItem } from "../readerUtils";
import {
    annotationFromRange,
    getSectionCount,
    getSectionHref,
    setTemporaryAnnotations,
    type EpubPrimaryView,
} from "./epubReaderView";
import {
    resolveEpubCitationRange,
    type EpubCitationTarget,
} from "./epubRangeResolver";

/** Same highlight color as PDF citation bounding-box highlights. */
const EPUB_CITATION_HIGHLIGHT_COLOR = "#00bbff";

export type EpubCitationNavigationOutcome =
    /** Cited passage located and flashed/highlighted. */
    | "highlighted"
    /** Only the section could be resolved; scrolled to its start. */
    | "section"
    /** Reader opened but no locator could be resolved. */
    | "opened"
    /** No EPUB attachment or no reader; caller should fall back. */
    | "failed";

export interface NavigateToEpubCitationOptions {
    /** Resolved citation item — the EPUB attachment or its parent regular item. */
    item: Zotero.Item;
    /** Symbolic location from citation metadata, when the backend provides one. */
    symbolicLocation?: SymbolicLocation;
    /** 1-based agent-facing "page" (EPUB section ordinal). */
    sectionOrdinal?: number;
    /** Cited sentence text used to locate a precise range (symbolic text wins). */
    searchText?: string;
    /** Preview text stored on the temporary annotation comment. */
    previewText?: string;
    /** Temporary-annotation mode vs. the reader's native spotlight flash. */
    useTemporaryAnnotations: boolean;
    ownerDocument?: Document;
}

/**
 * Navigate a citation click to its location inside an EPUB: open (or switch
 * to) the attachment's reader, resolve the cited section/passage to a live
 * DOM range, and either inject a temporary highlight annotation or flash the
 * reader's native navigation spotlight. Falls back to scrolling to the
 * section start, then to just opening the reader.
 */
export async function navigateToEpubCitation(
    options: NavigateToEpubCitationOptions,
): Promise<EpubCitationNavigationOutcome> {
    const attachment = await getBestEpubAttachmentAsync(options.item);
    if (!attachment || !attachment.isAttachment?.()) {
        logger(`navigateToEpubCitation: No EPUB attachment for item ${options.item.id}`);
        return "failed";
    }

    let reader = await getCurrentReaderAndWaitForView(undefined, false);
    if (!reader || reader.itemID !== attachment.id) {
        logger(`navigateToEpubCitation: Opening EPUB ${attachment.id} in reader`);
        const opened = await Zotero.Reader.open(attachment.id);
        reader = await waitForReaderForItem(attachment.id, opened);
    }
    if (!reader) return "failed";
    if (reader.type !== "epub") {
        logger(`navigateToEpubCitation: Reader for ${attachment.id} is not an EPUB reader`, 1);
        return "opened";
    }

    try {
        const primaryView = reader._internalReader?._primaryView as EpubPrimaryView | undefined;
        if (!primaryView) return "opened";
        await waitForSectionRenderers(primaryView);

        const epubLocation = options.symbolicLocation?.content_kind === "epub"
            ? options.symbolicLocation
            : undefined;
        const target: EpubCitationTarget = {
            sectionHref: epubLocation?.section_href,
            sectionOrdinal: options.sectionOrdinal,
            anchorId: epubLocation?.anchor_id,
            text: epubLocation?.text ?? options.searchText,
        };

        const resolved = resolveEpubCitationRange(primaryView, target);
        if (!resolved) return "opened";

        if (resolved.range) {
            const annotation = annotationFromRange(
                primaryView,
                resolved.range,
                "highlight",
                EPUB_CITATION_HIGHLIGHT_COLOR,
            );
            if (annotation) {
                if (options.useTemporaryAnnotations) {
                    const annotationReferences = setTemporaryAnnotations(
                        reader as ZoteroReader,
                        [{ ...annotation, comment: options.previewText ?? "" }],
                        {
                            authorName: BEAVER_CITATION_ANNOTATION_AUTHOR,
                            idPrefix: "epub_citation",
                        },
                    );
                    const presented = presentTemporaryAnnotations(
                        reader as ZoteroReader,
                        annotationReferences,
                        {
                            ownerDocument: options.ownerDocument,
                            logContext: "ZoteroCitation",
                            // Navigate by the CFI position, not the temporary
                            // annotation id: it resolves immediately and lands
                            // reliably even on a cold reader open (the by-id
                            // navigate races the annotation registration).
                            navigateLocation: annotation.position
                                ? { position: annotation.position }
                                : undefined,
                        },
                    );
                    if (presented) return "highlighted";
                } else if (annotation.position) {
                    // The reader's selector navigation scrolls and flashes its
                    // native spotlight — the EPUB analogue of the PDF position flash.
                    (reader as any).navigate({ position: annotation.position });
                    return "highlighted";
                }
            }
        }

        const sectionHref = getSectionHref(primaryView, resolved.sectionIndex);
        if (sectionHref) {
            (reader as any).navigate({ href: sectionHref });
            return "section";
        }
        return "opened";
    } catch (error) {
        logger(`navigateToEpubCitation: Failed to navigate: ${error}`, 1);
        return "opened";
    }
}

/**
 * A freshly opened reader can report its view before the spine renderers
 * exist; wait briefly for them so locator resolution doesn't silently fail.
 */
async function waitForSectionRenderers(
    primaryView: EpubPrimaryView,
    timeoutMs = 2000,
): Promise<void> {
    const start = Date.now();
    while (getSectionCount(primaryView) === 0 && Date.now() - start < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
