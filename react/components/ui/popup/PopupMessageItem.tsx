import React, { useEffect } from 'react';
import { PopupMessage, POPUP_MESSAGE_DURATION } from '../../../types/popupMessage';
import { Icon, CancelIcon, AlertIcon, InformationCircleIcon, PuzzleIcon } from '../../icons/icons';
import { useSetAtom } from 'jotai';
import { removePopupMessageAtom } from '../../../utils/popupMessageUtils';
import IconButton from '../IconButton';
import PlanChangeMessageContent from './PlanChangeMessageContent';
import IndexingCompleteMessageContent from './IndexingCompleteMessageContent';

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
            }, message.duration || POPUP_MESSAGE_DURATION);
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
            case 'plan_change':
            case 'indexing_complete':
                return <Icon icon={PuzzleIcon} className="scale-12 mt-020 font-color-primary" />;
            case 'info':
            default:
                return <Icon icon={InformationCircleIcon} className="scale-12 mt-020 font-color-blue" />;
        }
    };

    let fontColor, backgroundColor, borderColor;

    switch (message.type) {
        case 'error':
            fontColor = 'font-color-red';
            backgroundColor = 'var(--tag-red-quinary)';
            borderColor = 'var(--tag-red-quarternary)';
            break;
        case 'info':
            fontColor = 'font-color-blue';
            backgroundColor = 'var(--tag-blue-quinary)';
            borderColor = 'var(--tag-blue-quarternary)';
            break;
        case 'warning':
            fontColor = 'font-color-yellow';
            backgroundColor = 'var(--tag-yellow-quinary)';
            borderColor = 'var(--tag-yellow-quarternary)';
            break;
        case 'plan_change':
        case 'indexing_complete':
        default:
            fontColor = 'font-color-primary';
            backgroundColor = 'var(--material-mix-quarternary)';
            borderColor = 'var(--fill-quinary)';
            break;
    }

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
                        {`${message.title} ${message.count ? `(${message.count})` : ''}`}
                    </div>
                    <div className="display-flex flex-row gap-2 flex-shrink-0">
                        {message.buttonIcon && message.buttonOnClick && (
                            <IconButton
                                variant="ghost"
                                icon={message.buttonIcon}
                                onClick={() => {
                                    if(message.buttonOnClick) {
                                        message.buttonOnClick();
                                        handleDismiss();
                                    }
                                }}
                                iconClassName={`${fontColor} scale-11`}
                            />
                        )}
                        <IconButton
                            icon={CancelIcon}
                            onClick={handleDismiss}
                            iconClassName={`scale-11 ${fontColor}`}
                        />
                    </div>
                </div>

                {/* Content for info, warning, error */}
                {['info', 'warning', 'error'].includes(message.type) && (
                    message.customContent ? (
                        <div>
                            {message.customContent}
                        </div>
                    ) : (
                        <div className={`text-base ${fontColor} opacity-60`}>{message.text}</div>
                    )
                )}

                {/* Content for plan_change */}
                {message.type === 'plan_change' && (
                    <PlanChangeMessageContent message={message} />
                )}

                {/* Content for indexing_complete */}
                {message.type === 'indexing_complete' && (
                    <IndexingCompleteMessageContent message={message} />
                )}
            </div>
        </div>
    );
};

export default PopupMessageItem;