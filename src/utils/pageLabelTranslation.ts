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

/**
 * Translate stored page labels back to 1-based physical page numbers.
 *
 * Whole-string labels are mapped directly. Ranges and comma-separated lists are
 * translated token-by-token, leaving unknown labels untouched. Duplicate labels
 * resolve to their first physical page.
 */
export function translatePageLabelToNumber(
    pageLabels: PageLabels | null | undefined,
    locStr: string,
): string {
    if (!pageLabels || Object.keys(pageLabels).length === 0) return locStr;

    const reverse = new Map<string, string>();
    for (const [indexStr, label] of Object.entries(pageLabels)) {
        if (label == null || label === '' || reverse.has(label)) continue;
        const index = Number(indexStr);
        if (!Number.isInteger(index) || index < 0) continue;
        reverse.set(label, String(index + 1));
    }
    if (reverse.size === 0) return locStr;

    const whole = reverse.get(locStr);
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
        const translated = reverse.get(token);
        if (!translated) return locStr;
        translatedAny = true;
        translatedParts.push(`${leading}${translated}${trailing}`);
    }

    return translatedAny ? translatedParts.join('') : locStr;
}
