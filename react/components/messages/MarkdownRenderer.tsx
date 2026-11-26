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
import MarkdownLink from '@beaver/agent-ui/chat/MarkdownLink';
import { useFindQuery } from '@beaver/agent-ui/chat/findContext';
import { rehypeFindHighlight } from '@beaver/agent-ui/chat/rehypeFindHighlight';
import { rehypeTextDirection } from '@beaver/agent-export/render/textDirection';
import { NOTE_SECTION_LABELS } from '../../utils/threadContent';

/** An export render is a chat saved as a note, whose section headings are interface text. */
const NOTE_LABELS = Object.values(NOTE_SECTION_LABELS);

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
        // The note rules (Zotero math, endnotes and block directions) are the
        // ones the note renderer in the plugin realm uses, so an export matches
        // a note write. An export renders a new note, so its blocks are
        // directed like the agent's `create_note`.
        const plugins: RehypePlugins = [
            ...markdownSanitizePlugins,
            ...(exportRendering
                ? noteRehypePlugins({ all: directsAllText, labels: NOTE_LABELS })
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
                    ...(exportRendering ? {} : { a: MarkdownLink })
                }}
            >
                {processedMarkdown}
            </ReactMarkdown>
        </div>
    );
});

export default MarkdownRenderer;
