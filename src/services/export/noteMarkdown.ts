import { hydrateItemLinkLibraryRefs } from '@beaver/agent-core/identity/itemLinks';
import { createPreprocessState, preprocessCitations } from '../../utils/citationPreprocessing';
import { libraryRefForLibraryID } from '../../utils/libraryIdentity';
import { maskNoteCitationTags, unmaskNoteCitationTags } from '../../utils/noteCitationMask';
import type { ExportRuntime } from './exportRuntime';

/**
 * Render note Markdown (create_note content, Markdown-shaped edits) to HTML
 * whose citations are left as `<citation …/>` tags for the note citation
 * builder to expand.
 *
 * Runs in the plugin realm with no window: the export runtime renders the
 * Markdown without React or a DOM. The Markdown grammar decides what is code,
 * so a tag inside a fenced, indented or inline code example renders as escaped
 * code text, exactly as the chat shows it, and only real citations come back
 * as tags.
 */
export function renderNoteMarkdown(
    runtime: Pick<ExportRuntime, 'codeRanges' | 'renderNoteMarkdownHtml'>,
    content: string,
): string {
    const masked = maskNoteCitationTags(content, runtime.codeRanges);
    // Legacy device-local item links in older history become portable here,
    // so the renderer writes them as note links without reading library state.
    const markdown = hydrateItemLinkLibraryRefs(masked.text, libraryRefForLibraryID);
    // Citation preprocessing closes any tag the mask missed, as the chat does,
    // so it cannot swallow the text after it.
    const html = runtime.renderNoteMarkdownHtml(markdown, (text) => preprocessCitations(text, createPreprocessState()));
    return unmaskNoteCitationTags(html, masked);
}
