/**
 * Note Markdown to HTML, without React or a DOM, so a note can be written from
 * the plugin realm with no window open.
 *
 * The output is what the chat's React renderer writes for the same Markdown in
 * export mode (`MarkdownRenderer` with `exportRendering`, wrapped in
 * `<div class="markdown">`): the same unified pipeline from
 * `markdownPipeline.ts`, the same post-processing react-markdown applies, and
 * React's markup (`reactStaticMarkup.ts`).
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { urlAttributes } from 'html-url-attributes';
import {
    exportUrlTransform,
    type HastNode,
    markdownRemarkPlugins,
    markdownSanitizePlugins,
    noteRehypePlugins,
    prepareMarkdownSource,
} from './markdownPipeline';
import { hastToStaticMarkup } from './reactStaticMarkup';

const processor = unified()
    .use(remarkParse)
    .use(markdownRemarkPlugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(markdownSanitizePlugins)
    .use(noteRehypePlugins)
    .freeze();

const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * react-markdown's post-processing: raw HTML left after rehype-raw becomes
 * text, and every URL attribute goes through the URL transform.
 */
function postProcess(node: HastNode): void {
    const children = node.children;
    if (!children) return;
    for (let index = 0; index < children.length; index++) {
        const child = children[index];
        if (child.type === 'raw') {
            children[index] = { type: 'text', value: child.value };
            continue;
        }
        if (child.type === 'element' && child.properties) {
            for (const key in urlAttributes) {
                if (!hasOwn(urlAttributes, key) || !hasOwn(child.properties, key)) continue;
                const test = urlAttributes[key];
                if (test === null || test.includes(child.tagName ?? '')) {
                    child.properties[key] = exportUrlTransform(String(child.properties[key] || ''));
                }
            }
        }
        postProcess(child);
    }
}

/**
 * Render note Markdown to note HTML.
 *
 * The caller masks citation tags first (`maskNoteCitationTags`) and expands
 * them afterwards. A tag the mask cannot see, such as one split by a
 * zero-width character that preprocessing removes, still reaches the parser:
 * `preprocessCitations` (the chat's citation preprocessing) closes it so it
 * cannot swallow the text after it, and it renders nothing.
 */
export function renderNoteMarkdownHtml(markdown: string, preprocessCitations: (text: string) => string): string {
    const source = prepareMarkdownSource(markdown, { exportRendering: true, preprocessCitations });
    const tree = processor.runSync(processor.parse(source), source) as unknown as HastNode;
    postProcess(tree);
    const root: HastNode = {
        type: 'root',
        children: [{ type: 'element', tagName: 'div', properties: { className: ['markdown'] }, children: tree.children ?? [] }],
    };
    return hastToStaticMarkup(root, { citation: () => null });
}
