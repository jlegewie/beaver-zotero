/**
 * Boundary strippers for edit-note `old_string` / `new_string` normalization.
 *
 * These helpers are strategy internals for `editNoteMatcher`'s
 * `partial_element_strip` and `spurious_wrap_strip` fallbacks, split into their
 * own module so both production code and tests can reference them through a
 * stable import path.
 */

// =============================================================================
// Partial Simplified Element Stripping
// =============================================================================

/** Names of simplified-only elements (tags that don't exist in raw HTML). */
const SIMPLIFIED_ELEMENT_NAMES = /^\/?(citation|annotation-image|annotation|image)\b/;

export interface PartialElementStrip {
    /** old_string with partial element boundary fragments removed */
    strippedOld: string;
    /** new_string with corresponding fragments removed */
    strippedNew: string;
    /** Number of characters stripped from the start of old_string */
    leadingStrip: number;
    /** Number of characters stripped from the end of old_string */
    trailingStrip: number;
}

/**
 * Detect and strip partial simplified-only element fragments at the boundaries
 * of old_string/new_string.
 *
 * When a model crafts old_string from simplified note HTML, it may include a
 * fragment of a simplified element tag at the boundary — e.g. `/>—ein` where
 * `/>` is the tail of a `<citation …/>`. Such fragments don't expand back to
 * raw HTML correctly because `expandToRawHtml` only handles complete tags.
 *
 * This function detects leading/trailing fragments of simplified-only elements
 * (citation, annotation, annotation-image, image) and strips them from both
 * old_string and new_string so the remaining text can be matched in raw HTML.
 *
 * @param oldString   The old_string from the edit request
 * @param newString   The new_string from the edit request
 * @param simplified  The full simplified note HTML
 * @param simplifiedPos  Position of oldString in simplified (from indexOf)
 * @returns Stripped strings and strip offsets, or null if no stripping needed
 */
export function stripPartialSimplifiedElements(
    oldString: string,
    newString: string,
    simplified: string,
    simplifiedPos: number,
): PartialElementStrip | null {
    const matchStart = simplifiedPos;
    const matchEnd = simplifiedPos + oldString.length;
    let leadingStrip = 0;
    let trailingStrip = 0;

    // --- Leading partial element ---
    // Check if matchStart falls inside a simplified-only element tag.
    // Scan backward for an unmatched '<' (one not closed by '>' before matchStart).
    if (matchStart > 0) {
        let openPos = -1;
        for (let i = matchStart - 1; i >= Math.max(0, matchStart - 1500); i--) {
            if (simplified[i] === '>') break;       // Found a close before any open
            if (simplified[i] === '<') { openPos = i; break; }
        }
        if (openPos !== -1) {
            const tagContent = simplified.substring(
                openPos + 1,
                Math.min(openPos + 30, simplified.length),
            );
            if (SIMPLIFIED_ELEMENT_NAMES.test(tagContent)) {
                // Find the tag's closing '>' within old_string
                const closeIdx = simplified.indexOf('>', matchStart);
                if (closeIdx !== -1 && closeIdx < matchEnd) {
                    leadingStrip = closeIdx - matchStart + 1;
                }
            }
        }
    }

    // --- Trailing partial element ---
    // Check if matchEnd falls inside a simplified-only element tag.
    // Scan backward from matchEnd for an unmatched '<' within old_string.
    if (matchEnd < simplified.length) {
        let openPos = -1;
        for (let i = matchEnd - 1; i >= matchStart + leadingStrip; i--) {
            if (simplified[i] === '>') break;
            if (simplified[i] === '<') { openPos = i; break; }
        }
        if (openPos !== -1) {
            const tagContent = simplified.substring(
                openPos + 1,
                Math.min(openPos + 30, simplified.length),
            );
            if (SIMPLIFIED_ELEMENT_NAMES.test(tagContent)) {
                trailingStrip = matchEnd - openPos;
            }
        }
    }

    if (leadingStrip === 0 && trailingStrip === 0) return null;

    const strippedOld = oldString.substring(leadingStrip, oldString.length - trailingStrip);
    if (!strippedOld.trim()) return null;   // Don't strip to empty

    // Apply corresponding stripping to newString:
    // Strip the same leading/trailing fragment if newString shares it.
    let strippedNew = newString;
    if (leadingStrip > 0) {
        const leadingFragment = oldString.substring(0, leadingStrip);
        if (newString.startsWith(leadingFragment)) {
            strippedNew = strippedNew.substring(leadingStrip);
        }
    }
    if (trailingStrip > 0) {
        const trailingFragment = oldString.substring(oldString.length - trailingStrip);
        if (strippedNew.endsWith(trailingFragment)) {
            strippedNew = strippedNew.substring(0, strippedNew.length - trailingStrip);
        }
    }

    return { strippedOld, strippedNew, leadingStrip, trailingStrip };
}

// =============================================================================
// Spurious Wrapping-Tag Stripping
// =============================================================================

export interface WrappingTagStrip {
    strippedOld: string;
    strippedNew: string;
}

/**
 * Generate candidate stripped versions of old_string / new_string where
 * the LLM added a spurious leading opening tag and/or trailing closing tag
 * to produce well-formed HTML.
 *
 * Common pattern: LLM selects text mid-paragraph but prepends `<p>` (or
 * appends `</p>`) to "complete" the element, even though the real tag boundary
 * is elsewhere in the note.  When both old_string and new_string share the
 * same leading (or trailing) tag the addition is cosmetic — stripping it from
 * both preserves the intended edit semantics.
 *
 * Only strips when both strings share the *same* tag at the same position, so
 * intentional tag changes (e.g. `<p>` → `<h3>`) are never affected.
 *
 * Returns candidates in preference order — strip the least amount first to
 * preserve the maximum structural context for matching:
 *   1. Leading-only  (if applicable)
 *   2. Trailing-only (if applicable)
 *   3. Both          (if both are applicable)
 *
 * The caller should try each candidate until one produces a match.
 */
export function stripSpuriousWrappingTags(
    oldString: string,
    newString: string,
): WrappingTagStrip[] {
    // Detect shared leading opening tag
    let leadingTag: string | null = null;
    const leadingMatch = oldString.match(/^<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/);
    if (leadingMatch && newString.startsWith(leadingMatch[0])) {
        leadingTag = leadingMatch[0];
    }

    // Detect shared trailing closing tag (+ optional whitespace)
    let oldTrailingMatch: RegExpMatchArray | null = null;
    let newTrailingMatch: RegExpMatchArray | null = null;
    const trailingMatch = oldString.match(/<\/([a-zA-Z][a-zA-Z0-9]*)>\s*$/);
    if (trailingMatch) {
        const tagName = trailingMatch[1];
        const newTrailing = newString.match(new RegExp(`</${tagName}>\\s*$`));
        if (newTrailing) {
            oldTrailingMatch = trailingMatch;
            newTrailingMatch = newTrailing;
        }
    }

    if (!leadingTag && !oldTrailingMatch) return [];

    const candidates: WrappingTagStrip[] = [];

    function addIfNonEmpty(strippedOld: string, strippedNew: string): void {
        if (strippedOld.trim()) {
            candidates.push({ strippedOld, strippedNew });
        }
    }

    // 1. Leading-only
    if (leadingTag) {
        addIfNonEmpty(
            oldString.substring(leadingTag.length),
            newString.substring(leadingTag.length),
        );
    }

    // 2. Trailing-only
    if (oldTrailingMatch && newTrailingMatch) {
        addIfNonEmpty(
            oldString.substring(0, oldString.length - oldTrailingMatch[0].length),
            newString.substring(0, newString.length - newTrailingMatch[0].length),
        );
    }

    // 3. Both (only when both are applicable and would differ from either alone)
    if (leadingTag && oldTrailingMatch && newTrailingMatch) {
        const strippedOld = oldString.substring(leadingTag.length);
        const strippedNew = newString.substring(leadingTag.length);
        // Apply trailing strip to the already leading-stripped strings
        const oldTrailOnStripped = strippedOld.match(
            new RegExp(`</${oldTrailingMatch[1]}>\\s*$`),
        );
        const newTrailOnStripped = strippedNew.match(
            new RegExp(`</${oldTrailingMatch[1]}>\\s*$`),
        );
        if (oldTrailOnStripped && newTrailOnStripped) {
            addIfNonEmpty(
                strippedOld.substring(0, strippedOld.length - oldTrailOnStripped[0].length),
                strippedNew.substring(0, strippedNew.length - newTrailOnStripped[0].length),
            );
        }
    }

    return candidates;
}
