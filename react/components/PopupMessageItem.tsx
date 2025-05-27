import React, { useEffect } from 'react';
import { PopupMessage, POPUP_MESSAGE_DURATION } from '../types/popupMessage';
import { Icon, CancelIcon, AlertIcon, InformationCircleIcon } from './icons';
import { useSetAtom } from 'jotai';
import { removePopupMessageAtom } from '../utils/popupMessageUtils';
import IconButton from './ui/IconButton';

interface PopupMessageItemProps {
    message: PopupMessage;
}

const PopupMessageItem: React.FC<PopupMessageItemProps> = ({ message }) => {
    const removeMessage = useSetAtom(removePopupMessageAtom);

    useEffect(() => {
        let timerId: number | null = null;
        if (message.expire !== false) { // Default to true if undefined
            timerId = Zotero.getMainWindow().setTimeout(() => {
                removeMessage(message.id);
            }, POPUP_MESSAGE_DURATION);
        }

        return () => {
            if (timerId) {
                Zotero.getMainWindow().clearTimeout(timerId);
            }
        };
    }, [message, removeMessage]);

    const handleDismiss = () => {
        removeMessage(message.id);
    };

    const getDefaultIcon = () => {
        switch (message.type) {
            case 'warning':
                return <Icon icon={AlertIcon} className="scale-12 mt-020 font-color-yellow" />;
            case 'error':
                return <Icon icon={AlertIcon} className="scale-12 mt-020 font-color-red" />;
            case 'info':
            default:
                return <Icon icon={InformationCircleIcon} className="scale-12 mt-020 font-color-blue" />;
        }
    };

    const fontColor = message.type === 'error'
        ? 'font-color-red'
        : message.type === 'info'
            ? 'font-color-blue'
            : 'font-color-yellow';
    const backgroundColor = message.type === 'error'
        ? 'var(--tag-red-quinary)'
        : message.type === 'info'
            ? 'var(--tag-blue-quinary)'
            : 'var(--tag-yellow-quinary)';
    const borderColor = message.type === 'error'
        ? 'var(--tag-red-quarternary)'
        : message.type === 'info'
            ? 'var(--tag-blue-quarternary)'
            : 'var(--tag-yellow-quarternary)';

    return (
        <div
            className="source-preview border-popup shadow-md mx-0 mb-2"
            style={{
                background: backgroundColor,
                backdropFilter: 'blur(6px)',
                border: `1px solid ${borderColor}`,
            }}
        >
            <div className="p-3 display-flex flex-col items-start gap-2">
                {/* Icon, Title and close button */}
                <div className="display-flex flex-row items-start w-full gap-3">
                    <div className="flex-shrink-0">
                        {message.icon || getDefaultIcon()}
                    </div>
                    <div className={`flex-1 text-base font-medium ${fontColor}`}>
                        {message.title}
                    </div>
                    <div className="flex-shrink-0">
                        <IconButton
                            icon={CancelIcon}
                            onClick={handleDismiss}
                            iconClassName={`${fontColor}`}
                        />
                    </div>
                </div>

                {/* Content */}
                {message.customContent ? (
                    <div>
                        {message.customContent}
                    </div>
                ) : (
                    <div className={`text-base ${fontColor} opacity-60`}>{message.text}</div>
                )}
            </div>
        </div>
    );
};

export default PopupMessageItem;