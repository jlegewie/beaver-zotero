/**
 * Whether the user reads text in both directions: Zotero's own switch for
 * direction-aware item fields. Zotero turns it on when a right-to-left
 * language is picked in its preferences; it can also be enabled in the
 * Advanced preferences. With it on, Beaver directs every block of content,
 * left-to-right text included.
 */
export function directsAllText(): boolean {
    return Zotero.Prefs.get('bidi.browser.ui', true) === true;
}
