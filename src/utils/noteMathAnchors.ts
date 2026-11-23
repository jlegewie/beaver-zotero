/**
 * Math-anchor classification shared by the edit_note matcher and the note
 * editor diff preview.
 *
 * Kept separate from `noteCitationExpand` so the classification policy has one
 * home next to the two consumers that must agree on it: if they disagree, the
 * preview renders a different target than the edit actually applies to.
 */

/**
 * Classify where a raw-HTML anchor occurs relative to the note's math wrappers.
 *
 * `read_note` keeps `<span class="math">` / `<pre class="math">` wrappers, so a
 * dollar-delimited anchor copied from an older read expands literally and lands
 * *inside* a wrapper instead of targeting it. Callers use this to decide whether
 * to re-expand the anchor with `'legacy-old'`:
 *
 *  - `literal` — every occurrence (possibly none) is outside math, or fully
 *    contains a wrapper: use the literal expansion.
 *  - `wrapped` — every occurrence is a partial slice of a math element: the
 *    anchor means the whole element, so expand it with `'legacy-old'`.
 *  - `mixed`   — both, which no single expansion can serve; the matcher rejects
 *    these with `ambiguous_match`.
 */
export function classifyMathAnchorOccurrences(
    html: string,
    needle: string,
): 'literal' | 'wrapped' | 'mixed' {
    if (!needle.includes('$')) return 'literal';
    const wrappers = [...html.matchAll(/<(span|pre)\b[^>]*class="math"[^>]*>[\s\S]*?<\/\1>/g)]
        .map(match => ({ start: match.index!, end: match.index! + match[0].length }));
    let literal = false;
    let wrapped = false;
    let pos = html.indexOf(needle);
    while (pos !== -1) {
        const end = pos + needle.length;
        if (wrappers.some(range => pos < range.end && end > range.start
            && !(pos <= range.start && end >= range.end))) {
            wrapped = true;
        } else {
            literal = true;
        }
        pos = html.indexOf(needle, end);
    }
    return wrapped ? (literal ? 'mixed' : 'wrapped') : 'literal';
}
