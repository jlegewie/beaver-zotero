import React from 'react';
import { CancelIcon } from '../../icons/icons';
import IconButton from '../IconButton';

interface PopupMessageHeaderProps {
    icon: React.ReactNode;
    title?: string;
    handleDismiss: () => void;
    fontColor: string;
    count?: number;
    buttonIcon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    buttonOnClick?: () => void;
}

const PopupMessageHeader: React.FC<PopupMessageHeaderProps> = ({ icon, title, count, buttonIcon, buttonOnClick, fontColor, handleDismiss }) => {

    return (
        <div className="display-flex flex-row items-start w-full gap-3">
            <div className="flex-shrink-0">
                {icon}
            </div>
            <div className={`flex-1 text-base font-medium ${fontColor}`}>
                {`${title} ${count ? `(${count})` : ''}`}
            </div>
            <div className="display-flex flex-row gap-2 flex-shrink-0">
                {buttonIcon && buttonOnClick && (
                    <IconButton
                        variant="ghost"
                        icon={buttonIcon}
                        onClick={() => {
                            if(buttonOnClick) {
                                buttonOnClick();
                                handleDismiss();
                            }
                        }}
                        iconClassName="font-color-secondary scale-11"
                    />
                )}
                <IconButton
                    icon={CancelIcon}
                    variant="ghost-secondary"
                    onClick={handleDismiss}
                    // iconClassName={`${fontColor}`}
                />
            </div>
        </div>
    )
};

export default PopupMessageHeader;