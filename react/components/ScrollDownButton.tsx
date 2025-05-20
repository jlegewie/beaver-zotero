import React from 'react';
import { Icon, ArrowDownIcon } from './icons';
import { activePreviewAtom } from '../atoms/ui';
import { useAtomValue } from 'jotai';
import { popupMessagesAtom } from '../atoms/ui';

interface ScrollDownButtonProps extends React.HTMLProps<HTMLButtonElement> {
    onClick: () => void;
    userScrolled: boolean;
}

export const ScrollDownButton: React.FC<ScrollDownButtonProps> = ({
    onClick,
    className,
    style,
    userScrolled
}) => {
    const activePreview = useAtomValue(activePreviewAtom);
    const popupMessages = useAtomValue(popupMessagesAtom);

    return (
        <div className="relative w-full h-0">
            <div className={`
                transition-opacity duration-300
                ${userScrolled && !activePreview && popupMessages.length === 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}
            `}>
                <div className="absolute top-0 left-1/2 -translate-x-1/2 z-10">
                    <button
                        onClick={onClick}
                        className={`scroll-down-button ${className || ''}`}
                        style={style}
                    >
                        <Icon icon={ArrowDownIcon} />
                    </button>
                </div>
            </div>
        </div>
    );
};
