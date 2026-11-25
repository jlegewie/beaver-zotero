import React from 'react';
import ReactMarkdown from 'react-markdown';
import Citation from '@beaver/agent-ui/chat/Citation';
import rehypeKatex from 'rehype-katex';
import { 
    preprocessCitations, 
    createPreprocessState 
} from '../../utils/citationPreprocessing';
import {
    exportUrlTransform,
    markdownRemarkPlugins,
    markdownSanitizePlugins,
    markdownUrlTransform,
    noteRehypePlugins,
    prepareMarkdownSource,
} from '@beaver/agent-export/render/markdownPipeline';
import { getHost } from '@beaver/agent-ui/host';
import { resolveObjectIdReference } from '@beaver/agent-core/identity/libraryRef';
import { parseItemLinkHref, type ItemLinkTarget } from '@beaver/agent-core/identity/itemLinks';
import { useFindQuery } from '@beaver/agent-ui/chat/findContext';
import { rehypeFindHighlight } from '@beaver/agent-ui/chat/rehypeFindHighlight';
import { rehypeTextDirection } from '@beaver/agent-ui/chat/rehypeTextDirection';

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
    // Read on each render, as other host display settings are.
    const directsAllText = getHost().config?.directsAllText?.() === true;
    const rehypePlugins = React.useMemo(() => {
        // The note rules (Zotero math and endnotes) are the ones the note
        // renderer in the plugin realm uses, so an export matches a note write.
        // Right-to-left text gets block directions on screen only: a note
        // keeps the markup the note renderer in the plugin realm writes.
        const plugins: RehypePlugins = [
            ...markdownSanitizePlugins,
            ...(exportRendering
                ? noteRehypePlugins
                : [rehypeKatex, [rehypeTextDirection, { all: directsAllText }]] as RehypePlugins),
        ];
        // Always last. The transformer inserts markup the sanitize schema does
        // not allow, so sanitizing after it would strip the highlights, and it
        // can only recognize (and skip) KaTeX output once KaTeX has produced it.
        if (findQuery) plugins.push([rehypeFindHighlight, findQuery]);
        return plugins;
    }, [findQuery, exportRendering, directsAllText]);

    // Heavy preprocessing: skip when content/flags are unchanged (e.g. parent re-render).
    const processedMarkdown = React.useMemo(() => prepareMarkdownSource(content, {
        exportRendering,
        preprocessCitations: (text) => preprocessCitations(text, createPreprocessState()),
    }), [content, exportRendering]);

    return (
        <div className={className}>
            <ReactMarkdown
                remarkPlugins={markdownRemarkPlugins}
                rehypePlugins={rehypePlugins}
                urlTransform={exportRendering ? exportUrlTransform : markdownUrlTransform}
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
