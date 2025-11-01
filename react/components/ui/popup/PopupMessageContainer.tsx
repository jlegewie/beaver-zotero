import React from 'react';
import { useAtomValue } from 'jotai';
import { popupMessagesAtom } from '../../../atoms/ui';
import PopupMessageItem from './PopupMessageItem';

interface PopupMessageContainerProps {
    className?: string;
}

const MAX_MESSAGES = 3;

const PopupMessageContainer: React.FC<PopupMessageContainerProps> = ({ className }) => {
    const messages = useAtomValue(popupMessagesAtom);

    if (!messages.length) {
        return null;
    }

    const containerClassName = ['flex flex-col-reverse gap-2', className]
        .filter(Boolean)
        .join(' ');

    return (
        // Messages stack from bottom up so the latest appears closest to the input
        <div className={containerClassName}>
            {messages.slice(0, MAX_MESSAGES).map((message) => (
                <PopupMessageItem key={message.id} message={message} />
            ))}
        </div>
    );
};

export default PopupMessageContainer;
