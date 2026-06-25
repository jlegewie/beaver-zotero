import React from 'react';
import PopupMessageContainer from './ui/popup/PopupMessageContainer';

const PopupOverlayContainer: React.FC = () => {
    return (
        <div className="absolute -top-4 inset-x-0 -translate-y-full px-3 flex flex-col pointer-events-none items-stretch">
            <PopupMessageContainer className="pointer-events-auto" />
        </div>
    );
};

export default PopupOverlayContainer;
