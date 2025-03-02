import React from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm'
import Tooltip from './Tooltip';
import { parseZoteroURI } from '../utils/parseZoteroURI';
// import rehypeKatex from 'rehype-katex';
// import 'katex/dist/katex.min.css';

const TOOLTIP_WIDTH = '250px';

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
                if (uri.startsWith('zotero://') || uri.startsWith('file://')) {
                    return uri;
                }
                // Use default sanitization for all other links
                return defaultUrlTransform(uri);
            }}
            components={{
                // Add a tooltip to zotero links and handle clicks
                a: ({ node, children, ...props }: any) => {
                    const handleClick = async (e: React.MouseEvent) => {
                        if (props.href.startsWith('zotero://open-note')) {
                            e.preventDefault();
                            // Parse the zotero URI
                            const { libraryID, itemKey } = parseZoteroURI(props.href);
                            if (!libraryID || !itemKey) return;
                            // Get item item id
                            const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
                            if (!item) return;
                            // Open the note window
                            await Zotero.getActiveZoteroPane().openNoteWindow(item.id);
                        } else if (props.href.startsWith('file:///')) {
                            e.preventDefault();
                            const filePath = props.href.replace('file:///', '');
                            Zotero.launchFile(filePath);
                        }
                        // Default behavior for zotero://open-pdf
                    };

                    if (props.href.startsWith('zotero://')) {
                        const tooltip = props.title || '';
                        return (
                            <Tooltip content={tooltip} width={TOOLTIP_WIDTH} allowHtml={true}>
                                <a href={props.href} onClick={handleClick}>{children}</a>
                            </Tooltip>
                        );
                    }
                    return <a {...props}>{children}</a>;
                },
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