import React from 'react';
import { TextPart } from '../../agents/types';
import MarkdownRenderer from '../messages/MarkdownRenderer';

interface TextPartViewProps {
    part: TextPart;
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
        />
    );
};

export default TextPartView;

