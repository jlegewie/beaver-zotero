/** Inclusive publication-year matching; unknown years never satisfy a bound. */
export function matchesPublicationYear(
    date: unknown,
    min?: number | null,
    max?: number | null,
): boolean {
    if (min == null && max == null) return true;
    const match = String(date ?? '').match(/\b(\d{4})\b/);
    const year = match ? Number(match[1]) : 0;
    return (
        year > 0 && (min == null || year >= min) && (max == null || year <= max)
    );
}

/** Match name tokens within one creator, including institutional creators. */
export function matchesCreatorName(
    creators: { firstName?: string; lastName?: string; name?: string }[],
    query: string,
): boolean {
    const tokens = query
        .toLowerCase()
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean);
    return (
        tokens.length > 0 &&
        creators.some((creator) => {
            const name =
                `${creator.firstName ?? ''} ${creator.lastName ?? creator.name ?? ''}`.toLowerCase();
            return tokens.every((token) => name.includes(token));
        })
    );
}
