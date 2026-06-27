import { logger } from "../../../utils/logger";
import {
    citationSearchTextCandidates,
    createContainingBlockRange,
    createElementContentsRange,
    createSentenceRange,
    findAnchorElement,
} from "../../documentExtraction/dom/textRange";
import { parseSnapshotHtml } from "../../documentExtraction/snapshot/snapshotDom";
import {
    buildSnapshotSortIndex,
    toSnapshotSelector,
    type SnapshotSelector,
} from "./snapshotAnnotationGeometry";

/** Locator for a passage to annotate inside a snapshot, from citation metadata. */
export interface SnapshotAnnotationLocator {
    /** DOM id of the cited element, when known. */
    anchorId?: string;
    /** Cited passage text used to anchor a precise range. */
    text?: string;
    /**
     * Anchor the stored selector to the cited text's containing block instead of
     * the exact passage range. Used for note/point annotations so the reader
     * renders the comment icon in the margin beside the block; the cited passage
     * still selects which block. Highlights leave this unset.
     */
    anchorToBlock?: boolean;
}

/** A resolved snapshot annotation position + sortIndex, ready to persist. */
export interface ResolvedSnapshotAnnotation {
    position: SnapshotSelector;
    sortIndex: string;
    /** Text covered by the precise passage range (for highlight `annotationText`). */
    text: string;
}

export type SnapshotAnnotationResolveErrorCode =
    | "snapshot_text_not_found"
    | "snapshot_selector_failed"
    | "snapshot_parse_failed";

export interface SnapshotAnnotationResolveError {
    error: SnapshotAnnotationResolveErrorCode;
    message?: string;
}

function isResolveError(value: unknown): value is SnapshotAnnotationResolveError {
    return typeof value === "object" && value !== null && "error" in value;
}

/**
 * Build the snapshot selector + sortIndex from a prepared snapshot document.
 * Locates the cited range (anchor-scoped, then body-wide, then anchor contents —
 * mirroring the EPUB resolver), then emits the reader-matching CssSelector and
 * 7-digit sortIndex via the vendored reader helpers.
 */
export function buildAnnotationFromDocument(
    doc: Document,
    target: SnapshotAnnotationLocator,
): { position: SnapshotSelector; sortIndex: string; text: string } | SnapshotAnnotationResolveError {
    const body = doc.body ?? doc.querySelector("body");
    if (!body) return { error: "snapshot_text_not_found" };

    const anchorElement = target.anchorId
        ? findAnchorElement(body, target.anchorId)
        : undefined;
    const searchTexts = citationSearchTextCandidates(target.text);

    let range: Range | undefined;
    if (anchorElement) {
        for (const searchText of searchTexts) {
            range = createSentenceRange(anchorElement, searchText);
            if (range) break;
        }
    }
    if (!range) {
        for (const searchText of searchTexts) {
            range = createSentenceRange(body, searchText);
            if (range) break;
        }
    }
    if (!range && anchorElement) {
        range = createElementContentsRange(anchorElement);
    }
    if (!range) return { error: "snapshot_text_not_found" };

    // Highlights store the precise passage range. Notes anchor to the cited
    // text's containing block so the reader's comment icon lands in the margin;
    // the cited passage still selects the block. Falls back to the passage range.
    const text = range.toString();
    const selectorRange = target.anchorToBlock
        ? (createContainingBlockRange(range) ?? range)
        : range;

    let position: SnapshotSelector | null;
    try {
        position = toSnapshotSelector(selectorRange);
    } catch (error) {
        return { error: "snapshot_selector_failed", message: String(error) };
    }
    if (!position) return { error: "snapshot_selector_failed" };

    const sortIndex = buildSnapshotSortIndex(selectorRange, body);
    return { position, sortIndex, text };
}

/**
 * Resolve a snapshot annotation locator to a persistable `{ position, sortIndex }`
 * by parsing the snapshot HTML headlessly — no reader instance. Parses the file
 * with the same transforms the reader applies (see `parseSnapshotHtml`) so the
 * CSS selector + offsets line up with the live `SnapshotView`. Returns a typed
 * error on any failure.
 */
export async function resolveSnapshotAnnotationTarget(
    filePath: string,
    target: SnapshotAnnotationLocator,
): Promise<ResolvedSnapshotAnnotation | SnapshotAnnotationResolveError> {
    let doc: Document;
    try {
        const bytes = await IOUtils.read(filePath);
        doc = parseSnapshotHtml(bytes);
    } catch (error) {
        logger(`[SnapshotAnnotation] Failed to parse snapshot: ${error}`, 1);
        return { error: "snapshot_parse_failed", message: String(error) };
    }

    const built = buildAnnotationFromDocument(doc, target);
    if (isResolveError(built)) return built;
    return built;
}
