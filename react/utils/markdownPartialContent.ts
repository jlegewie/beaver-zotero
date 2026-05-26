/**
 * Remove or complete incomplete markdown fragments that commonly appear while
 * model text is still streaming.
 */
export function processPartialContent(content: string, exportRendering: boolean): string {
    let processed = content;

    processed = exportRendering
        ? processed.normalize("NFC").replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
        : processed.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');

    const boldMarkers = (processed.match(/\*\*/g) || []).length;
    if (boldMarkers % 2 === 1 && !processed.endsWith('**')) {
        processed = processed + '**';
    }

    processed = processed.replace(/`(<citation[^>]*\/?>)`/g, '$1');
    processed = stripPartialTrailingTag(processed);
    processed = stripUnclosedDisplayMath(processed);

    return processed;
}

function stripPartialTrailingTag(content: string): string {
    const partialTagPatterns = [
        /<citation[^>]*$/,
        /<note[^>]*$/,
        /<\/note$/,
        /<[a-z][a-z0-9]*(?:\s+[^>]*)?$/i,
    ];

    for (const pattern of partialTagPatterns) {
        const match = content.match(pattern);
        if (match && match.index !== undefined && match.index + match[0].length === content.length) {
            return content.substring(0, match.index);
        }
    }

    return content;
}

function stripUnclosedDisplayMath(content: string): string {
    const delimiterMatches = Array.from(content.matchAll(/\$\$/g));
    if (delimiterMatches.length % 2 === 0) return content;

    const lastDelimiter = delimiterMatches[delimiterMatches.length - 1];
    if (lastDelimiter.index === undefined) return content;

    return content.substring(0, lastDelimiter.index);
}
