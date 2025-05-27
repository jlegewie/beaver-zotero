import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import ZoteroCitation from './sources/ZoteroCitation';
import rehypeKatex from 'rehype-katex';
import deepmerge from 'deepmerge';

// Create a custom schema that extends GitHub's defaults but allows citation tags
const customSchema = deepmerge(defaultSchema, {
    tagNames: [...(defaultSchema.tagNames || []), 'citation'],
    attributes: {
        ...defaultSchema.attributes,
        citation: ['id', 'pages', 'consecutive']
    }
});

type MarkdownRendererProps = {
    content: string;
    className?: string;
    exportRendering?: boolean;
};

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
    content, 
    className = 'markdown', 
    exportRendering = false
}) => {

    // Preprocess citation tags:
    // - transform self-closing citation tags into proper open/close tags
    // - tracks repeated citations with the same ID to add the `consecutive` attribute
    let lastCitationId = "";
    
    // Process partial tags at the end of content
    const processPartialContent = (content: string): string => {
        let processed = content;
        
        // Complete unclosed code blocks
        // const codeBlockRegex = /```(?:\w+)?\s+[^`]*$/;
        // const codeBlockMatch = processed.match(codeBlockRegex);
        // if (codeBlockMatch && codeBlockMatch.index !== undefined && 
        //     codeBlockMatch.index + codeBlockMatch[0].length === processed.length) {
        //     // Add closing ``` for proper formatting during streaming
        //     return processed + "\n```";
        // }
        
        // Filter out other partial tags
        const partialTagPatterns = [
            /<citation[^>]*$/,                // Partial citation tag
            /<[a-z][a-z0-9]*(?:\s+[^>]*)?$/i, // Any partial HTML tag
            /\$\$[^$]*$/                      // Unclosed math equation
        ];
        
        // Check if content ends with any of our partial tag patterns
        for (const pattern of partialTagPatterns) {
            const match = processed.match(pattern);
            if (match && match.index !== undefined && match.index + match[0].length === processed.length) {
                // Remove the partial tag if it's at the end of the content
                processed = processed.substring(0, match.index);
                break; // Only apply one filter
            }
        }
        
        return processed;
    };
    
    const processedContent = processPartialContent(content);
    
    const preprocessedContent = processedContent
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
            rehypePlugins={[rehypeRaw, [rehypeSanitize, customSchema], rehypeKatex]}
            // rehypePlugins={[rehypeKatex]}
            components={{
                // @ts-expect-error - Custom component not in ReactMarkdown types
                citation: ({node, ...props}: any) => {
                    return <ZoteroCitation {...props} exportRendering={exportRendering} />;
                }
            }}
        >
            {preprocessedContent}
        </ReactMarkdown>
    );
};

export default MarkdownRenderer;