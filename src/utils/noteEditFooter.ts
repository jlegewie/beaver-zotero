/**
 * "Edited by Beaver" footer management for note edits.
 *
 * When Beaver edits a note, a footer is added/updated at the bottom:
 *   Edited by Beaver · Chat 1 · Chat 2
 * Each "Chat N" links to the thread that made the edit.
 *
 * The footer is stripped from the simplified view (so the agent can't see or edit it)
 * but persists in the raw note HTML for users to see.
 */

const EDIT_FOOTER_MARKER = 'Edited by Beaver';

/**
 * Matches the full structural pattern of the "Edited by Beaver" footer.
 * Requires the <p><span style="color: …"> prefix so that plain-text
 * occurrences of "Edited by Beaver" in user content are never matched.
 * Also avoids the old lastIndexOf('<p', …) approach that could match <pre>.
 *
 * The color value is matched flexibly because ProseMirror normalises
 * `color: #aaa` → `color: rgb(170, 170, 170)` after a save round-trip.
 */
const EDIT_FOOTER_REGEX = /<p><span style="color:[^"]*">Edited by Beaver[\s\S]*?<\/span><\/p>/;

/**
 * Matches the "Created by Beaver" footer added when Beaver creates a new note.
 * Color is matched flexibly for the same ProseMirror normalisation reason.
 */
const CREATED_FOOTER_REGEX = /<p><span style="color:[^"]*"><a href="zotero:\/\/beaver\/thread\/[^"]*"[^>]*>Created by Beaver<\/a><\/span><\/p>/;

export interface ParsedEditFooter {
    footerHtml: string;
    threadIds: string[];
    startIndex: number;
    endIndex: number;
}

/**
 * Parse an existing "Edited by Beaver" footer from note HTML.
 * Returns the footer details and linked thread IDs, or null if not found.
 *
 * Only matches the exact structural pattern produced by buildEditFooterHtml,
 * so user content that happens to contain the words "Edited by Beaver"
 * (without the styled <span> wrapper) will not be mistakenly identified.
 */
export function parseEditFooter(html: string): ParsedEditFooter | null {
    const match = EDIT_FOOTER_REGEX.exec(html);
    if (!match) return null;

    const footerHtml = match[0];
    const startIndex = match.index;
    const endIndex = startIndex + footerHtml.length;

    // Extract thread IDs from zotero://beaver/thread/ID links
    const threadIds: string[] = [];
    const linkRegex = /href="zotero:\/\/beaver\/thread\/([^"/]+)"/g;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(footerHtml)) !== null) {
        threadIds.push(linkMatch[1]);
    }

    return { footerHtml, threadIds, startIndex, endIndex };
}

/**
 * Build the edit footer HTML from a list of thread IDs.
 * Each thread gets a numbered "Chat N" link.
 */
export function buildEditFooterHtml(threadIds: string[]): string {
    if (threadIds.length === 0) return '';
    const links = threadIds.map((tid, i) =>
        `<a href="zotero://beaver/thread/${tid}">Chat ${i + 1}</a>`
    );
    return `<p><span style="color: #aaa;">${EDIT_FOOTER_MARKER} \u00b7 ${links.join(' \u00b7 ')}</span></p>`;
}

/**
 * Collect thread IDs from ALL edit footers in the HTML (handles duplicates
 * left behind by earlier bugs or ProseMirror round-trips).
 */
function collectAllThreadIds(html: string): string[] {
    const ids: string[] = [];
    const globalRegex = new RegExp(EDIT_FOOTER_REGEX.source, 'g');
    const linkRegex = /href="zotero:\/\/beaver\/thread\/([^"/]+)"/g;
    let footerMatch;
    while ((footerMatch = globalRegex.exec(html)) !== null) {
        linkRegex.lastIndex = 0;
        let linkMatch;
        while ((linkMatch = linkRegex.exec(footerMatch[0])) !== null) {
            if (!ids.includes(linkMatch[1])) {
                ids.push(linkMatch[1]);
            }
        }
    }
    return ids;
}

/**
 * Add or update the "Edited by Beaver" footer in note HTML.
 *
 * - No existing footer → insert new one before closing </div> wrapper (or append).
 * - Footer exists, thread already linked → return unchanged (unless duplicates need cleanup).
 * - Footer exists, new thread → rebuild footer with all threads consolidated.
 *
 * Also consolidates duplicate footers left behind by earlier bugs.
 */
export function addOrUpdateEditFooter(html: string, threadId: string): string {
    const existingIds = collectAllThreadIds(html);

    // Fast path: single footer, thread already tracked → nothing to do.
    if (existingIds.includes(threadId) && !hasMultipleFooters(html)) {
        return html;
    }

    // Strip ALL existing footers, then rebuild a single consolidated one.
    const cleaned = stripBeaverEditFooter(html);
    const allIds = existingIds.includes(threadId) ? existingIds : [...existingIds, threadId];
    const newFooter = buildEditFooterHtml(allIds);

    const closingDivIdx = cleaned.lastIndexOf('</div>');
    if (closingDivIdx !== -1) {
        return cleaned.substring(0, closingDivIdx) + newFooter + cleaned.substring(closingDivIdx);
    }
    return cleaned + newFooter;
}

function hasMultipleFooters(html: string): boolean {
    const globalRegex = new RegExp(EDIT_FOOTER_REGEX.source, 'g');
    let count = 0;
    while (globalRegex.exec(html) !== null) {
        count++;
        if (count > 1) return true;
    }
    return false;
}

/**
 * Strip ALL "Edited by Beaver" footers from HTML.
 * Uses the global flag to handle duplicates left by earlier bugs.
 */
export function stripBeaverEditFooter(html: string): string {
    return html.replace(new RegExp(EDIT_FOOTER_REGEX.source, 'g'), '');
}

/**
 * Strip the "Created by Beaver" footer from HTML.
 * Used by the simplifier so the agent can't see or edit the footer.
 */
export function stripBeaverCreatedFooter(html: string): string {
    return html.replace(CREATED_FOOTER_REGEX, '');
}
