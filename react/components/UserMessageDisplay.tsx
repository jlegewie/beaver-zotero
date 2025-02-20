import React from 'react';
import { useAtomValue } from 'jotai';
import { AttachmentButton } from "./AttachmentButton";
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
            
            {/* Message attachments */}
            {message.attachments && (
                <div className="flex flex-wrap gap-3 mb-2">
                    {(message.attachments).map((attachment, index) => (
                        <AttachmentButton
                            key={index}
                            attachment={attachment}
                            disabled={true}
                        />
                    ))}
                </div>
            )}

            {/* Message content */}
            <div className="mb-2 -ml-1">
                {message.content}
            </div>

        </div>
    );
};

export default UserMessageDisplay;