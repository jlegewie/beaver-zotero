import React from 'react';
import { ChatMessage } from '../types/messages';
import MarkdownRenderer from './MarkdownRenderer';
import { Spinner } from './icons';

interface AssistantMessageDisplayProps {
    message: ChatMessage;
}

const AssistantMessageDisplay: React.FC<AssistantMessageDisplayProps> = ({
    message
}) => {

    return (
        <div className="assistant-message-display">
            <MarkdownRenderer className="markdown" content={message.content} />
            {message.status === 'in_progress' && message.content == '' && 
                <Spinner />
            }
        </div>
    );
};

export default AssistantMessageDisplay;