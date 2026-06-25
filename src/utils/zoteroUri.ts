/** Extract the item key from a Zotero item URI. */
export function extractItemKeyFromUri(uri: string): string | null {
    const match = uri.match(/\/items\/([A-Z0-9]+)$/i);
    return match ? match[1] : null;
}
