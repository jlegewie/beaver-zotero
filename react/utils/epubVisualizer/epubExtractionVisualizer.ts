import { extractEpubDocument } from "../../../src/services/documentExtraction/epub";
import { logger } from "../../../src/utils/logger";
import { BeaverTemporaryAnnotations } from "../annotationUtils";
import {
    annotationFromRange,
    getActiveEpubView,
    getVisibleSectionIndexes,
    setTemporaryAnnotations,
} from "./epubReaderView";
import {
    buildEpubItemOverlay,
    buildEpubSentenceOverlay,
    type EpubOverlayResult,
} from "./epubExtractionOverlay";
import { resolveEpubRanges } from "./epubRangeResolver";

interface EpubVisualizerResult {
    success: boolean;
    message: string;
    count?: number;
}

/** Visualize extracted EPUB items in the visible reader sections. */
export async function visualizeEpubItems(): Promise<EpubVisualizerResult> {
    return visualizeEpub("items");
}

/** Visualize extracted EPUB sentences in the visible reader sections. */
export async function visualizeEpubSentences(): Promise<EpubVisualizerResult> {
    return visualizeEpub("sentences");
}

async function visualizeEpub(level: "items" | "sentences"): Promise<EpubVisualizerResult> {
    try {
        const ctx = await getActiveEpubView();
        if ("error" in ctx) return { success: false, message: ctx.error };
        const { reader, primaryView, item } = ctx;

        await BeaverTemporaryAnnotations.cleanupAll(reader);

        const visibleSectionIndexes = getVisibleSectionIndexes(primaryView);
        if (visibleSectionIndexes.length === 0) {
            return { success: true, message: "No visible EPUB sections found", count: 0 };
        }

        logger(`[EpubVisualizer] Extracting EPUB for ${level} visualization...`);
        const document = await extractEpubDocument(item);
        const overlay = level === "items"
            ? buildEpubItemOverlay(document)
            : buildEpubSentenceOverlay(document);

        logUnsupportedPictures(overlay);

        const visibleExtractedDescriptors = resolveEpubRanges(
            primaryView,
            document,
            overlay.descriptors,
            visibleSectionIndexes,
        );
        if (visibleExtractedDescriptors.length === 0) {
            return {
                success: true,
                message: `No drawable EPUB ${level} found in visible sections`,
                count: 0,
            };
        }

        const annotations = [];
        let fallbackCount = 0;
        for (const resolved of visibleExtractedDescriptors) {
            if (resolved.usedItemFallback) fallbackCount += 1;
            const color = resolved.sentence?.color ?? resolved.descriptor.color;
            const type = resolved.sentence ? "underline" : resolved.descriptor.type;
            const annotation = annotationFromRange(primaryView, resolved.range, type, color);
            if (!annotation) {
                logger(`[EpubVisualizer] Reader could not create annotation for ${resolved.descriptor.itemId}`, 1);
                continue;
            }
            const label = resolved.sentence?.label ?? resolved.descriptor.label;
            const comment = resolved.sentence?.annotationComment
                ?? resolved.descriptor.annotationComment;
            annotations.push({
                ...annotation,
                color,
                text: label,
                comment,
            });
        }

        const refs = setTemporaryAnnotations(reader, annotations);
        BeaverTemporaryAnnotations.addToTracking(refs);

        const fallbackTail = fallbackCount > 0
            ? ` (${fallbackCount} sentence fallback${fallbackCount === 1 ? "" : "s"})`
            : "";
        const message = `EPUB ${level}: ${refs.length} annotation(s) in visible sections${fallbackTail}`;
        logger(`[EpubVisualizer] ${message}`);
        return { success: true, message, count: refs.length };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger(`[EpubVisualizer] Error: ${errorMessage}`, 1);
        return { success: false, message: `EPUB visualization failed: ${errorMessage}` };
    }
}

function logUnsupportedPictures(overlay: EpubOverlayResult): void {
    if (overlay.stats.unsupportedPictures > 0) {
        logger(
            `[EpubVisualizer] Skipping ${overlay.stats.unsupportedPictures} picture item(s); EPUB image-only ranges cannot be CFI-anchored`,
            1,
        );
    }
}
