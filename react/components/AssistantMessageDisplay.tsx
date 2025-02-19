import React from 'react';
import { ChatMessage } from '../types/messages';

interface AssistantMessageDisplayProps {
    message: ChatMessage;
}

const AssistantMessageDisplay: React.FC<AssistantMessageDisplayProps> = ({
    message
}) => {

    return (
        <div className="assistant-message-display">
            {message.content}
        </div>
    );
};

export default AssistantMessageDisplay;