import React from 'react';
import { ToolReturnPart } from '../../agents/types';
import { isItemSearchResult } from '../../agents/toolResultTypes';
import { ItemSearchResultView } from './ItemSearchResultView';
import MarkdownRenderer from '../messages/MarkdownRenderer';

interface ToolResultViewProps {
    result: ToolReturnPart;
}

/**
 * Renders the result of a tool call.
 * Dispatches to specialized renderers based on the result type,
 * with a fallback to generic JSON/markdown rendering.
 */
export const ToolResultView: React.FC<ToolResultViewProps> = ({ result }) => {
    const content = result.content;

    // Dispatch to specialized renderers based on result type
    if (isItemSearchResult(content)) {
        return <ItemSearchResultView result={content} />;
    }

    // Fallback: generic rendering for other result types
    return <GenericResultView content={content} />;
};

/**
 * Generic fallback renderer for tool results that don't have a specialized view.
 */
const GenericResultView: React.FC<{ content: unknown }> = ({ content }) => {
    const formatContent = () => {
        if (typeof content === 'string') {
            return content;
        }
        if (content === null || content === undefined) {
            return 'No result';
        }
        try {
            return JSON.stringify(content, null, 2);
        } catch {
            return String(content);
        }
    };

    const formattedContent = formatContent();

    // Check if content looks like markdown
    const looksLikeMarkdown = /[#*`\[\]]/.test(formattedContent);

    return (
        <div className="tool-result-view p-3 text-sm overflow-x-auto">
            {looksLikeMarkdown ? (
                <MarkdownRenderer
                    className="markdown"
                    content={formattedContent}
                    enableNoteBlocks={false}
                />
            ) : (
                <pre className="whitespace-pre-wrap font-mono text-xs opacity-80">
                    {formattedContent}
                </pre>
            )}
        </div>
    );
};

export default ToolResultView;
