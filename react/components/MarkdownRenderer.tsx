import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw';
import ZoteroCitation from './ZoteroCitation';
// import rehypeKatex from 'rehype-katex';
// import 'katex/dist/katex.min.css';

type MarkdownRendererProps = {
    className: string;
    content: string;
};

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, className }) => {

    // Preprocess citation tags:
    // - transform self-closing citation tags into proper open/close tags
    // - tracks repeated citations with the same ID to add the `consecutive` attribute
    let lastCitationId = "";
    const preprocessedContent = content
        .replace(
            /<citation\s+((?:[^>])+?)\s*\/>/g,
            (match, attributesStr) => {
                // Extract the ID from attributes
                const idMatch = attributesStr.match(/id="([^"]+)"/);
                const id = idMatch ? idMatch[1] : "";
                
                // Check if this citation has the same ID as the previous one
                const isConsecutive = id && id === lastCitationId;
                
                // Update the last citation ID
                lastCitationId = id;
                
                // Add the consecutive attribute if needed
                if (isConsecutive) {
                    return `<citation ${attributesStr} consecutive="true"></citation>`;
                }
                
                return `<citation ${attributesStr}></citation>`;
            }
        )
        // Fix common formatting issues
        .replace(/```plaintext\s*([\s\S]*?)\s*```/, '$1')
        .replace(/\$\$([^$]+)\$\$/g, (_, equation) => `\n$$\n${equation.trim()}\n$$\n`)
        // Inline and display math
        .replace(/(?<!\\)\\\(((?:\\.|[^\\])*?)\\\)/g, (_, match) => `$${match}$`)
        .replace(/(?<!\\)\\\[((?:\\.|[^\\])*?)\\\]/g, (_, match) => `$$${match}$$`);

    return (
        <ReactMarkdown
            // "markdown-body"
            className={className}
            remarkPlugins={[remarkMath,remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            // rehypePlugins={[rehypeKatex]}
            components={{
                citation: ({node, ...props}: any) => {
                    return <ZoteroCitation {...props} />;
                }
            }}
        >
            {preprocessedContent}
        </ReactMarkdown>
    );
};

export default MarkdownRenderer;