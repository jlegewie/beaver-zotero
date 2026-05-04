// function to truncate text to a max length
export const truncateText = (text: string, maxLength: number) => {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
}


export function formatNumberRanges(numbers: number[], separator: string = ", "): string {
    if (numbers.length === 0) return "";

    // Sort and remove duplicates just in case
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);

    const parts: string[] = [];
    let start = sorted[0];
    let prev = sorted[0];

    for (let i = 1; i <= sorted.length; i++) {
        const current = sorted[i];
        if (current === prev + 1) {
            // Still in a range, keep going
            prev = current;
        } else {
            // End of a range
            if (start === prev) {
                parts.push(`${start}`);
            } else {
                parts.push(`${start}-${prev}`);
            }
            // Start a new range
            start = current;
            prev = current;
        }
    }

    return parts.join(separator);
}

/**
 * Format a list of page numbers using their display labels, while still
 * collapsing consecutive page numbers into ranges (e.g., pages [1,2,3,5] with
 * labels ['i','ii','iii','v'] → "i-iii, v").
 *
 * Range detection runs on the underlying numeric pages; the resulting range
 * boundaries are rendered using the corresponding labels. A range is split
 * when adjacent labels appear to belong to different numbering schemes (e.g.,
 * Roman front matter "xiii,xiv" followed by Arabic body "1,2") to avoid
 * misleading output like "xiii-2".
 */
export function formatPageRangesWithLabels(
    pages: number[],
    labels: string[],
    separator: string = ", "
): string {
    if (pages.length === 0) return "";

    const pairs = pages
        .map((page, i) => ({ page, label: labels[i] ?? String(page) }))
        .sort((a, b) => a.page - b.page);

    // De-duplicate by page number, keeping the first label seen.
    const dedup: { page: number; label: string }[] = [];
    for (const pair of pairs) {
        if (dedup.length === 0 || dedup[dedup.length - 1].page !== pair.page) {
            dedup.push(pair);
        }
    }

    // Coarse numbering-scheme bucket: labels that are pure digits (Arabic page
    // numbers) shouldn't merge into a range with non-digit labels (Roman
    // numerals, "A-1", "fn. 5", etc.). Same-scheme adjacency is preserved.
    const labelKind = (label: string): 'digit' | 'other' =>
        /^\d+$/.test(label) ? 'digit' : 'other';

    const parts: string[] = [];
    let startIdx = 0;
    for (let i = 1; i <= dedup.length; i++) {
        const continues =
            i < dedup.length &&
            dedup[i].page === dedup[i - 1].page + 1 &&
            labelKind(dedup[i].label) === labelKind(dedup[i - 1].label);
        if (continues) continue;

        const startLabel = dedup[startIdx].label;
        const endLabel = dedup[i - 1].label;
        parts.push(startIdx === i - 1 || startLabel === endLabel
            ? startLabel
            : `${startLabel}-${endLabel}`);
        startIdx = i;
    }

    return parts.join(separator);
}
