import { BEAVER_CITATION_ANNOTATION_AUTHOR } from "../../../src/constants/annotations";
import { logger } from "../../../src/utils/logger";
import { getBestSnapshotAttachmentAsync } from "../../../src/utils/zoteroItemHelpers";
import {
    buildSnapshotSortIndex,
    toSnapshotSelector,
} from "../../../src/services/annotations/snapshot/snapshotAnnotationGeometry";
import type { SymbolicLocation } from "../../types/citations";
import type { ZoteroReader } from "../annotationUtils";
import { presentTemporaryAnnotations } from "../citationNavigation";
import { setTemporaryAnnotations } from "../epubVisualizer/epubReaderView";
import { getCurrentReaderAndWaitForView, waitForReaderForItem } from "../readerUtils";
import { getSnapshotPreBody, type SnapshotPrimaryView } from "./snapshotReaderView";
import { resolveSnapshotCitationRange } from "./snapshotRangeResolver";

/** Same highlight color as PDF/EPUB citation highlights. */
const SNAPSHOT_CITATION_HIGHLIGHT_COLOR = "#00bbff";

export type SnapshotCitationNavigationOutcome =
    /** Cited passage located and flashed/highlighted. */
    | "highlighted"
    /** Reader opened but no locator could be resolved. */
    | "opened"
    /** No snapshot attachment or no reader; caller should fall back. */
    | "failed";

export interface NavigateToSnapshotCitationOptions {
    /** Resolved citation item — the snapshot attachment or its parent regular item. */
    item: Zotero.Item;
    /** Symbolic location from citation metadata, when the backend provides one. */
    symbolicLocation?: SymbolicLocation;
    /** Cited sentence text used to locate a precise range (symbolic text wins). */
    searchText?: string;
    /** Preview text stored on the temporary annotation comment. */
    previewText?: string;
    /** Temporary-annotation mode vs. the reader's native spotlight flash. */
    useTemporaryAnnotations: boolean;
    ownerDocument?: Document;
}

/**
 * Navigate a citation click to its location inside a web snapshot: open (or switch
 * to) the attachment's reader, resolve the cited passage to a live DOM range, and
 * either inject a temporary highlight annotation or flash the reader's native
 * navigation spotlight. Falls back to just opening the reader.
 *
 * The position selector + sortIndex are built from the live DOM with the same
 * helpers used for headless annotations, so navigation matches stored annotations.
 * Navigation goes through `reader.navigate({ position })`, which maps the selector
 * back to the displayed DOM (reading-mode safe).
 */
export async function navigateToSnapshotCitation(
    options: NavigateToSnapshotCitationOptions,
): Promise<SnapshotCitationNavigationOutcome> {
    const attachment = await getBestSnapshotAttachmentAsync(options.item);
    if (!attachment || !attachment.isAttachment?.()) {
        logger(`navigateToSnapshotCitation: No snapshot attachment for item ${options.item.id}`);
        return "failed";
    }

    let reader = await getCurrentReaderAndWaitForView(undefined, false);
    if (!reader || reader.itemID !== attachment.id) {
        logger(`navigateToSnapshotCitation: Opening snapshot ${attachment.id} in reader`);
        const opened = await Zotero.Reader.open(attachment.id);
        reader = await waitForReaderForItem(attachment.id, opened);
    }
    if (!reader) return "failed";
    if (reader.type !== "snapshot") {
        logger(`navigateToSnapshotCitation: Reader for ${attachment.id} is not a snapshot reader`, 1);
        return "opened";
    }

    try {
        const primaryView = reader._internalReader?._primaryView as SnapshotPrimaryView | undefined;
        if (!primaryView) return "opened";
        // Resolve against the reader's preBody (original DOM), not the focus/reading
        // view. In reading mode the displayed body is Readability-restructured, but
        // the reader resolves the stored selector against preBody and maps it to the
        // focus DOM for display — so the selector must be built against preBody.
        const body = getSnapshotPreBody(primaryView);
        if (!body) return "opened";

        const snapshotLocation = options.symbolicLocation?.content_kind === "snapshot"
            ? options.symbolicLocation
            : undefined;
        const range = resolveSnapshotCitationRange(body, {
            anchorId: snapshotLocation?.anchor_id,
            text: snapshotLocation?.text ?? options.searchText,
        });
        if (!range) return "opened";

        let position;
        try {
            position = toSnapshotSelector(range);
        } catch (error) {
            logger(`navigateToSnapshotCitation: selector build failed: ${error}`, 1);
            position = null;
        }
        if (!position) return "opened";

        const annotation = {
            type: "highlight" as const,
            color: SNAPSHOT_CITATION_HIGHLIGHT_COLOR,
            sortIndex: buildSnapshotSortIndex(range, body),
            position,
            text: range.toString(),
        };

        if (options.useTemporaryAnnotations) {
            const annotationReferences = setTemporaryAnnotations(
                reader as ZoteroReader,
                [{ ...annotation, comment: options.previewText ?? "" }],
                {
                    authorName: BEAVER_CITATION_ANNOTATION_AUTHOR,
                    idPrefix: "snapshot_citation",
                },
            );
            const presented = presentTemporaryAnnotations(
                reader as ZoteroReader,
                annotationReferences,
                {
                    ownerDocument: options.ownerDocument,
                    logContext: "ZoteroCitation",
                    navigateLocation: { position },
                },
            );
            if (presented) return "highlighted";
        }

        (reader as any).navigate({ position });
        return "highlighted";
    } catch (error) {
        logger(`navigateToSnapshotCitation: Failed to navigate: ${error}`, 1);
        return "opened";
    }
}
