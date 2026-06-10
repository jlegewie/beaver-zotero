import { logger } from "../../../src/utils/logger";
import {
    collectDomItems,
    NON_CONTENT_SELECTOR,
    normalizeText,
    type DomItem,
} from "../../../src/services/documentExtraction/dom";
import {
    type EpubDocument,
} from "../../../src/services/documentExtraction/epub";
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

    const anchorElement = target.anchorId
        ? findAnchorElement(body, target.anchorId)
        : undefined;
    const searchText = sanitizeCitationSearchText(target.text);

    if (searchText) {
        if (anchorElement) {
            const scopedRange = createSentenceRange(anchorElement, searchText);
            if (scopedRange) return { sectionIndex, range: scopedRange };
        }
        const bodyRange = createSentenceRange(body, searchText);
        if (bodyRange) return { sectionIndex, range: bodyRange };
    }

    if (anchorElement) {
        const anchorRange = createElementContentsRange(anchorElement);
        if (anchorRange) return { sectionIndex, range: anchorRange };
    }

    return { sectionIndex };
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

function findAnchorElement(body: HTMLElement, anchorId: string): Element | undefined {
    // Attribute selector instead of #id so arbitrary ids only need string escaping.
    const escaped = anchorId.replace(/["\\]/g, "\\$&");
    try {
        return body.querySelector(`[id="${escaped}"]`) ?? undefined;
    } catch (error) {
        logger(`[EpubVisualizer] Invalid citation anchor id "${anchorId}": ${error}`, 1);
        return undefined;
    }
}

/**
 * Citation preview text can arrive as an HTML fragment; strip markup so the
 * normalized substring search can match the live text nodes.
 */
function sanitizeCitationSearchText(text: string | undefined): string | undefined {
    if (!text) return undefined;
    const stripped = text.replace(/<[^>]*>/g, " ");
    return normalizeText(stripped) || undefined;
}

export function normalizeHrefBasename(href: string | undefined): string | undefined {
    if (!href) return undefined;
    const withoutHash = href.split("#", 1)[0];
    const withoutQuery = withoutHash.split("?", 1)[0];
    const parts = withoutQuery.split("/").filter(Boolean);
    return parts[parts.length - 1]?.toLowerCase();
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

export function createElementContentsRange(element: Element): Range | undefined {
    const doc = element.ownerDocument;
    const range = doc.createRange();
    try {
        range.selectNodeContents(element);
        if (normalizeText(range.toString())) return range;
    } catch (error) {
        logger(`[EpubVisualizer] Failed to create EPUB item range: ${error}`, 1);
    }
    range.detach();
    return undefined;
}

export function createSentenceRange(element: Element, sentenceText: string): Range | undefined {
    const normalizedSentence = normalizeText(sentenceText);
    if (!normalizedSentence) return undefined;

    const textNodes = collectTextNodes(element);
    const flattened = flattenTextNodes(textNodes);
    const offset = flattened.normalized.indexOf(normalizedSentence);
    if (offset === -1) return undefined;

    const start = flattened.positions[offset];
    const end = flattened.positions[offset + normalizedSentence.length - 1];
    if (!start || !end) return undefined;

    const range = element.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);
    return range;
}

function collectTextNodes(root: Element): Text[] {
    const doc = root.ownerDocument;
    const showText = doc.defaultView?.NodeFilter.SHOW_TEXT ?? NodeFilter.SHOW_TEXT;
    const walker = doc.createTreeWalker(root, showText);
    const nodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
        // Extraction skips non-content subtrees (style/script), so the live
        // text walk must skip them too or extracted sentence text will not
        // line up with the flattened live text.
        if (!(current as Text).parentElement?.closest(NON_CONTENT_SELECTOR)) {
            nodes.push(current as Text);
        }
        current = walker.nextNode();
    }
    return nodes;
}

interface FlattenedText {
    normalized: string;
    positions: Array<{ node: Text; offset: number }>;
}

function flattenTextNodes(nodes: Text[]): FlattenedText {
    let normalized = "";
    const positions: Array<{ node: Text; offset: number }> = [];
    let pendingSpace: { node: Text; offset: number } | undefined;

    for (const node of nodes) {
        const value = node.nodeValue ?? "";
        for (let offset = 0; offset < value.length; offset++) {
            const char = value[offset];
            if (/\s/.test(char)) {
                pendingSpace = { node, offset };
                continue;
            }

            if (pendingSpace && normalized.length > 0) {
                normalized += " ";
                positions.push(pendingSpace);
            }
            pendingSpace = undefined;
            normalized += char;
            positions.push({ node, offset });
        }
    }

    return { normalized: normalized.trim(), positions };
}
