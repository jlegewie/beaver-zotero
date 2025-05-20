import React from 'react';
import { useAtomValue } from 'jotai';
import { popupMessagesAtom } from '../atoms/ui';
import PopupMessageItem from './PopupMessageItem';

const MAX_MESSAGES = 3;

const PopupMessageContainer: React.FC = () => {
    const messages = useAtomValue(popupMessagesAtom);

    if (!messages.length) {
        return null;
    }

    return (
        // Positioned like PreviewContainer, messages stack from bottom up
        // Each PopupMessageItem has mb-2, so they will space out naturally
        <div className="absolute -top-4 inset-x-0 -translate-y-full px-3 flex flex-col-reverse">
            {messages.slice(0, MAX_MESSAGES).map((message) => (
                <PopupMessageItem key={message.id} message={message} />
            ))}
        </div>
    );
};

export default PopupMessageContainer;