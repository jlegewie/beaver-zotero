import React from 'react';
import { useAtomValue } from 'jotai';
import { ResourceButton } from "./ResourceButton";
import { ChatMessage } from '../types/messages';
import { isStreamingAtom } from '../atoms/messages';

interface UserMessageDisplayProps {
    message: ChatMessage;
}

const UserMessageDisplay: React.FC<UserMessageDisplayProps> = ({
    message
}) => {
    const isStreaming = useAtomValue(isStreamingAtom);

    return (
        <div className="user-message-display">
            
            {/* Message resources */}
            {message.resources && (
                <div className="flex flex-wrap gap-3 mb-2">
                    {(message.resources).map((resource, index) => (
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