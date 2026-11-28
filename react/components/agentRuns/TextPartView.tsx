import React from 'react';
import { TextPart } from '@beaver/agent-core/agents/types';
import MarkdownRenderer from '../messages/MarkdownRenderer';
import { stripCitationMarkerChars } from '../../utils/citationPreprocessing';

interface TextPartViewProps {
    part: TextPart;
}

/**
 * Renders a text part with markdown support.
 * Since WSPartEvent sends accumulated content (not deltas),
 * we simply render the current content state.
 */
export const TextPartView: React.FC<TextPartViewProps> = React.memo(function TextPartView({ part }) {
    const stripped = stripCitationMarkerChars(part.content ?? '');
    const content = stripped.trim();
    if (content === '' || stripped === '_') {
        return null;
    }

    return (
        <MarkdownRenderer
            className="markdown chat-prose"
            content={content}
        />
    );
});

export default TextPartView;
