/**
 * Headless port of the Zotero reader's *physical* EPUB page mapping
 * (`reader/src/dom/epub/lib/page-mapping.ts` → `_addPhysicalPages`).
 *
 * A well-produced EPUB carries the print edition's page boundaries as markers
 * (empty `<a id="page_9">` anchors, or `epub:type="pagebreak"` elements). The
 * reader detects them with three scored matchers and, when confident, labels an
 * annotation with the nearest preceding printed page. When no confident physical
 * mapping exists, the reader stores an empty page label (`epub-view.ts`:
 * `isPhysical && getPageLabel(range) || ''`) — it does NOT use synthetic
 * "Location N" labels for annotations, so this port only covers the physical path.
 *
 * Marker order is keyed by (section index, character offset from the section
 * root) — the same character scale used for the annotation's own offset — so
 * "nearest preceding marker" agrees with the reader's CFI ordering for the
 * text-separated page anchors these matchers target.
 */

import {
    EMPTY_PAGE_MAPPING,
    type PageMapping,
    type PageMarker,
} from "../dom/pagination";

export interface PageMappingSectionMarkers {
    sectionIndex: number;
    markersByMatcher: PageMarker[][];
}

interface Matcher {
    selector: string;
    extract: (el: Element) => string | undefined;
}

function extractFromId(el: Element): string | undefined {
    const id = el.getAttribute("id") ?? "";
    return id.replace(/page[-_]?/i, "").replace(/^(.*_)+/, "") || undefined;
}

// Mirrors reader/src/dom/epub/lib/page-mapping.ts MATCHERS (same order).
const MATCHERS: Matcher[] = [
    { selector: '[id*="page" i]:not(#pagetop):not(#pagebottom):empty', extract: extractFromId },
    { selector: '[id*="page" i]:not(#pagetop):not(#pagebottom)', extract: extractFromId },
    { selector: '[*|type="pagebreak"]', extract: (el) => el.getAttribute("title") ?? undefined },
];

/** Extract candidate page markers for one section using the reader's matchers. */
export function extractSectionPageMarkers(
    body: Element,
    sectionIndex: number,
    charOffsetForElement: (element: Element) => number,
): PageMappingSectionMarkers {
    const markersByMatcher = MATCHERS.map((matcher) => {
        let elems: Element[];
        try {
            elems = Array.from(body.querySelectorAll(matcher.selector)) as Element[];
        } catch {
            return [];
        }
        const markers: PageMarker[] = [];
        for (const el of elems) {
            const label = matcher.extract(el);
            if (!label) continue;
            markers.push({
                sectionIndex,
                charOffset: charOffsetForElement(el),
                label,
            });
        }
        return markers;
    });
    return { sectionIndex, markersByMatcher };
}

/**
 * Score already-collected page markers exactly as the reader does, keeping the
 * highest-count non-aborted matcher.
 */
export function scorePageMarkers(
    sections: PageMappingSectionMarkers[],
    totalSpineCount: number,
): PageMapping {
    const denominator = Math.max(totalSpineCount, sections.length, 1);
    let best: PageMarker[] | null = null;

    for (let matcherIndex = 0; matcherIndex < MATCHERS.length; matcherIndex++) {
        const markers: PageMarker[] = [];
        let score = 0;
        let sectionsWithMatches = 0;

        for (const section of sections) {
            const sectionMarkers = section.markersByMatcher[matcherIndex] ?? [];
            markers.push(...sectionMarkers);
            const successes = sectionMarkers.length;
            if (successes) {
                score += successes;
                sectionsWithMatches++;
            }
        }

        // Too few sections carry page numbers — not a trustworthy mapping.
        if (sectionsWithMatches < denominator / 2) continue;

        markers.sort((a, b) => a.sectionIndex - b.sectionIndex || a.charOffset - b.charOffset);

        // Dock for decreasing or page-skipping sequences.
        let previous: string | null = null;
        for (const { label } of markers) {
            if (previous !== null) {
                const prevInt = parseInt(previous, 10);
                const thisInt = parseInt(label, 10);
                if (!Number.isNaN(prevInt) && !Number.isNaN(thisInt)) {
                    if (thisInt < prevInt) { score /= 4; break; }
                    if (thisInt > prevInt + 3) { score /= 2; break; }
                }
            }
            previous = label;
        }

        // Duplicate handling: non-numeric duplicates abort; numeric ones dock.
        let aborted = false;
        const seen = new Set<string>();
        for (const { label } of markers) {
            if (seen.has(label)) {
                if (/^\D{2,}$/.test(label)) { aborted = true; break; }
                score /= 2;
                break;
            }
            seen.add(label);
        }
        if (aborted || score <= 0) continue;

        // The reader keeps the matcher with the most matches among the survivors.
        if (!best || markers.length > best.length) {
            best = markers;
        }
    }

    if (!best) return EMPTY_PAGE_MAPPING;
    return { isPhysical: true, markers: best };
}

/**
 * The page label for a position, mirroring the reader's `getPageLabel`
 * (nearest marker at-or-before the position). Returns '' when the mapping is not
 * physical or no marker precedes the position — matching the reader's stored
 * annotation page label for EPUBs without confident physical paging.
 */
export function epubPageLabelForPosition(
    mapping: PageMapping,
    sectionIndex: number,
    charOffset: number,
): string {
    if (!mapping.isPhysical) return "";
    let label = "";
    for (const marker of mapping.markers) {
        const atOrBefore =
            marker.sectionIndex < sectionIndex
            || (marker.sectionIndex === sectionIndex && marker.charOffset <= charOffset);
        if (atOrBefore) {
            label = marker.label;
        } else {
            break; // markers are sorted ascending; the rest are past the position
        }
    }
    return label;
}
