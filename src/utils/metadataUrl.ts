/** Remove control-character corruption without changing valid URL text. */
export function cleanMetadataUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const cleaned = value
        .replace(/\\u00(?:[01][0-9a-f]|7f)/gi, '')
        .replace(/\p{Cc}/gu, '')
        .trim();
    return cleaned || null;
}
