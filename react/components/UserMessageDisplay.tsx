import React from 'react';
import { useAtomValue } from 'jotai';
import { ResourceButton } from "./ResourceButton";
import { ChatMessage } from '../types/messages';
import { isStreamingAtom } from '../atoms/messages';
import { threadResourcesAtom } from '../atoms/resources';

interface UserMessageDisplayProps {
    message: ChatMessage;
}

const UserMessageDisplay: React.FC<UserMessageDisplayProps> = ({
    message
}) => {
    const isStreaming = useAtomValue(isStreamingAtom);
    const threadResources = useAtomValue(threadResourcesAtom);
    const messageResources = threadResources.filter(r => r.messageId === message.id);

    return (
        <div className="user-message-display">
            
            {/* Message resources */}
            {messageResources.length > 0 && (
                <div className="flex flex-wrap gap-3 mb-2">
                    {messageResources.map((resource, index) => (
                        <ResourceButton
                            key={index}
                            resource={resource}
                            disabled={true}
                        />
                    ))}
                </div>
            )}

            {/* Message content */}
            <div className="-ml-1">
                {message.content}
            </div>

        </div>
    );
};

export default UserMessageDisplay;