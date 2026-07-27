import { logger } from './logger';

/**
 * Markers that identify HTML produced by the in-editor diff preview
 * (react/utils/noteEditorDiffPreview.ts). If any appear in a string about to
 * be persisted via item.setNote(), saving must be refused — the diff HTML
 * is presentation-only and persisting it would corrupt the user's note.
 *
 * The rgba() forms are matched with tolerant whitespace because ProseMirror
 * round-trips styles through the DOM and browsers normalise rgba() with
 * spaces after commas.
 */
const PREVIEW_MARKERS: RegExp[] = [
    /id=["']beaver-preview-banner["']/i,
    /id=["']beaver-diff-preview-style["']/i,
    /rgba\(\s*210\s*,\s*40\s*,\s*40\s*,/,
    /rgba\(\s*16\s*,\s*150\s*,\s*72\s*,/,
];

export function containsPreviewMarkers(html: string): boolean {
    if (!html) return false;
    for (const marker of PREVIEW_MARKERS) {
        if (marker.test(html)) return true;
    }
    return false;
}

/**
 * Throw if `html` contains any diff-preview marker. Use at every setNote()
 * call site as a last-chance safety net against EditorInstance._disableSaving
 * being bypassed. Throws rather than strips so the surrounding rollback path
 * runs and the bug is surfaced in logs instead of silently corrupting the
 * note with garbled content.
 */
export function assertNoPreviewMarkers(html: string, context: string): void {
    if (!containsPreviewMarkers(html)) return;
    logger(`notePreviewGuard: refusing setNote at ${context} — diff preview markers detected`, 1);
    throw new Error(`Beaver: refusing to save note containing diff-preview markers (${context})`);
}

const DEL_RGBA = /rgba\(\s*210\s*,\s*40\s*,\s*40\s*,/;
const ADD_RGBA = /rgba\(\s*16\s*,\s*150\s*,\s*72\s*,/;

/**
 * Remove diff-preview markup from note HTML, restoring the pre-preview
 * content:
 *  - the preview banner `<div>` and `<style>` elements are removed entirely;
 *  - deletion-styled spans (red) wrap original note text — unwrapped, keeping
 *    their content;
 *  - addition-styled spans (green) wrap proposed replacement text that was
 *    never real note content — removed together with their content.
 *
 * This is the read-side recovery path for notes where preview markup was
 * accidentally persisted (e.g. an editor autosave slipped through during a
 * preview teardown failure). Without it, the write-side guard
 * `assertNoPreviewMarkers` refuses every subsequent save of the note and
 * there is no way to repair it from the product. Handles both the source
 * form (`rgba(210,40,40,…)`) and the browser/ProseMirror-normalized spaced
 * form (`rgba(210, 40, 40, …)`).
 */
export function stripPreviewMarkers(html: string): string {
    if (!html || !containsPreviewMarkers(html)) return html;
    let out = html
        .replace(/<style\b[^>]*\bid=["']beaver-diff-preview-style["'][^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<div\b[^>]*\bid=["']beaver-preview-banner["'][^>]*>[\s\S]*?<\/div>/gi, '');
    // Marker spans wrap plain text runs when created, but ProseMirror can
    // nest other inline markup inside them after a round trip, so each pass
    // matches closing tags depth-aware. A pass appends unwrapped deletion
    // content without rescanning it, so nested marker spans are picked up by
    // the next pass; the cap only bounds pathological nesting.
    for (let pass = 0; pass < 10; pass++) {
        const next = stripMarkerSpansOnce(out);
        if (next === out) break;
        out = next;
    }
    return out;
}

/**
 * A bare line-through span exactly as the note editor's `strike` mark
 * serializes it. The diff's deletion style combines line-through with the
 * red background in one span, but ProseMirror stores them as two marks and
 * serializes the strike OUTSIDE the background-color span (schema mark
 * order), so persisted deletions look like:
 *   <span style="text-decoration: line-through"><span style="background-color: rgba(210, 40, 40, 0.28)">old</span></span>
 */
const STRIKE_OPEN_AT_END = /<span\b[^>]*style=["']\s*text-decoration:\s*line-through;?\s*["'][^>]*>$/i;
const CLOSE_SPAN_AT_START = /^<\/span\s*>/i;

/**
 * Single pass over `html` removing addition-marker spans (with content) and
 * unwrapping deletion-marker spans (keeping content). Closing tags are
 * matched by tracking nested `<span>` depth. A strike span that directly and
 * exclusively wraps a deletion span is unwrapped with it — it is the
 * ProseMirror-serialized half of the deletion style, and leaving it would
 * strike through all recovered text. Strike spans anywhere else (user
 * formatting) are untouched.
 */
function stripMarkerSpansOnce(html: string): string {
    const openRe = /<span\b[^>]*>/gi;
    let result = '';
    let pos = 0;
    for (;;) {
        openRe.lastIndex = pos;
        let open: RegExpExecArray | null = null;
        let isAddition = false;
        let m: RegExpExecArray | null;
        while ((m = openRe.exec(html)) !== null) {
            if (DEL_RGBA.test(m[0])) { open = m; isAddition = false; break; }
            if (ADD_RGBA.test(m[0])) { open = m; isAddition = true; break; }
        }
        if (!open) return result + html.slice(pos);
        const segment = html.slice(pos, open.index);
        const innerStart = open.index + open[0].length;
        const tokenRe = /<\/span\s*>|<span\b[^>]*>/gi;
        tokenRe.lastIndex = innerStart;
        let depth = 1;
        let innerEnd = -1;
        let closeEnd = -1;
        let tok: RegExpExecArray | null;
        while ((tok = tokenRe.exec(html)) !== null) {
            depth += tok[0][1] === '/' ? -1 : 1;
            if (depth === 0) {
                innerEnd = tok.index;
                closeEnd = tok.index + tok[0].length;
                break;
            }
        }
        if (innerEnd === -1) {
            // Unbalanced markup: drop just the marker open tag and continue.
            result += segment;
            pos = innerStart;
            continue;
        }
        let head = segment;
        let afterEnd = closeEnd;
        if (!isAddition) {
            const strikeOpen = head.match(STRIKE_OPEN_AT_END);
            const closeAfter = strikeOpen ? html.slice(afterEnd).match(CLOSE_SPAN_AT_START) : null;
            if (strikeOpen && closeAfter) {
                head = head.slice(0, head.length - strikeOpen[0].length);
                afterEnd += closeAfter[0].length;
            }
        }
        result += head;
        if (!isAddition) result += html.slice(innerStart, innerEnd);
        pos = afterEnd;
    }
}
