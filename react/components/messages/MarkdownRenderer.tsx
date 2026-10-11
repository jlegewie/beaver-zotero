import React from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import Citation from '@beaver/agent-ui/chat/Citation';
import rehypeKatex from 'rehype-katex';
import deepmerge from 'deepmerge';
import { 
    preprocessCitations, 
    createPreprocessState 
} from '../../utils/citationPreprocessing';
import { processPartialContent } from '../../utils/markdownPartialContent';
import { unwrapLegacyNoteTags } from '../../utils/legacyNoteTags';
import { getHost } from '@beaver/agent-ui/host';
import { resolveObjectIdReference } from '@beaver/agent-core/identity/libraryRef';
import { itemLinkExportHref, parseItemLinkHref, type ItemLinkTarget } from '@beaver/agent-core/identity/itemLinks';
import { useFindQuery } from '@beaver/agent-ui/chat/findContext';
import { rehypeFindHighlight } from '@beaver/agent-ui/chat/rehypeFindHighlight';

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

// Create a custom schema that extends GitHub's defaults but allows normalized citation tags.
const customSchema = deepmerge(defaultSchema, {
    tagNames: [...(defaultSchema.tagNames || []), 'citation'],
    attributes: {
        ...defaultSchema.attributes,
        citation: citationDataAttributes
    },
    protocols: {
        ...defaultSchema.protocols,
        href: [...(defaultSchema.protocols?.href || []), 'zotero']
    }
});

/**
 * Extract text content from a HAST node tree.
 */
function hastTextContent(node: any): string {
    if (node.type === 'text') return node.value || '';
    if (node.children) {
        return node.children.map((c: any) => hastTextContent(c)).join('');
    }
    return '';
}

/**
 * Rehype plugin that converts math nodes to Zotero's note format
 * instead of rendering with KaTeX.
 *
 * After remark-math + rehype-sanitize, math nodes appear as:
 *   - Inline:  <code class="language-math">content</code>
 *   - Display: <pre><code class="language-math">content</code></pre>
 *
 * This plugin transforms them to:
 *   - Inline:  <span class="math">$content$</span>
 *   - Display: <pre class="math">$$content$$</pre>
 */
function rehypeZoteroMath() {
    return (tree: any) => {
        transformMathNodes(tree);
    };
}

function transformMathNodes(node: any) {
    if (!node.children) return;

    for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.type !== 'element') continue;

        const classes: string[] = Array.isArray(child.properties?.className)
            ? child.properties.className
            : [];

        // Display math: <pre><code class="language-math">content</code></pre>
        if (child.tagName === 'pre' && child.children?.length === 1) {
            const codeChild = child.children[0];
            if (codeChild.type === 'element' && codeChild.tagName === 'code') {
                const codeClasses: string[] = Array.isArray(codeChild.properties?.className)
                    ? codeChild.properties.className
                    : [];
                if (codeClasses.includes('language-math')) {
                    const mathContent = hastTextContent(codeChild);
                    child.properties = { className: ['math'] };
                    child.children = [{ type: 'text', value: `$$${mathContent}$$` }];
                    continue;
                }
            }
        }

        // Inline math: <code class="language-math">content</code>
        if (child.tagName === 'code' && classes.includes('language-math')) {
            const mathContent = hastTextContent(child);
            child.tagName = 'span';
            child.properties = { className: ['math'] };
            child.children = [{ type: 'text', value: `$${mathContent}$` }];
            continue;
        }

        // Recurse into untransformed nodes
        transformMathNodes(child);
    }
}

/** Allow zotero:// URLs through react-markdown's URL sanitization */
function urlTransform(url: string): string {
    if (url.startsWith('zotero://')) return url;
    return defaultUrlTransform(url);
}

/**
 * Export variant: the rendered HTML is saved into a Zotero note, where a bare
 * object id (`u-KEY`) is not a working href, so item links are written as
 * `zotero://select` URIs the note editor can follow.
 */
function exportUrlTransform(url: string): string {
    return itemLinkExportHref(url) ?? urlTransform(url);
}

/**
 * Follow a link to a Zotero object. The object id is resolved here, at click
 * time, so rendering never touches the host's libraries.
 */
function activateItemLink(link: ItemLinkTarget): void {
    const ref = resolveObjectIdReference(link.objectId);
    if (!ref) return;
    const navigation = getHost().navigation;
    if (link.kind === 'collection') void navigation?.revealCollection(ref);
    else void navigation?.revealObject?.(ref);
}

/**
 * Anchor rendered inside the chat.
 *
 * The UI is hosted in a chrome document, where a bare `<a href>` has no
 * navigation behavior — clicking one only selects its text. Links must be
 * opened explicitly through the host, so the default click is always
 * suppressed. Fragment-only links have no target to open and stay inert.
 *
 * A link whose href is a Zotero object id (`[Smith 2004](u-KEY)`, see
 * `itemLinks.ts`) reveals that object in the host instead of opening a URL.
 */
function MarkdownLink({ href, children, title, ...props }: any) {
    const itemLink = parseItemLinkHref(href);
    const isExternal = !itemLink && Boolean(href) && !href.startsWith('#');
    const defaultTitle = itemLink ? 'Show in Zotero' : isExternal ? href : undefined;
    return (
        <a
            {...props}
            href={href}
            title={title ?? defaultTitle}
            onClick={(event) => {
                event.preventDefault();
                if (itemLink) activateItemLink(itemLink);
                else if (isExternal) getHost().navigation?.openExternalUrl(href);
            }}
        >
            {children}
        </a>
    );
}

/** The rehype plugin list ReactMarkdown accepts, named so it can be built up. */
type RehypePlugins = NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']>;

type MarkdownRendererProps = {
    content: string;
    className?: string;
    exportRendering?: boolean;
};

const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(function MarkdownRenderer({
    content,
    className = 'markdown',
    exportRendering = false,
}) {
    // Highlighting of find-in-chat matches. `''` whenever there is no find
    // session, so the no-query path renders exactly what it rendered before
    // find-in-chat existed. Never highlight an export render: that content is on
    // its way into a Zotero note, and a <mark> must not be saved with it.
    const activeFindQuery = useFindQuery();
    const findQuery = exportRendering ? '' : activeFindQuery;

    // ReactMarkdown re-parses whenever this list changes identity, so it is
    // memoized: an unrelated parent re-render must not re-parse, and a query
    // change must re-parse exactly once. The parsing happens after the
    // `processedMarkdown` memo below, which is why that one stays independent of
    // the query.
    const rehypePlugins = React.useMemo(() => {
        const plugins: RehypePlugins = [
            rehypeRaw,
            [rehypeSanitize, customSchema],
            exportRendering ? rehypeZoteroMath : rehypeKatex,
        ];
        // Always last. The transformer inserts markup the sanitize schema does
        // not allow, so sanitizing after it would strip the highlights, and it
        // can only recognize (and skip) KaTeX output once KaTeX has produced it.
        if (findQuery) plugins.push([rehypeFindHighlight, findQuery]);
        return plugins;
    }, [findQuery, exportRendering]);

    // Heavy preprocessing: skip when content/flags are unchanged (e.g. parent re-render).
    const processedMarkdown = React.useMemo(() => {
        let markdownContent = processPartialContent(content, exportRendering);
        // Threads predating the `create_note` tool still carry `<note>` sections.
        markdownContent = unwrapLegacyNoteTags(markdownContent);
        markdownContent = preprocessCitations(markdownContent, createPreprocessState());
        return markdownContent
            .replace(/```plaintext\s*([\s\S]*?)\s*```/, '$1')
            .replace(/(?<!\\)\\\(((?:\\.|[^\\])*?)\\\)/g, (_, match) => `$${match}$`)
            .replace(/(?<!\\)\\\[((?:\\.|[^\\])*?)\\\]/g, (_, match) => `$$${match}$$`)
            .replace(/\$\$([^$]+)\$\$/g, (_, equation) => `\n$$\n${equation.trim()}\n$$\n`);
    }, [content, exportRendering]);

    return (
        <div className={className}>
            <ReactMarkdown
                // Strikethrough needs `~~`: models write subscripts as `P~lac~`
                // and approximations as `~5`, which single tildes would strike.
                remarkPlugins={[remarkMath, [remarkGfm, { singleTilde: false }]]}
                rehypePlugins={rehypePlugins}
                urlTransform={exportRendering ? exportUrlTransform : urlTransform}
                components={{
                    // @ts-expect-error - Custom component not in ReactMarkdown types
                    citation: ({node, ...props}: any) => {
                        return <Citation {...props} exportRendering={exportRendering} />;
                    },
                    // Exported notes keep a plain anchor: the note editor
                    // handles link clicks itself.
                    ...(exportRendering ? {} : {
                        a: ({node, ...props}: any) => <MarkdownLink {...props} />
                    })
                }}
            >
                {processedMarkdown}
            </ReactMarkdown>
        </div>
    );
});

export default MarkdownRenderer;
