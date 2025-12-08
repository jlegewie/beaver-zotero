import React from 'react';
import { ToolReturnPart } from '../../agents/types';
import MarkdownRenderer from '../messages/MarkdownRenderer';

interface ToolResultViewProps {
    result: ToolReturnPart;
}

/**
 * Renders the result of a tool call.
 * Handles different content types (string, object, etc.)
 */
export const ToolResultView: React.FC<ToolResultViewProps> = ({ result }) => {
    // Format the content for display
    const formatContent = () => {
        if (typeof result.content === 'string') {
            return result.content;
        }
        if (result.content === null || result.content === undefined) {
            return 'No result';
        }
        // For objects, pretty-print as JSON
        try {
            return JSON.stringify(result.content, null, 2);
        } catch {
            return String(result.content);
        }
    };

    const content = formatContent();

    // Check if content looks like markdown or is plain text
    const looksLikeMarkdown = /[#*`\[\]]/.test(content);

    return (
        <div className="tool-result-view p-3 text-sm overflow-x-auto">
            {looksLikeMarkdown ? (
                <MarkdownRenderer 
                    className="markdown" 
                    content={content}
                    enableNoteBlocks={false}
                />
            ) : (
                <pre className="whitespace-pre-wrap font-mono text-xs opacity-80">
                    {content}
                </pre>
            )}
        </div>
    );
};

export default ToolResultView;

