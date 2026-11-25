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
    markdownRemarkPlugins,
    markdownSanitizePlugins,
    noteRehypePlugins,
    prepareMarkdownSource,
} from './markdownPipeline';
import type { HastNode } from './hast';
import { hastToStaticMarkup } from './reactStaticMarkup';
import type { TextDirectionOptions } from './textDirection';

/** Section labels are only written by the chat's export render, so a note render directs by `all` alone. */
type NoteTextDirection = Pick<TextDirectionOptions, 'all'>;

function createProcessor(textDirection?: NoteTextDirection) {
    return unified()
        .use(remarkParse)
        .use(markdownRemarkPlugins)
        .use(remarkRehype, { allowDangerousHtml: true })
        .use(markdownSanitizePlugins)
        .use(noteRehypePlugins(textDirection))
        .freeze();
}

type NoteProcessor = ReturnType<typeof createProcessor>;

/** The frozen pipelines, by text direction mode, built on first use. */
const processors: Partial<Record<'none' | 'rtl' | 'all', NoteProcessor>> = {};

function processorFor(textDirection?: NoteTextDirection): NoteProcessor {
    const mode = !textDirection ? 'none' : textDirection.all ? 'all' : 'rtl';
    // Only `all` shapes the cached pipeline, so nothing else is passed on.
    return processors[mode] ??= createProcessor(textDirection && { all: textDirection.all === true });
}

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

export interface NoteMarkdownHtmlOptions {
    /**
     * Give blocks their own text direction, as a note being written gets (see
     * `rehypeNoteTextDirection`). `all` is the writer's preference for
     * directing text without right-to-left letters too. Without it, blocks
     * take the reader's interface direction.
     */
    textDirection?: NoteTextDirection;
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
export function renderNoteMarkdownHtml(
    markdown: string,
    preprocessCitations: (text: string) => string,
    options: NoteMarkdownHtmlOptions = {},
): string {
    const processor = processorFor(options.textDirection);
    const source = prepareMarkdownSource(markdown, { exportRendering: true, preprocessCitations });
    const tree = processor.runSync(processor.parse(source), source) as unknown as HastNode;
    postProcess(tree);
    const root: HastNode = {
        type: 'root',
        children: [{ type: 'element', tagName: 'div', properties: { className: ['markdown'] }, children: tree.children ?? [] }],
    };
    return hastToStaticMarkup(root, { citation: () => null });
}
