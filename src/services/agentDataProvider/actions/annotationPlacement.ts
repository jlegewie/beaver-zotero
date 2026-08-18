import type {
    AnnotationRelocation,
    RelocationPageLocation,
} from "@beaver/agent-core/types/agentActions/editAnnotations";
import type { BoundingBox } from "@beaver/agent-core/types/citations";
import {
    buildDomPlacement,
    buildHighlightPlacement,
    buildNotePlacement,
    getPageGeometryForAttachment,
    prepareEpubAnnotationTarget,
    prepareSnapshotAnnotationTarget,
    type AnnotationPlacement,
} from "../../annotations/createAnnotation";
import { getReadableContentKind } from "../../documentExtraction/attachmentResolution";
import { modelObjectId, resolveLibraryRef } from "../../../utils/libraryIdentity";

/** Annotation types a move can reposition. */
export type RelocatableAnnotationType = "highlight" | "note";

/**
 * Why a resolved destination cannot be applied to a particular annotation.
 *
 * These are model-facing skip reasons, so they name the mismatch rather than
 * the internals: the destination was resolved against a document before it
 * reached this client, and the only thing checked here is whether it fits the
 * annotation actually being moved.
 */
export class RelocationMismatchError extends Error {}

/**
 * Confirm the annotation belongs to the attachment its destination was
 * resolved against.
 *
 * An annotation cannot move between documents, and a destination resolved
 * against a different one would write coordinates from the wrong page frame.
 */
function assertSameAttachment(
    relocation: AnnotationRelocation,
    attachment: Zotero.Item,
): void {
    const targetLibraryId = resolveLibraryRef(relocation.attachment_ref);
    const matches =
        targetLibraryId === attachment.libraryID &&
        relocation.attachment_ref.zotero_key === attachment.key;
    if (!matches) {
        throw new RelocationMismatchError(
            `is not on attachment ${modelObjectId(
                targetLibraryId ?? relocation.attachment_ref.library_id,
                relocation.attachment_ref.zotero_key,
            )}; an annotation cannot move to a different document`,
        );
    }
}

function toBoundingBoxes(location: RelocationPageLocation): BoundingBox[] {
    return (location.boxes ?? []) as BoundingBox[];
}

/**
 * Turn a resolved destination into the placement to write onto an annotation.
 *
 * Everything expensive — reading the attachment, parsing an EPUB zip or a
 * snapshot's HTML, running a PDF page analysis on a geometry cache miss — is
 * done HERE, outside any transaction. Applying the returned placement is then
 * pure assignment, so the caller's write holds Zotero's global lock only for
 * as long as the save itself takes.
 */
export async function prepareRelocation(
    attachment: Zotero.Item,
    annotationType: RelocatableAnnotationType,
    relocation: AnnotationRelocation,
): Promise<AnnotationPlacement> {
    assertSameAttachment(relocation, attachment);

    const contentKind = getReadableContentKind(attachment);
    if (contentKind !== relocation.content_kind) {
        throw new RelocationMismatchError(
            `could not be moved because the attachment is not ${relocation.content_kind}`,
        );
    }

    if (contentKind === "pdf") {
        if (annotationType === "highlight") {
            if ((relocation.page_locations?.length ?? 0) > 1) {
                throw new RelocationMismatchError(
                    "cannot be moved to a destination that spans multiple pages",
                );
            }
            const location = relocation.page_locations?.[0];
            if (!location) {
                // The only destination that resolves for a note but not a
                // highlight is a page locator, so name that rather than the
                // absent field.
                throw new RelocationMismatchError(
                    "cannot be moved to a whole page; a highlight needs a locator naming text",
                );
            }
            if (!relocation.text?.trim()) {
                throw new RelocationMismatchError(
                    "cannot be moved there; the destination has no text to highlight",
                );
            }
            const geometry = await getPageGeometryForAttachment(
                attachment,
                location.page_idx,
            );
            return buildHighlightPlacement(
                {
                    pageIndex: location.page_idx,
                    boxes: toBoundingBoxes(location),
                    text: relocation.text,
                    pageLabel: location.page_label ?? relocation.page_label,
                    readingOrderOffset:
                        location.reading_order_offset ??
                        relocation.reading_order_offset,
                },
                geometry,
            );
        }
        if (!relocation.note_position) {
            throw new RelocationMismatchError(
                "cannot be moved there; the destination has no position for a note",
            );
        }
        const geometry = await getPageGeometryForAttachment(
            attachment,
            relocation.note_position.page_index,
        );
        return buildNotePlacement(
            {
                notePosition: relocation.note_position,
                pageLabel: relocation.page_label,
                readingOrderOffset: relocation.reading_order_offset,
            },
            geometry,
        );
    }

    const isHighlight = annotationType === "highlight";
    const anchorText = relocation.text ?? "";
    if (isHighlight && !anchorText) {
        throw new RelocationMismatchError(
            "cannot be moved there; the destination has no text to highlight",
        );
    }

    const resolved =
        contentKind === "epub"
            ? await prepareEpubAnnotationTarget(attachment, {
                  sectionHref: relocation.section_href ?? undefined,
                  sectionOrdinal: relocation.section_ordinal ?? undefined,
                  anchorId: relocation.anchor_id ?? undefined,
                  text: anchorText,
                  // A note renders as a margin icon beside its block, matching
                  // a note added in the reader; a highlight covers the run.
                  ...(isHighlight ? {} : { anchorToBlock: true }),
              })
            : await prepareSnapshotAnnotationTarget(attachment, {
                  anchorId: relocation.anchor_id ?? undefined,
                  text: anchorText,
                  ...(isHighlight ? {} : { anchorToBlock: true }),
              });

    return buildDomPlacement(resolved, {
        isHighlight,
        pageLabel: relocation.page_label,
    });
}
