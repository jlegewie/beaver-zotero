import type { DomItem } from "./schema";
import type { DomItemCandidate } from "./domWalk";

/**
 * Generic DOM pagination machinery shared by EPUB and web-snapshot extraction.
 *
 * Page coordinates are bimodal: physical publisher markers (EPUB-only, see
 * `epub/epubPageMapping.ts`) when a book carries them, otherwise synthetic pages
 * cut at a fixed character cadence over the section's content text. Snapshots
 * have no publisher markers, so they always use the synthetic path here.
 *
 * Marker order is keyed by (section index, character offset from the section
 * root) on the same filtered character scale used by extracted item offsets, so
 * "nearest preceding marker" lookups stay consistent across items and markers.
 */

export interface PageMarker {
    /** Section index the marker is in. */
    sectionIndex: number;
    /** Character count from the section root to the marker. */
    charOffset: number;
    label: string;
}

export interface PageMapping {
    isPhysical: boolean;
    /** Markers sorted ascending by (sectionIndex, charOffset). Empty when not physical. */
    markers: PageMarker[];
}

export const EMPTY_PAGE_MAPPING: PageMapping = { isPhysical: false, markers: [] };

/**
 * Return the 1-based ordinal of the nearest page marker at or before a position.
 * Content before the first marker maps to page 1.
 */
export function pageOrdinalForPosition(
    mapping: PageMapping,
    sectionIndex: number,
    charOffset: number,
): number {
    let ordinal = 0;
    for (const marker of mapping.markers) {
        const atOrBefore =
            marker.sectionIndex < sectionIndex
            || (marker.sectionIndex === sectionIndex && marker.charOffset <= charOffset);
        if (atOrBefore) {
            ordinal++;
        } else {
            break; // markers are sorted ascending; the rest are past the position
        }
    }
    return ordinal === 0 ? 1 : ordinal;
}

/** One content text node positioned on a section's character scale. */
export interface SectionTextNode {
    /** Cumulative character offset of the node's first character. */
    start: number;
    /** Character length of the node. */
    length: number;
}

/**
 * Append synthetic page markers for one section.
 *
 * The input nodes must use the same filtered character scale as extracted item
 * offsets. Markers are appended in global order, and each section starts with a
 * fresh break budget.
 */
export function appendSyntheticSectionMarkers(
    nodes: SectionTextNode[],
    sectionIndex: number,
    interval: number,
    out: PageMarker[],
): void {
    let remainingBeforeBreak = 0;
    for (const { start, length } of nodes) {
        let offsetInNode = 0;
        let remaining = length;
        if (remaining <= remainingBeforeBreak) {
            remainingBeforeBreak -= remaining;
            continue;
        }
        while (remaining > remainingBeforeBreak) {
            offsetInNode += remainingBeforeBreak;
            remaining -= remainingBeforeBreak;
            out.push({ sectionIndex, charOffset: start + offsetInNode, label: String(out.length + 1) });
            remainingBeforeBreak = interval;
        }
        // Keep the post-break remainder out of the next interval.
    }
}

/**
 * Character-offset scale used by extracted items and page markers within one
 * section.
 *
 * Whitespace-only text nodes and `<style>`/`<script>` subtrees are skipped, while
 * content text lengths remain unnormalized. Keeping all offsets on one scale lets
 * item offsets, physical markers, and synthetic markers compare consistently.
 */
export interface ContentOffsetIndex {
    elementOffsets: Map<Element, number>;
    textNodeOffsets: Map<Text, number>;
    /** Content text nodes on the same character scale as item offsets. */
    contentNodes: SectionTextNode[];
}

export function emptyContentOffsetIndex(): ContentOffsetIndex {
    return { elementOffsets: new Map(), textNodeOffsets: new Map(), contentNodes: [] };
}

/** Build the per-section content character-offset scale in DOM order. */
export function buildContentOffsetIndex(root: Element): ContentOffsetIndex {
    const elementOffsets = new Map<Element, number>();
    const textNodeOffsets = new Map<Text, number>();
    const contentNodes: SectionTextNode[] = [];
    let offset = 0;

    const visitElement = (element: Element): void => {
        const tag = element.localName?.toLowerCase();
        if (tag === "style" || tag === "script") return;
        elementOffsets.set(element, offset);
        for (const node of Array.from(element.childNodes)) {
            if (!node) continue;
            if (node.nodeType === 3) {
                const value = (node as Text).nodeValue ?? "";
                if (/^\s*$/.test(value)) continue;
                textNodeOffsets.set(node as Text, offset);
                contentNodes.push({ start: offset, length: value.length });
                offset += value.length;
            } else if (node.nodeType === 1) {
                visitElement(node as Element);
            }
        }
    };

    visitElement(root);
    return { elementOffsets, textNodeOffsets, contentNodes };
}

/** Character offset of an extracted item, preferring its first text node. */
export function itemCharOffset(candidate: DomItemCandidate, offsets: ContentOffsetIndex): number {
    if (candidate.firstTextNode) {
        const textOffset = offsets.textNodeOffsets.get(candidate.firstTextNode);
        if (textOffset !== undefined) return textOffset;
    }
    return offsets.elementOffsets.get(candidate.element) ?? 0;
}

/** An extracted item plus its position on the document's character scale. */
export interface ItemPagePosition {
    item: DomItem;
    sectionIndex: number;
    charOffset: number;
}

/**
 * Assign each item the ordinal of its nearest preceding synthetic marker and
 * return the max page number (the document's synthetic page count).
 */
export function stampSyntheticPageNumbers(
    itemPositions: ItemPagePosition[],
    syntheticMarkers: PageMarker[],
): number {
    const mapping: PageMapping = { isPhysical: true, markers: syntheticMarkers };
    let maxPage = 1;
    for (const { item, sectionIndex, charOffset } of itemPositions) {
        const page = pageOrdinalForPosition(mapping, sectionIndex, charOffset);
        item.pageNumber = page;
        if (page > maxPage) maxPage = page;
    }
    return maxPage;
}
