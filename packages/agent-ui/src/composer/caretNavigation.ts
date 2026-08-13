/**
 * Which edge of a range selection an unmodified (non-extending) caret
 * navigation key collapses to: `true` for the range's document-order end,
 * `false` for its start.
 *
 * The mapping is purely logical - it is NOT mirrored for right-to-left text.
 * That matches the host engine's native text fields, where a physical arrow
 * key maps to a logical direction based on the writing mode only (vertical
 * writing modes swap left/right; bidi direction does not), and the resulting
 * collapse takes the anchor-focus range's start or end container directly.
 * Caret *movement* is bidi-aware (hence the visual 'left'/'right' granularity
 * used for the character and word steps), but the collapse deliberately is
 * not; keeping both halves aligned with the native fields is what makes the
 * editor feel consistent with the rest of the application.
 */
export function collapsesToRangeEnd(key: string): boolean {
    switch (key) {
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'Home':
        case 'PageUp':
            return false;
        default:
            return true;
    }
}
