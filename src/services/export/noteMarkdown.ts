import { hydrateItemLinkLibraryRefs } from '@beaver/agent-core/identity/itemLinks';
import { createPreprocessState, preprocessCitations } from '../../utils/citationPreprocessing';
import { libraryRefForLibraryID } from '../../utils/libraryIdentity';
import { maskNoteCitationTags, unmaskNoteCitationTags } from '../../utils/noteCitationMask';
import type { TextDirectionOptions } from '@beaver/agent-export/render/textDirection';
import type { ExportRuntime } from './exportRuntime';

/** How note Markdown is written. */
export interface NoteRenderOptions {
    /**
     * Give blocks their own text direction (see `rehypeNoteTextDirection`).
     * `'note'`: as a created note gets them, when it has right-to-left letters
     * or the writer reads both directions. `'all'`: on every block, the form
     * every block of a directed note is stored in, which edit fragments are
     * matched against. Without it, blocks take the reader's direction.
     */
    directions?: 'note' | 'all';
}

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
 *
 * @param textDirection Block directions for a note being created; the caller
 *     reads the writer's preference (`directsAllText`).
 */
export function renderNoteMarkdown(
    runtime: Pick<ExportRuntime, 'codeRanges' | 'renderNoteMarkdownHtml'>,
    content: string,
    textDirection?: TextDirectionOptions,
): string {
    const masked = maskNoteCitationTags(content, runtime.codeRanges);
    // Legacy device-local item links in older history become portable here,
    // so the renderer writes them as note links without reading library state.
    const markdown = hydrateItemLinkLibraryRefs(masked.text, libraryRefForLibraryID);
    // Citation preprocessing closes any tag the mask missed, as the chat does,
    // so it cannot swallow the text after it.
    const html = runtime.renderNoteMarkdownHtml(
        markdown,
        (text) => preprocessCitations(text, createPreprocessState()),
        { textDirection },
    );
    return unmaskNoteCitationTags(html, masked);
}
