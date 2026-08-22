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
 * creator string, and on `item.getDisplayTitle()` for the fallback, which is
 * why the label cannot be reconstructed faithfully from a serialized
 * `creators[]` array and a `title` field elsewhere.
 */

/** Note titles are truncated to this many characters by default. */
export const MAX_NOTE_TITLE_LENGTH = 20;

function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
}

/** Unicode directional isolates: FSI, LRI, RLI, PDI. */
const BIDI_ISOLATES = /[⁦-⁩]/g;

/**
 * Remove the Unicode directional isolates Zotero wraps around creator names.
 *
 * `item.firstCreator` wraps each name of a two-creator item in U+2068/U+2069
 * so the joiner renders correctly in mixed-direction text. Invisible in a
 * rendered label, but they corrupt anything that compares, hashes, or sends
 * the string.
 */
export function stripBidiIsolates(text: string): string {
    return text.replace(BIDI_ISOLATES, '');
}

/**
 * Zotero's own title for an item.
 *
 * `getDisplayTitle()` is the base-mapped `title` field, which is the only way
 * to reach the types that store their title elsewhere — a statute's
 * `nameOfAct`, an email's `subject`, a case's `caseName`. A plain
 * `getField('title')` returns nothing for those, which is how they ended up
 * labelled "Unknown Author". It also supplies the titles Zotero generates for
 * letters, interviews and civil-law cases that have none of their own.
 *
 * Falls back to the base-mapped field directly, since a caller may hand us an
 * item-like object without the method.
 */
function displayTitle(item: Zotero.Item): string {
    try {
        return item.getDisplayTitle?.() || item.getField('title', false, true) || '';
    } catch {
        return '';
    }
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
        const firstCreator = stripBidiIsolates(item.firstCreator || '') || displayTitle(item) || 'Unknown Author';
        // Base-mapped for the same reason as the title: a case dates from
        // `dateDecided`, a patent from `issueDate`, a statute from
        // `dateEnacted`, and a plain `date` read finds none of them.
        const year = item.getField('date', false, true)?.match(/\d{4}/)?.[0] || '';
        displayName = `${firstCreator}${year ? ` ${year}` : ''}`;
    }

    if (count && count > 1) displayName = `${displayName} (${count})`;
    return displayName;
}

/**
 * Whether {@link getItemDisplayName} falls back to the item's title because it
 * has no creator to name it by.
 *
 * The pairing invariant for `getItemDescription`: a description sitting under
 * such a display name must not open with the title it already shows. Exported
 * so that rule lives next to the branch it depends on — a change to the
 * fallback above has to be reflected here.
 */
export function displayNameUsesTitle(item: Zotero.Item): boolean {
    if (item.isNote() || item.isAnnotation() || item.isAttachment()) return false;
    try {
        // Both halves matter. An item with no creator *and* no title of any
        // kind is labelled "Unknown Author", and reporting "the title is
        // already shown" for it would drop the title from the description too,
        // leaving nothing to identify the item on either line.
        return !item.firstCreator && !!displayTitle(item);
    } catch {
        return false;
    }
}
