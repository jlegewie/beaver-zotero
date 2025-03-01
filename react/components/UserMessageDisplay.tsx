import React from 'react';
import { useAtomValue } from 'jotai';
import { SourceButton } from "./SourceButton";
import { ChatMessage } from '../types/messages';
import { isStreamingAtom } from '../atoms/messages';
import { threadSourcesAtom } from '../atoms/resources';

interface UserMessageDisplayProps {
    message: ChatMessage;
}

const UserMessageDisplay: React.FC<UserMessageDisplayProps> = ({
    message
}) => {
    const isStreaming = useAtomValue(isStreamingAtom);
    const threadSources = useAtomValue(threadSourcesAtom);
    const messageSources = threadSources.filter(r => r.messageId === message.id);

    return (
        <div className="user-message-display">
            
            {/* Message sources */}
            {messageSources.length > 0 && (
                <div className="flex flex-wrap gap-3 mb-2">
                    {messageSources.map((source, index) => (
                        <SourceButton
                            key={index}
                            source={source}
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