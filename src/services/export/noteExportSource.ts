/**
 * Read a Zotero note for export: its structure as the note editor sees it,
 * and the item metadata it stores for its citations.
 *
 * Beaver's own provenance lines ("Created by Beaver", "Edited by Beaver",
 * wherever a note has them) are not part of its content and are left out.
 * Each citation records what the note shows for it, which the export falls
 * back to for an item it cannot resolve.
 */

import { restoreLocalHref } from '../../prosemirror/normalize';
import type { PmNode } from '@beaver/agent-export/runtime';
import { parseNoteHtml } from '../../prosemirror/parseNote';
import { CREATED_FOOTER_TEXT_REGEX, stripBeaverEditFooter } from '../../utils/noteEditFooter';
import type { NoteCitationCacheEntry } from './exportCitations';

export interface NoteForExport {
    /** The note's ProseMirror document as JSON. */
    doc: PmNode;
    /** Item metadata the note stores for its citations (`data-citation-items`). */
    citationItems: NoteCitationCacheEntry[];
}

/** The note wrapper's stored citation metadata. */
function parseCitationItems(attribute: string | undefined): NoteCitationCacheEntry[] {
    if (!attribute) return [];
    try {
        const entries = JSON.parse(decodeURIComponent(attribute));
        if (!Array.isArray(entries)) return [];
        return entries.filter((entry): entry is NoteCitationCacheEntry =>
            !!entry && Array.isArray(entry.uris) && !!entry.itemData && typeof entry.itemData === 'object');
    } catch {
        return [];
    }
}

/**
 * Record on each citation what the note shows for it: the text of each item
 * (`properties.beaverPreviewItems`) when the citation shows one piece per
 * item, and the whole citation (`properties.beaverPreview`).
 */
function recordCitationPreviews(container: HTMLElement): void {
    for (const span of Array.from(container.querySelectorAll('span.citation[data-citation]')) as Element[]) {
        let citation: { citationItems?: unknown[]; properties?: Record<string, unknown> };
        try {
            citation = JSON.parse(decodeURIComponent(span.getAttribute('data-citation') ?? ''));
        } catch {
            continue;
        }
        if (!citation || typeof citation !== 'object') continue;
        const pieces = (Array.from(span.querySelectorAll('.citation-item')) as Element[]).map(piece => piece.textContent?.trim() ?? '');
        const whole = span.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        const count = Array.isArray(citation.citationItems) ? citation.citationItems.length : 0;
        citation.properties = {
            ...(citation.properties && typeof citation.properties === 'object' ? citation.properties : {}),
            ...(whole ? { beaverPreview: whole } : {}),
            // A single item shows as the whole citation, with its parentheses.
            ...(count > 1 && pieces.length === count ? { beaverPreviewItems: pieces } : {}),
        };
        span.setAttribute('data-citation', encodeURIComponent(JSON.stringify(citation)));
    }
}

/**
 * The text color Beaver writes its footers in (`#aaa`, `rgb(170, 170, 170)`
 * once the editor has saved the note): the `color` declaration itself, not
 * `background-color`.
 */
const FOOTER_GRAY_STYLE = /(?:^|;)\s*color\s*:\s*(?:#aaa(?:aaa)?\b|rgb\(\s*170\s*,\s*170\s*,\s*170\s*\))/i;

/**
 * Whether a paragraph is Beaver's "Created by Beaver" line: its text, and
 * either its link back to the chat or — for footers whose link an earlier
 * normalization dropped — the full "Created by Beaver · Open Message" text in
 * the footer's gray.
 */
function isBeaverBranding(paragraph: Element): boolean {
    const text = paragraph.textContent ?? '';
    if (!CREATED_FOOTER_TEXT_REGEX.test(text)) return false;
    const links = Array.from(paragraph.querySelectorAll('a[href]')) as Element[];
    if (links.some(link => restoreLocalHref(link.getAttribute('href') ?? '').startsWith('zotero://beaver/'))) return true;
    const styled = Array.from(paragraph.querySelectorAll('[style]')) as Element[];
    return text.includes('\u00b7') && styled.some(element => FOOTER_GRAY_STYLE.test(element.getAttribute('style') ?? ''));
}

/**
 * Remove Beaver's "Created by Beaver · Open Message" paragraphs, with the
 * rule that sets each off: a note saved from a chat carries one under its
 * title and one at its end, and a note the agent created one at its end.
 * They link back to the chat, which means nothing outside Zotero.
 */
function removeBeaverBranding(container: HTMLElement): void {
    for (const paragraph of Array.from(container.querySelectorAll('p')) as Element[]) {
        if (!isBeaverBranding(paragraph)) continue;
        const next = paragraph.nextElementSibling;
        const previous = paragraph.previousElementSibling;
        if (next?.tagName.toLowerCase() === 'hr') next.remove();
        else if (previous?.tagName.toLowerCase() === 'hr') previous.remove();
        paragraph.remove();
    }
}

/** Read note HTML for export. */
export function readNoteForExport(html: string): NoteForExport {
    // "Created by Beaver" lines (with their rules) are removed from the parsed DOM.
    const content = stripBeaverEditFooter(html);
    const { doc, metadataAttributes } = parseNoteHtml(content, container => {
        removeBeaverBranding(container);
        recordCitationPreviews(container);
    });
    return { doc, citationItems: parseCitationItems(metadataAttributes['data-citation-items']) };
}
