import React from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm'
// import rehypeKatex from 'rehype-katex';
// import 'katex/dist/katex.min.css';

type MarkdownRendererProps = {
    className: string;
    content: string;
};

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, className }) => {
    return (
        <ReactMarkdown
            // "markdown-body"
            className={className}
            remarkPlugins={[remarkMath,remarkGfm]}
            // rehypePlugins={[rehypeKatex]}
            urlTransform={(uri) => {
                // Allow zotero links to pass through without sanitization
                if (uri.startsWith('zotero://')) {
                    return uri;
                }
                // Use default sanitization for all other links
                return defaultUrlTransform(uri);
            }}
        >
            {content
                .replace(/```plaintext\s*([\s\S]*?)\s*```/, '$1')
                .replace(/\$\$([^$]+)\$\$/g, (_, equation) => `\n$$\n${equation.trim()}\n$$\n`)
                .replace(/^## Introduction\n\n/, '')
                // Inline math
                .replace(/(?<!\\)\\\(((?:\\.|[^\\])*?)\\\)/g, (_, match) => `$${match}$`)
                // Display math
                .replace(/(?<!\\)\\\[((?:\\.|[^\\])*?)\\\]/g, (_, match) => `$$${match}$$`)
            }
        </ReactMarkdown>
    );
};

export default MarkdownRenderer;