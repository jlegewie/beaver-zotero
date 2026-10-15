import type { PageLabels } from '../services/documentCache';
import { logger } from '@beaver/agent-core/platform/logger';

/**
 * Translate a page number string (1-based, as humans see it) to its display
 * label against an explicit page-label map (0-based index -> label string).
 *
 * Only translates strings that are purely numeric page references (digits with
 * optional whitespace/range separators like "-", "–", ","). Non-page locators
 * such as "§3.2", "fn. 5", or "xii" are returned unchanged.
 */
export function translatePageNumberToLabel(
    pageLabels: PageLabels | null | undefined,
    pageStr: string,
): string {
    if (!pageLabels || Object.keys(pageLabels).length === 0) return pageStr;
    if (!/^\s*\d[\d\s,\-–]*$/.test(pageStr)) return pageStr;
    return pageStr.replace(/\d+/g, (numStr) => {
        const pageIndex = parseInt(numStr, 10) - 1;
        if (isNaN(pageIndex) || pageIndex < 0) return numStr;
        return pageLabels[pageIndex] ?? numStr;
    });
}

/**
 * The page locator a native note citation stores for physical `pages` ("5",
 * "5-7", "2, 9"): the cited pages in Zotero locator labels.
 *
 * In a document with labels, a page without one (an unnumbered title page
 * before the numbering starts) is left out: it prints no number to cite, and
 * its physical number may be another page's label, so Zotero would open that
 * page. A range keeps its labelled pages ("1-3" with page 1 unlabelled reads
 * "<label of 2>-<label of 3>"). When no cited page has a label the citation
 * gets no locator (undefined); Beaver's metadata still records the physical
 * page. Without labels, or for a locator that is not a physical page
 * reference, `pages` is returned as written.
 */
export function citationPageLocator(
    pageLabels: PageLabels | Record<number, string> | null | undefined,
    pages: string,
): string | undefined {
    const normalized = normalizePageRange(pages);
    // 1-based pages that carry a label, ascending. Ranges are matched against
    // these rather than enumerated, so any page number or range length is safe.
    const labelled = Object.entries((pageLabels ?? {}) as Record<string, string>)
        .filter(([index, label]) => /^\d+$/.test(index) && typeof label === 'string' && label.trim() !== '')
        .map(([index]) => Number(index) + 1)
        .sort((a, b) => a - b);
    if (labelled.length === 0 || !/^\d+(?:\s*[-,]\s*\d+)*$/.test(normalized)) return normalized || undefined;

    const labelOf = (page: number): string => (pageLabels as Record<number, string>)[page - 1];
    const parts: string[] = [];
    for (const part of normalized.split(',')) {
        const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
        if (!match) continue;
        const start = Math.min(Number(match[1]), Number(match[2] ?? match[1]));
        const end = Math.max(Number(match[1]), Number(match[2] ?? match[1]));
        const inRange = labelled.filter((page) => page >= start && page <= end);
        if (inRange.length === 0) continue;
        const first = labelOf(inRange[0]);
        const last = labelOf(inRange[inRange.length - 1]);
        parts.push(first === last ? first : `${first}-${last}`);
    }
    return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * Length of the run of consecutive Arabic labels that page `index` belongs to.
 */
function arabicRunLength(labels: PageLabels, index: number): number {
    const value = (i: number): number | null => {
        const label = labels[i];
        return label != null && /^\d+$/.test(label) ? Number(label) : null;
    };
    if (value(index) === null) return 0;
    let start = index;
    while (value(start - 1) !== null && value(start - 1)! + 1 === value(start)) start--;
    let end = index;
    while (value(end + 1) !== null && value(end)! + 1 === value(end + 1)) end++;
    return end - start + 1;
}

/**
 * 1-based page whose label is `target`, or null. When several pages carry the
 * label, the one in the longest Arabic run (the main body) wins, so a cover or
 * front-matter page that repeats a body number does not capture it.
 */
export function findLabelledPage(labels: PageLabels | null | undefined, target: string): number | null {
    if (!labels || target === '') return null;
    const matches = Object.entries(labels)
        .filter(([, label]) => label === target)
        .map(([idx]) => Number(idx))
        .filter((idx) => Number.isInteger(idx) && idx >= 0)
        .sort((a, b) => a - b);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0] + 1;
    let best = matches[0];
    let bestRun = arabicRunLength(labels, best);
    for (const idx of matches.slice(1)) {
        const run = arabicRunLength(labels, idx);
        if (run > bestRun) {
            best = idx;
            bestRun = run;
        }
    }
    logger(`findLabelledPage: page label '${target}' is on ${matches.length} pages; using page ${best + 1}`, 2);
    return best + 1;
}

/**
 * Label maps a stored note-citation locator is read back through, for one
 * attachment. Beaver records the physical page of every citation it writes
 * now (`beaver.loc`, or the page a link opens), so these maps only matter for
 * locators without that record:
 *
 * - `declared`: the PDF's own labels. Native citations without Beaver's
 *   metadata (written by older Beaver versions, or by Zotero) have always been
 *   read in them, and still are, so existing notes read back unchanged. The
 *   exception is a citation Zotero wrote beside an annotation in the same
 *   note, which reads as that annotation's page (see `noteHtmlSimplifier`).
 * - `locator`: Zotero locator labels (`resolveZoteroLocatorPageLabels`), which
 *   current Beaver writes into the suffix of a link citation that opens its
 *   page.
 *
 * A plain map stands for both, as when the two agree.
 */
export type StoredLocatorPageLabels =
    | PageLabels
    | { declared: PageLabels | null; locator: PageLabels | null };

function isLabelPair(
    labels: StoredLocatorPageLabels,
): labels is { declared: PageLabels | null; locator: PageLabels | null } {
    return 'declared' in labels && 'locator' in labels
        && (labels.declared === null || typeof labels.declared === 'object')
        && (labels.locator === null || typeof labels.locator === 'object');
}

/** The declared labels of a read-back map (see `StoredLocatorPageLabels`). */
export function declaredReadbackLabels(labels: StoredLocatorPageLabels | null | undefined): PageLabels | null {
    if (!labels) return null;
    return isLabelPair(labels) ? labels.declared : labels;
}

/** The Zotero locator labels of a read-back map (see `StoredLocatorPageLabels`). */
export function locatorReadbackLabels(labels: StoredLocatorPageLabels | null | undefined): PageLabels | null {
    if (!labels) return null;
    return isLabelPair(labels) ? labels.locator : labels;
}

/**
 * Translate stored page labels back to 1-based physical page numbers, or null
 * when the map does not resolve every label in the locator.
 *
 * Whole-string labels are mapped directly. Ranges and comma-separated lists
 * are translated token-by-token. A label on several pages resolves to the
 * main-body page (`findLabelledPage`).
 *
 * With `physicalFallback`, a number that is no label in the map reads as that
 * physical page when the map has no label for it: the writers keep the
 * physical number for unlabelled pages (`translatePageNumberToLabel`,
 * `formatCitationPages`), so a range may mix the two ("1-1202").
 */
export function tryTranslatePageLabelToNumber(
    pageLabels: PageLabels | null | undefined,
    locStr: string,
    { physicalFallback = false }: { physicalFallback?: boolean } = {},
): string | null {
    if (!pageLabels || Object.keys(pageLabels).length === 0) return null;

    const lookup = (label: string): string | undefined => {
        const page = findLabelledPage(pageLabels, label);
        if (page !== null) return String(page);
        if (!physicalFallback || !/^\d+$/.test(label)) return undefined;
        const physical = Number(label);
        return physical > 0 && !pageLabels[physical - 1]?.trim() ? String(physical) : undefined;
    };

    const whole = lookup(locStr);
    if (whole) return whole;

    const parts = locStr.split(/([-–,])/);
    const translatedParts: string[] = [];
    let translatedAny = false;

    for (const part of parts) {
        if (/^[-–,]$/.test(part)) {
            translatedParts.push(part);
            continue;
        }
        const leading = part.match(/^\s*/)?.[0] ?? '';
        const trailing = part.match(/\s*$/)?.[0] ?? '';
        const token = part.trim();
        if (!token) {
            translatedParts.push(part);
            continue;
        }
        const translated = lookup(token);
        if (!translated) return null;
        translatedAny = true;
        translatedParts.push(`${leading}${translated}${trailing}`);
    }

    return translatedAny ? translatedParts.join('') : null;
}

/**
 * Translate stored page labels back to 1-based physical page numbers
 * (`tryTranslatePageLabelToNumber`): in labels alone, else with physical
 * numbers on unlabelled pages, else the locator unchanged.
 */
export function translatePageLabelToNumber(
    pageLabels: PageLabels | null | undefined,
    locStr: string,
): string {
    return tryTranslatePageLabelToNumber(pageLabels, locStr)
        ?? tryTranslatePageLabelToNumber(pageLabels, locStr, { physicalFallback: true })
        ?? locStr;
}

/**
 * Translate a link citation's stored page suffix back to physical pages.
 *
 * A link that opens a page (`linkPage`, the first page it cites) tells the
 * convention its suffix was written in: current Beaver writes Zotero locator
 * labels, older versions the declared ones. Only a map that resolves the
 * whole suffix and puts its first page there is accepted, trying labels alone
 * before physical numbers on unlabelled pages; a suffix that is already that
 * physical page is kept.
 *
 * A link without a page (`zotero://select`, for an attachment whose file is
 * missing) has its suffix written in declared labels
 * (`linkCitationPageLabelNamespace`), so it is read in them, then as a
 * physical page.
 */
export function translateLinkPageLabelToNumber(
    pageLabels: StoredLocatorPageLabels | null | undefined,
    locStr: string,
    linkPage: number | null,
): string {
    const declared = declaredReadbackLabels(pageLabels);
    const locator = locatorReadbackLabels(pageLabels);
    if (linkPage) {
        for (const physicalFallback of [false, true]) {
            for (const labels of [locator, declared]) {
                const translated = tryTranslatePageLabelToNumber(labels, locStr, { physicalFallback });
                if (translated !== null && firstPageNumber(translated) === linkPage) return translated;
            }
        }
        if (firstPageNumber(locStr) === linkPage) return locStr;
    }
    return translatePageLabelToNumber(declared, locStr);
}

/**
 * A page locator as a note citation stores it: trimmed, with dashes written
 * as hyphens (`100–105` → `100-105`). Citation styles format page ranges
 * written with a hyphen (`100-5`, `100–105`), so a stored en dash would print
 * as written while other ranges are styled.
 */
export function normalizePageRange(page: string): string {
    return page.trim().replace(/[\u2012-\u2015\u2212]/g, '-');
}

/**
 * First physical 1-based page in a page locator ("12", "12-15", "3, 7"), or
 * undefined when the locator is not a physical page number ("xii", "§3.2").
 *
 * Reader navigation addresses pages by position, so a display label has to be
 * translated back with `translatePageLabelToNumber` before it lands here.
 */
export function firstPageNumber(pageStr: string | null | undefined): number | undefined {
    const match = pageStr?.match(/^\s*(\d+)/);
    if (!match) return undefined;
    const page = parseInt(match[1], 10);
    return page > 0 ? page : undefined;
}

/** Format distinct physical pages as compact ranges, using display labels when available. */
export function formatCitationPages(
    pages: number[],
    labels?: PageLabels | null,
    { inclusiveRange = false }: { inclusiveRange?: boolean } = {},
): string | undefined {
    const sorted = [...new Set(pages.filter(page => Number.isInteger(page) && page > 0))].sort((a, b) => a - b);
    const ranges: string[] = [];
    const label = (page: number) => labels?.[page - 1]?.trim() || String(page);
    // Structural spans may supply only endpoint pages, with interior pages omitted.
    if (inclusiveRange && sorted.length > 1) {
        return `${label(sorted[0])}-${label(sorted[sorted.length - 1])}`;
    }
    for (let i = 0; i < sorted.length; i++) {
        const start = sorted[i];
        let end = start;
        while (sorted[i + 1] === end + 1) end = sorted[++i];
        ranges.push(start === end ? label(start) : `${label(start)}-${label(end)}`);
    }
    return ranges.length ? ranges.join(', ') : undefined;
}
