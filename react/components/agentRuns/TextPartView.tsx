import React from 'react';
import { TextPart } from '../../agents/types';
import MarkdownRenderer from '../messages/MarkdownRenderer';

interface TextPartViewProps {
    part: TextPart;
    // TODO: Add runId prop once proposed actions are migrated from messageId to runId
    // This will be needed for citation linking and note saving
}

/**
 * Renders a text part with markdown support.
 * Since WSPartEvent sends accumulated content (not deltas),
 * we simply render the current content state.
 */
export const TextPartView: React.FC<TextPartViewProps> = ({ part }) => {
    if (!part.content || part.content.trim() === '') {
        return null;
    }

    return (
        <MarkdownRenderer 
            className="markdown" 
            content={part.content}
            // TODO: Pass runId once proposed actions migration is complete
        />
    );
};

export default TextPartView;

