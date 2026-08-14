/**
 * The canonical short label for a Zotero item ("Legewie and DiPrete 2014").
 *
 * This is what Beaver puts on source chips, tool-call headers and quick-search
 * rows, so it lives here — React-free — rather than in the React bundle: the
 * agent data provider serves it to clients that have no local Zotero (the Word
 * add-in) and must not compute their own, or the same item ends up with two
 * different names across surfaces.
 *
 * It builds on `item.firstCreator`, Zotero's own localized, et-al-aware
 * creator string, which is why the label cannot be reconstructed faithfully
 * from a serialized `creators[]` array elsewhere.
 */

/** Note titles are truncated to this many characters by default. */
export const MAX_NOTE_TITLE_LENGTH = 20;

function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
}

/**
 * Short display label for an item.
 *
 * @param item - The item to label.
 * @param count - When above 1, appended as "(n)" to mark a grouped selection.
 * @param noteTitleLength - Truncation length for note titles.
 */
export function getItemDisplayName(
    item: Zotero.Item,
    count: number | null = null,
    noteTitleLength: number = MAX_NOTE_TITLE_LENGTH
): string {
    let displayName: string;

    if (item.isNote()) {
        displayName = truncate(item.getNoteTitle(), noteTitleLength) || 'Untitled Note';
    } else if (item.isAnnotation()) {
        // An annotation has neither creators nor a title, so without this it
        // falls through to the creator branch and is labelled "Unknown Author".
        // `getDisplayTitle` is Zotero's own summary of the highlighted text.
        displayName = truncate(item.getDisplayTitle() || '', noteTitleLength) || 'Annotation';
    } else if (item.isAttachment() && !item.parentItem) {
        displayName = item.getField('title') || '';
    } else {
        const firstCreator = item.firstCreator || item.getField('title') || 'Unknown Author';
        const year = item.getField('date')?.match(/\d{4}/)?.[0] || '';
        displayName = `${firstCreator}${year ? ` ${year}` : ''}`;
    }

    if (count && count > 1) displayName = `${displayName} (${count})`;
    return displayName;
}
