import { logger } from "../../../src/utils/logger";
import {
    collectDomItems,
    normalizeText,
    type DomItem,
} from "../../../src/services/documentExtraction/dom";
import {
    type EpubDocument,
} from "../../../src/services/documentExtraction/epub";
import {
    createElementContentsRange,
    createSentenceRange,
    normalizeHrefBasename,
    resolveAnchoredTextRange,
} from "../../../src/services/documentExtraction/dom/textRange";

// Re-export the shared text-search helpers for callers that use this reader-side
// module. The implementations live in `src/dom` so headless annotation resolvers
// can reuse them.
export {
    createElementContentsRange,
    createSentenceRange,
    normalizeHrefBasename,
} from "../../../src/services/documentExtraction/dom/textRange";
import {
    ensureSectionMounted,
    getSectionBody,
    getSectionCount,
    getSectionHref,
    type EpubPrimaryView,
} from "./epubReaderView";
import type {
    EpubDrawDescriptor,
    EpubSentenceDescriptor,
} from "./epubExtractionOverlay";

export interface ResolvedEpubRange {
    descriptor: EpubDrawDescriptor;
    range: Range;
    sentence?: EpubSentenceDescriptor;
    usedItemFallback?: boolean;
}

/** Resolve EPUB draw descriptors to live DOM ranges in the active reader. */
export function resolveEpubRanges(
    primaryView: EpubPrimaryView,
    document: EpubDocument,
    descriptors: EpubDrawDescriptor[],
    visibleReaderSectionIndexes: number[],
): ResolvedEpubRange[] {
    const sectionIndexMap = mapExtractedSectionsToReaderSections(
        primaryView,
        document,
        visibleReaderSectionIndexes,
    );
    const descriptorsBySection = groupDescriptorsBySection(descriptors);
    const resolved: ResolvedEpubRange[] = [];

    for (const [extractedSectionIndex, sectionDescriptors] of descriptorsBySection) {
        const readerSectionIndex = sectionIndexMap.get(extractedSectionIndex);
        if (readerSectionIndex === undefined) continue;

        const body = getSectionBody(primaryView, readerSectionIndex);
        if (!body) {
            logger(`[EpubVisualizer] Missing live section body for reader section ${readerSectionIndex}`, 1);
            continue;
        }

        const section = document.sections.find((entry) => entry.index === extractedSectionIndex);
        if (!section) continue;

        const candidates = collectDomItems(body);
        const itemMap = alignSectionItems(section.items, candidates);

        for (const descriptor of sectionDescriptors) {
            const match = itemMap.get(descriptor.itemId);
            if (!match) {
                logger(`[EpubVisualizer] Could not align EPUB item ${descriptor.itemId}`, 1);
                continue;
            }

            const itemRange = createElementContentsRange(match.element);
            if (!itemRange) continue;

            const sentences = descriptor.sentences ?? [];
            if (descriptor.kind === "sentence" && sentences.length > 0) {
                for (const sentence of sentences) {
                    const sentenceRange = createSentenceRange(match.element, sentence.text);
                    if (sentenceRange) {
                        resolved.push({ descriptor, range: sentenceRange, sentence });
                    } else {
                        resolved.push({
                            descriptor,
                            range: itemRange.cloneRange(),
                            sentence,
                            usedItemFallback: true,
                        });
                    }
                }
            } else {
                resolved.push({ descriptor, range: itemRange });
            }
        }
    }

    return resolved;
}

/** Citation locator inside an EPUB, as carried by citation metadata. */
export interface EpubCitationTarget {
    /** Section href from the citation's symbolic location (matched by basename). */
    sectionHref?: string;
    /** 1-based agent-facing "page" (section ordinal); used when no href matches. */
    sectionOrdinal?: number;
    /** DOM id of the cited element inside the section, when known. */
    anchorId?: string;
    /** Cited sentence text to anchor a precise highlight range. */
    text?: string;
}

export interface ResolvedEpubCitationTarget {
    /** Reader spine section index the citation points at. */
    sectionIndex: number;
    /** Precise live-DOM range when the cited text/anchor could be located. */
    range?: Range;
}

/**
 * Resolve a citation locator to a reader spine section and, when possible, a
 * precise DOM range — without requiring an extracted `EpubDocument`. The
 * section is found by href basename (falling back to the 1-based section
 * ordinal, which is 1:1 with the spine); the range by anchor id and/or
 * normalized sentence-text search. Text search returns the first match, so
 * `anchorId` scoping is what disambiguates repeated phrases.
 *
 * Mounts the target section if the reader has it unmounted (mirrors the
 * reader's own CFI navigation behavior). Returns null when no section can be
 * determined; returns a section without a range when only coarse navigation
 * is possible.
 */
export function resolveEpubCitationRange(
    primaryView: EpubPrimaryView,
    target: EpubCitationTarget,
): ResolvedEpubCitationTarget | null {
    const sectionIndex = resolveCitationSectionIndex(primaryView, target);
    if (sectionIndex === undefined) return null;

    if (!ensureSectionMounted(primaryView, sectionIndex)) {
        return { sectionIndex };
    }
    const body = getSectionBody(primaryView, sectionIndex);
    if (!body) return { sectionIndex };

    // Shared anchor-scoped → body-wide → anchor-contents search. The
    // anchor-contents fallback lets an anchor-only locator still resolve a range.
    const range = resolveAnchoredTextRange(body, {
        anchorId: target.anchorId,
        text: target.text,
    });
    return range ? { sectionIndex, range } : { sectionIndex };
}

function resolveCitationSectionIndex(
    primaryView: EpubPrimaryView,
    target: EpubCitationTarget,
): number | undefined {
    const sectionCount = getSectionCount(primaryView);

    const targetBasename = normalizeHrefBasename(target.sectionHref);
    if (targetBasename) {
        for (let index = 0; index < sectionCount; index++) {
            if (normalizeHrefBasename(getSectionHref(primaryView, index)) === targetBasename) {
                return index;
            }
        }
        logger(`[EpubVisualizer] No reader section matches citation href ${targetBasename}`, 1);
    }

    // Ordinal fallback: extraction ordinals are 1:1 with reader spine indexes
    // only for all-XHTML spines — the extractor skips non-XHTML spine items,
    // compacting its indexes below the reader's. The href match above is the
    // reliable locator; the ordinal can land one-or-more sections early for
    // EPUBs with skipped spine entries.
    if (
        typeof target.sectionOrdinal === "number"
        && Number.isInteger(target.sectionOrdinal)
    ) {
        const index = target.sectionOrdinal - 1;
        if (index >= 0 && index < sectionCount) return index;
        logger(`[EpubVisualizer] Citation section ordinal ${target.sectionOrdinal} is out of range`, 1);
    }

    return undefined;
}

function mapExtractedSectionsToReaderSections(
    primaryView: EpubPrimaryView,
    document: EpubDocument,
    visibleReaderSectionIndexes: number[],
): Map<number, number> {
    const extractedByBasename = new Map<string, number>();
    for (const section of document.sections) {
        const basename = normalizeHrefBasename(section.rawHref);
        if (basename) extractedByBasename.set(basename, section.index);
    }

    const result = new Map<number, number>();
    for (const readerSectionIndex of visibleReaderSectionIndexes) {
        const basename = normalizeHrefBasename(getSectionHref(primaryView, readerSectionIndex));
        if (!basename) {
            logger(`[EpubVisualizer] Reader section ${readerSectionIndex} has no href`, 1);
            continue;
        }

        const extractedSectionIndex = extractedByBasename.get(basename);
        if (extractedSectionIndex === undefined) {
            logger(`[EpubVisualizer] No extracted EPUB section matches reader href ${basename}`, 1);
            continue;
        }

        result.set(extractedSectionIndex, readerSectionIndex);
    }
    return result;
}

function groupDescriptorsBySection(
    descriptors: EpubDrawDescriptor[],
): Map<number, EpubDrawDescriptor[]> {
    const grouped = new Map<number, EpubDrawDescriptor[]>();
    for (const descriptor of descriptors) {
        const list = grouped.get(descriptor.sectionIndex);
        if (list) list.push(descriptor);
        else grouped.set(descriptor.sectionIndex, [descriptor]);
    }
    return grouped;
}

function alignSectionItems(
    extractedItems: DomItem[],
    candidates: ReturnType<typeof collectDomItems>,
): Map<string, ReturnType<typeof collectDomItems>[number]> {
    const result = new Map<string, ReturnType<typeof collectDomItems>[number]>();
    let candidateIndex = 0;

    for (const item of extractedItems) {
        if (item.kind === "picture") continue;

        const targetText = normalizeText(item.text);
        if (!targetText) continue;

        let matchedIndex = -1;
        for (let i = candidateIndex; i < candidates.length; i++) {
            const candidate = candidates[i];
            if (candidate.kind !== item.kind) continue;
            if (textsMatch(targetText, normalizeText(candidate.text))) {
                matchedIndex = i;
                break;
            }
        }

        if (matchedIndex === -1) {
            logger(`[EpubVisualizer] No DOM candidate matched EPUB item ${item.id}`, 1);
            continue;
        }

        result.set(item.id, candidates[matchedIndex]);
        candidateIndex = matchedIndex + 1;
    }

    return result;
}

function textsMatch(extractedText: string, candidateText: string): boolean {
    if (extractedText === candidateText) return true;
    return candidateText.includes(extractedText) || extractedText.includes(candidateText);
}
