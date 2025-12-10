import React from 'react';
import { TextPart } from '../../agents/types';
import MarkdownRenderer from '../messages/MarkdownRenderer';

interface TextPartViewProps {
    part: TextPart;
    /** Agent run ID for linking citations and saving notes */
    runId?: string;
}

/**
 * Renders a text part with markdown support.
 * Since WSPartEvent sends accumulated content (not deltas),
 * we simply render the current content state.
 */
export const TextPartView: React.FC<TextPartViewProps> = ({ part, runId }) => {
    if (!part.content || part.content.trim() === '') {
        return null;
    }

    return (
        <MarkdownRenderer 
            className="markdown mt-3"
            content={part.content}
            runId={runId}
        />
    );
};

export default TextPartView;

