/**
 * Beaver provenance stamp in an item's Extra field (`Added by Beaver: <date>`).
 *
 * Esbuild-safe: no `react/*` imports, no bare `addon`.
 */

export const BEAVER_PROVENANCE_MARKER = 'Added by Beaver';

/**
 * Stamp Beaver provenance into an item's Extra field without saving it.
 */
export function stampBeaverProvenanceExtra(
    item: Zotero.Item,
    options: { reason?: string } = {},
): boolean {
    const currentExtra = (item.getField('extra') as string) || '';
    if (currentExtra.includes(BEAVER_PROVENANCE_MARKER)) {
        return false;
    }

    const addedDate = new Date().toISOString().slice(0, 10);
    const extraLines = [`${BEAVER_PROVENANCE_MARKER}: ${addedDate}`];
    if (options.reason && !currentExtra.includes(`Beaver Reason: ${options.reason}`)) {
        extraLines.push(`Beaver Reason: ${options.reason}`);
    }

    item.setField('extra', currentExtra ? `${currentExtra}\n${extraLines.join('\n')}` : extraLines.join('\n'));
    return true;
}
