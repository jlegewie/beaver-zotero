import React, { useMemo } from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import deepmerge from 'deepmerge';
import ZoteroCitation from '../sources/ZoteroCitation';

const customSchema = deepmerge(defaultSchema, {
    tagNames: [...(defaultSchema.tagNames || []), 'citation', 'note'],
    attributes: {
        ...defaultSchema.attributes,
        citation: ['id', 'cid', 'sid', 'consecutive'],
        note: ['id', 'title', 'item_id', 'itemId', 'dataNoteId', 'data-note-id', 'datanoteid'],
        '*': [...(defaultSchema.attributes?.['*'] || []), 'data-note-id', 'dataNoteId']
    }
});

interface MarkdownBodyProps {
    content: string;
    className?: string;
    exportRendering?: boolean;
    components?: Components;
}

const MarkdownBody: React.FC<MarkdownBodyProps> = ({
    content,
    className = 'markdown',
    exportRendering = false,
    components
}) => {
    const mergedComponents = useMemo(() => ({
        citation: ({node, ...props}: any) => (
            <ZoteroCitation {...props} exportRendering={exportRendering} />
        ),
        ...(components || {})
    }), [components, exportRendering]);

    return (
        <ReactMarkdown
            className={className}
            remarkPlugins={[remarkMath, remarkGfm]}
            rehypePlugins={[rehypeRaw, [rehypeSanitize, customSchema], rehypeKatex]}
            components={mergedComponents}
        >
            {content}
        </ReactMarkdown>
    );
};

export default MarkdownBody;

