import type { PageLabels } from '../services/documentCache';

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
