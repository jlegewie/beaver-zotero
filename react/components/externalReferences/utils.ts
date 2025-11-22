
/*
 * Format authors for display.
 * @param authors - Array of author names.
 * @returns Formatted author string.
*/
export const formatAuthors = (authors?: string[]): string => {
    if (!authors || authors.length === 0) return '';

    const clean = authors.filter(Boolean).map(a => a.trim());

    if (clean.length === 0) return '';

    if (clean.length > 3) {
        return `${clean[0]} et al.`;
    }

    if (clean.length === 1) {
        return clean[0];
    }

    if (clean.length === 2) {
        return `${clean[0]} and ${clean[1]}`;
    }

    // exactly 3
    return `${clean[0]}, ${clean[1]} and ${clean[2]}`;
}