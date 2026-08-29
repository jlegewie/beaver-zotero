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

/** Client rect of a DOM selection's moving edge (its focus point). A collapsed
 *  range has no client rect at some node boundaries, so widen it by one
 *  character before falling back to the containing element's box. */
export function getFocusRect(sel: Selection): DOMRect | null {
    const node = sel.focusNode;
    const doc = node?.ownerDocument;
    if (!node || !doc) return null;
    const offset = sel.focusOffset;
    const range = doc.createRange();
    try {
        range.setStart(node, offset);
        range.setEnd(node, offset);
    } catch {
        return null;
    }
    let rect: DOMRect | null = range.getClientRects?.()?.[0] ?? null;
    if (!rect && node.nodeType === Node.TEXT_NODE) {
        const length = (node as Text).length;
        try {
            if (offset < length) range.setEnd(node, offset + 1);
            else if (offset > 0) range.setStart(node, offset - 1);
            rect = range.getClientRects?.()?.[0] ?? null;
        } catch { /* the offsets may not be addressable */ }
    }
    if (!rect) {
        const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
        rect = el?.getBoundingClientRect() ?? null;
    }
    return rect;
}

/** Client rect of the caret inside `root`, or null when the document's
 *  selection is somewhere else entirely (another editor, another element). */
export function getCaretRectWithin(root: HTMLElement): DOMRect | null {
    const sel = root.ownerDocument.defaultView?.getSelection();
    if (!sel || !sel.focusNode || !root.contains(sel.focusNode)) return null;
    return getFocusRect(sel);
}
