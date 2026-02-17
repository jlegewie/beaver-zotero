import React, { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { floatingPopupMessagesAtom, removeFloatingPopupMessageAtom } from '../../../atoms/floatingPopup';
import PopupMessageItem from './PopupMessageItem';

const MAX_MESSAGES = 3;

const FloatingPopupContainer: React.FC = () => {
    const messages = useAtomValue(floatingPopupMessagesAtom);
    const removeMessage = useSetAtom(removeFloatingPopupMessageAtom);

    const handleRemove = useCallback((messageId: string) => {
        removeMessage(messageId);
    }, [removeMessage]);

    if (!messages.length) {
        return null;
    }

    return (
        <div className="flex flex-col-reverse gap-3 p-4">
            {messages.slice(0, MAX_MESSAGES).map((message) => (
                <PopupMessageItem
                    key={message.id}
                    message={message}
                    onRemove={handleRemove}
                    isFloating={true}
                />
            ))}
        </div>
    );
};

export default FloatingPopupContainer;
