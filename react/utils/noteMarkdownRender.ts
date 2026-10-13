import { codeRanges } from '@beaver/agent-export/parse/markdown';
import { maskNoteCitationTags, unmaskNoteCitationTags } from '../../src/utils/noteCitationMask';
import { prepareCitationRenderContext } from './citationRenderContext';
import { renderToHTML, type RenderContextData } from './citationRenderers';

/**
 * Render note Markdown (create_note content, Markdown-shaped edits) to HTML
 * whose citations are left as `<citation …/>` tags for the note citation
 * builder to expand in the plugin realm.
 *
 * The Markdown grammar decides what is code, so a tag inside a fenced,
 * indented or inline code example renders as escaped code text, exactly as
 * the chat shows it, and only real citations come back as tags.
 */
export async function renderNoteMarkdownToHTML(content: string, renderContext: RenderContextData): Promise<string> {
    const masked = maskNoteCitationTags(content, codeRanges);
    const html = renderToHTML(masked.text, 'markdown', await prepareCitationRenderContext(masked.text, renderContext));
    return unmaskNoteCitationTags(html, masked);
}
