import React, { useEffect } from 'react';
import { PopupMessage, POPUP_MESSAGE_DURATION } from '../../../types/popupMessage';
import { Icon, AlertIcon, InformationCircleIcon, PuzzleIcon, SettingsIcon, AiMagicIcon } from '../../icons/icons';
import { useAtomValue, useSetAtom } from 'jotai';
import { removePopupMessageAtom, updatePopupMessageAtom } from '../../../utils/popupMessageUtils';
import PlanChangeMessageContent from './PlanChangeMessageContent';
import IndexingCompleteMessageContent from './IndexingCompleteMessageContent';
import VersionUpdateMessageContent from './VersionUpdateMessageContent';
import { newThreadAtom, currentThreadIdAtom } from '../../../atoms/threads';
import { isPreferencePageVisibleAtom, showFileStatusDetailsAtom } from '../../../atoms/ui';
import Button from "../Button";
import PopupMessageHeader from './PopupMessageHeader';

interface PopupMessageItemProps {
    message: PopupMessage;
}

const PopupMessageItem: React.FC<PopupMessageItemProps> = ({ message }) => {
    const removeMessage = useSetAtom(removePopupMessageAtom);
    const newThread = useSetAtom(newThreadAtom);
    const setShowFileStatusDetails = useSetAtom(showFileStatusDetailsAtom);
    const setIsPreferencePageVisible = useSetAtom(isPreferencePageVisibleAtom);
    const currentThreadId = useAtomValue(currentThreadIdAtom);
    const updatePopupMessage = useSetAtom(updatePopupMessageAtom);

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

    const showFileStatusDetails = async () => {
        if (currentThreadId !== null) {
            await newThread();
        }
        setShowFileStatusDetails(true);
        updatePopupMessage({
            messageId: message.id,
            updates: {
                expire: true,
                duration: 100
            }
        });
    };

    const showSettings = () => {
        setIsPreferencePageVisible(true);
        handleDismiss();
    };

    const getDefaultIcon = () => {
        switch (message.type) {
            case 'warning':
                return <Icon icon={AlertIcon} className="scale-12 mt-020 font-color-secondary" />;
            case 'error':
                return <Icon icon={AlertIcon} className="scale-12 mt-020 font-color-red" />;
            case 'plan_change':
            case 'indexing_complete':
                return <Icon icon={PuzzleIcon} className="scale-12 mt-020 font-color-secondary" />;
            case 'version_update':
                return <Icon icon={AiMagicIcon} className="scale-12 mt-020 font-color-secondary" />;
            case 'info':
            default:
                return <Icon icon={InformationCircleIcon} className="scale-12 mt-020 font-color-secondary" />;
        }
    };

    let fontColor, backgroundColor, borderColor;

    switch (message.type) {
        case 'error':
            fontColor = 'font-color-red';
            backgroundColor = 'var(--material-mix-quarternary)';
            borderColor = 'var(--fill-quinary)';
            break;
        case 'info':
        case 'warning':
        case 'plan_change':
        case 'indexing_complete':
        case 'version_update':
        default:
            fontColor = 'font-color-secondary';
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
                <PopupMessageHeader
                    icon={message.icon || getDefaultIcon()}
                    title={message.title || ''}
                    count={message.count}
                    buttonIcon={message.buttonIcon}
                    buttonOnClick={message.buttonOnClick}
                    fontColor={fontColor || 'font-color-secondary'}
                    handleDismiss={handleDismiss}
                />

                {/* Content for info, warning, error */}
                {['info', 'warning', 'error'].includes(message.type) && (
                    message.customContent ? (
                        <div className="w-full">
                            {message.customContent}
                        </div>
                    ) : (
                        <div className='text-base font-color-tertiary'>
                            {message.text}
                        </div>
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

                {message.type === 'version_update' && (
                    <VersionUpdateMessageContent message={message} />
                )}

                {message.showGoToFileStatusButton && (
                    <div className="display-flex flex-row gap-2 items-end w-full justify-end py-1">
                        <Button onClick={showFileStatusDetails} variant="outline">View File Status</Button>
                    </div>
                )}

                {message.showSettingsButton && !message.showGoToFileStatusButton && (
                    <div className="display-flex flex-row gap-2 items-end w-full justify-end py-1">
                        <Button onClick={showSettings} icon={SettingsIcon} variant="outline">Settings</Button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default PopupMessageItem;
